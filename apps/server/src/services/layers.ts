import {
  type Asset,
  errorCopy,
  type GenerateRequest,
  type LayerBox,
  type LayerOpParams,
  type LayerStackResponse,
  type LayersBody,
  LOCAL_PROVIDER_ID,
  layerOpParamsSchema,
  type StackEntry,
  THUMB_RUNGS,
  t,
} from "@openfield/core";
import {
  type AssetRow,
  assetsForJobSets,
  type Db,
  getAsset,
  insertAsset,
  insertAssetEdges,
} from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import { absolutePath, type HomePaths } from "../config/home";
import type { Ingest } from "../files/ingest";
import { type PsdLayer, writePsd } from "../files/psd";
import { loadSharp, type Sharp } from "../files/sharp";
import { Thumbs } from "../files/thumbs";
import { planZip, zipStream } from "../files/zip";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import { toAsset } from "../mappers/asset";
import type { SettingsService } from "./settings";

// Layer stacks: the base and layers one separation made, read back as a stack, put together into
// one picture (flatten), or handed out as files (a zip of PNGs, or a PSD with a layer each). A run's
// id names its stack. Entries may swap a layer for an image edited from it, which then sits in
// that layer's box.

export interface LayerServiceDeps {
  db: Db;
  paths: HomePaths;
  ingest: Ingest;
  thumbs: Thumbs;
  settings: SettingsService;
  logger: Logger;
}

interface Stacked {
  row: AssetRow;
  layer: LayerOpParams;
}

export interface Stack {
  runId: string;
  canvas: { width: number; height: number };
  /** The base first, then each layer from the bottom up. */
  items: Stacked[];
  source: AssetRow | undefined;
}

/** One image to draw, where to draw it, and what to call it. */
interface Placed {
  row: AssetRow;
  box: LayerBox;
  name: string;
  zIndex: number;
}

/** How far up an edited image's parents to look for the layer it came from. */
const ANCESTRY_LIMIT = 32;

export class LayerService {
  constructor(private readonly deps: LayerServiceDeps) {}

  /** The stack a separation made, or a 404 when the run made none. */
  stack(runId: string): Stack {
    const { db } = this.deps;
    const items: Stacked[] = [];
    for (const row of assetsForJobSets(db, [runId])) {
      const parsed = layerOpParamsSchema.safeParse(row.opParams?.layer);
      if (parsed.success && !row.deletedAt) items.push({ row, layer: parsed.data });
    }
    const base = items.find((i) => i.layer.role === "base");
    if (!base) {
      throw new ApiFailure(404, "not_found", "That run made no layers", {
        field: "runId",
        userMessage: t("errors.layerStackGone"),
      });
    }
    items.sort((a, b) =>
      a.layer.role === "base" ? -1 : b.layer.role === "base" ? 1 : a.layer.zIndex - b.layer.zIndex,
    );
    const source = base.row.parentAssetId ? getAsset(db, base.row.parentAssetId) : undefined;
    return { runId, canvas: base.layer.canvas, items, source };
  }

  response(stack: Stack): LayerStackResponse {
    const { canvas } = stack;
    return {
      runId: stack.runId,
      source: stack.source ? toAsset(stack.source, false, false) : null,
      canvas,
      layers: stack.items.map(({ row, layer }) => ({
        asset: toAsset(row, false, false),
        role: layer.role,
        zIndex: layer.zIndex,
        box: layer.box ?? [0, 0, canvas.width, canvas.height],
        name: layer.name ?? null,
        description: layer.description ?? null,
      })),
    };
  }

  /** The stack as it was made, or the entries asked for, bottom first, with their boxes. */
  placed(stack: Stack, entries: readonly StackEntry[] | undefined): Placed[] {
    const full: LayerBox = [0, 0, stack.canvas.width, stack.canvas.height];
    const byId = new Map(stack.items.map((i) => [i.row.id, i]));
    const nameOf = (item: Stacked) =>
      item.layer.role === "base"
        ? t("layers.base")
        : (item.layer.name ?? t("layers.layer", { n: item.layer.zIndex }));
    if (!entries) {
      return stack.items.map((item) => ({
        row: item.row,
        box: item.layer.box ?? full,
        name: nameOf(item),
        zIndex: item.layer.zIndex,
      }));
    }
    const out: Placed[] = [];
    for (const [i, entry] of entries.entries()) {
      if (entry.visible === false) continue;
      const row = getAsset(this.deps.db, entry.assetId);
      if (row?.modality !== "image" || row.kind === "mask") {
        throw new ApiFailure(400, "bad_request", `No image ${entry.assetId}`, {
          field: `layers.${i}.assetId`,
          userMessage: t("masks.imageGone"),
        });
      }
      const from = this.#layerOf(row, byId);
      const box = entry.box ?? (from ? (from.layer.box ?? full) : undefined);
      if (!box) {
        throw new ApiFailure(400, "bad_request", `${entry.assetId} isn't from this stack and has no box`, {
          field: `layers.${i}.box`,
          userMessage: t("errors.layerNotInStack"),
        });
      }
      out.push({ row, box, name: from ? nameOf(from) : t("layers.layer", { n: i }), zIndex: i });
    }
    if (!out.length) {
      throw new ApiFailure(400, "bad_request", "Every layer is hidden", {
        field: "layers",
        userMessage: t("errors.layersAllHidden"),
      });
    }
    return out;
  }

  /** The stack put together as one PNG, saved to the library beside the base. */
  async flatten(stack: Stack, entries: readonly StackEntry[] | undefined): Promise<Asset> {
    const { db, ingest, thumbs, settings } = this.deps;
    const placed = this.placed(stack, entries);
    const sharp = await this.#sharp();
    const png = await this.#compose(sharp, stack, placed).then((img) => img.png().toBuffer());
    let staged: Awaited<ReturnType<Ingest["stage"]>>;
    try {
      staged = await ingest.stage(new Blob([new Uint8Array(png)]).stream(), { folder: "assets" });
    } catch (err) {
      if (isProviderError(err) && err.code === "disk_full") {
        throw new ApiFailure(507, "disk_full", err.message, { userMessage: errorCopy("disk_full").reason });
      }
      throw err;
    }
    const base = stack.items[0]!.row;
    const row = db.transaction((tx) => {
      const made = insertAsset(tx, {
        id: staged.assetId,
        kind: "edited",
        path: staged.path,
        mime: staged.mime,
        width: staged.width,
        height: staged.height,
        bytes: staged.bytes,
        sha256: staged.sha256,
        providerId: LOCAL_PROVIDER_ID,
        prompt: base.prompt,
        costUsd: 0,
        parentAssetId: base.id,
        rootAssetId: base.rootAssetId,
        op: "overlay",
        opParams: {
          layers: { runId: stack.runId, entries: placed.map((p) => ({ assetId: p.row.id, box: p.box })) },
        },
        generative: false,
      });
      insertAssetEdges(tx, [
        { parentAssetId: base.id, childAssetId: made.id, relation: "derived" },
        ...placed.map((p, ordinal) => ({
          parentAssetId: p.row.id,
          childAssetId: made.id,
          relation: "reference" as const,
          ordinal,
        })),
      ]);
      return made;
    });
    const rung = THUMB_RUNGS[settings.get().feedZoom] ?? 456;
    thumbs.warm(row, Thumbs.sizeFor({ h: rung }));
    return toAsset(getAsset(db, row.id) ?? row, false, false);
  }

  /** The stack as files: a zip of PNGs with a stack.json, or a PSD. */
  async export(
    stack: Stack,
    entries: readonly StackEntry[] | undefined,
    format: "zip" | "psd",
  ): Promise<{ name: string; mime: string; length: number; stream: ReadableStream<Uint8Array> }> {
    const placed = this.placed(stack, entries);
    const sharp = await this.#sharp();
    const stem = `openfield-layers-${stack.runId.slice(-6).toLowerCase()}`;
    if (format === "psd") {
      const layers: PsdLayer[] = [];
      for (const p of placed) {
        const [left, top, right, bottom] = clampBox(p.box, stack.canvas);
        const width = right - left;
        const height = bottom - top;
        const rgba = await this.#rgba(sharp, p.row, width, height);
        layers.push({ name: p.name, left, top, width, height, rgba });
      }
      const composite = await this.#compose(sharp, stack, placed).then((img) =>
        img.ensureAlpha().raw().toBuffer(),
      );
      const bytes = writePsd({ ...stack.canvas, layers, composite: new Uint8Array(composite) });
      return {
        name: `${stem}.psd`,
        mime: "image/vnd.adobe.photoshop",
        length: bytes.byteLength,
        stream: once(bytes),
      };
    }

    const files: { name: string; bytes: Uint8Array }[] = [];
    const names = new Set<string>();
    const manifest = { canvas: stack.canvas, layers: [] as Record<string, unknown>[] };
    for (const [i, p] of placed.entries()) {
      const name = uniqueName(`${String(i).padStart(2, "0")} ${safeName(p.name)}.png`, names);
      const png = await sharp(await this.#read(p.row))
        .rotate()
        .png()
        .toBuffer();
      files.push({ name, bytes: new Uint8Array(png) });
      manifest.layers.push({ file: name, name: p.name, box: p.box, zIndex: i, assetId: p.row.id });
    }
    const flat = await this.#compose(sharp, stack, placed).then((img) => img.png().toBuffer());
    files.push({ name: "flattened.png", bytes: new Uint8Array(flat) });
    files.push({
      name: "stack.json",
      bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    });
    const now = new Date();
    const plan = planZip(files.map((f) => ({ name: f.name, size: f.bytes.byteLength, modifiedAt: now })));
    const stream = zipStream(
      plan,
      async (index) => files[index]!.bytes,
      (error) => this.deps.logger.warn("A layer export stopped part way", { error }),
    );
    return { name: `${stem}.zip`, mime: "application/zip", length: plan.length, stream };
  }

  /** The image a layer was edited into finds its way back to that layer. */
  #layerOf(row: AssetRow, byId: Map<string, Stacked>): Stacked | undefined {
    let at: AssetRow | undefined = row;
    for (let depth = 0; at && depth < ANCESTRY_LIMIT; depth++) {
      const hit = byId.get(at.id);
      if (hit) return hit;
      at = at.parentAssetId ? getAsset(this.deps.db, at.parentAssetId, { includeDeleted: true }) : undefined;
    }
    return undefined;
  }

  /** Every entry drawn into its box, on a transparent canvas the base's size. */
  async #compose(sharp: Sharp, stack: Stack, placed: readonly Placed[]) {
    const layers = [];
    for (const p of placed) {
      const [left, top, right, bottom] = clampBox(p.box, stack.canvas);
      if (right <= left || bottom <= top) continue;
      const input = await sharp(await this.#read(p.row))
        .rotate()
        .resize(right - left, bottom - top, { fit: "fill" })
        .png()
        .toBuffer();
      layers.push({ input, left, top });
    }
    return sharp({
      create: { ...stack.canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite(layers);
  }

  /** One entry as raw RGBA at its box's size. */
  async #rgba(sharp: Sharp, row: AssetRow, width: number, height: number): Promise<Uint8Array> {
    if (width < 1 || height < 1) return new Uint8Array(0);
    const raw = await sharp(await this.#read(row))
      .rotate()
      .resize(width, height, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    return new Uint8Array(raw);
  }

  async #read(row: AssetRow): Promise<Uint8Array> {
    const file = Bun.file(absolutePath(this.deps.paths, row.path));
    if (!(await file.exists())) {
      throw new ApiFailure(404, "not_found", `The file for ${row.id} is missing`, {
        userMessage: t("masks.imageGone"),
      });
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  async #sharp(): Promise<Sharp> {
    try {
      return await loadSharp();
    } catch {
      throw new ApiFailure(500, "internal", "sharp can't load on this computer", {
        userMessage: t("masks.cantOpen"),
      });
    }
  }
}

/** The body as the run it is: a decompose edit of one image, at the image's own shape. */
export function layersRequest(body: LayersBody): GenerateRequest {
  return {
    idempotencyKey: body.idempotencyKey,
    model: body.model,
    op: "decompose",
    prompt: body.prompt ?? "",
    base: { assetId: body.image, role: "base" },
    ...(body.size && { layers: { size: body.size } }),
    size: { kind: "auto" },
    batch: 1,
    source: body.source ?? "detail_editor",
    ...(body.canvas && { canvas: body.canvas }),
  };
}

/** A box kept inside the canvas, in whole pixels. */
function clampBox(box: LayerBox, canvas: { width: number; height: number }): LayerBox {
  const x = (v: number) => Math.min(canvas.width, Math.max(0, Math.round(v)));
  const y = (v: number) => Math.min(canvas.height, Math.max(0, Math.round(v)));
  return [x(box[0]), y(box[1]), x(box[2]), y(box[3])];
}

const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Layer";

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = name.replace(/\.png$/, ` ${n}.png`);
  taken.add(candidate);
  return candidate;
}

function once(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
