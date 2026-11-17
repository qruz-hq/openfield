import { closeSync, existsSync, openSync, readSync } from "node:fs";
import {
  type Asset,
  assetFileUrl,
  type EditOpParams,
  editOpParamsSchema,
  FIX_ORIGINAL,
  fixesFromRgba,
  fixesToRgba,
  isEmptyFixes,
  KEEP_REST_SENSITIVITY,
  type KeepRestApplyBody,
  type KeepRestAreaQuery,
  type KeepRestRecord,
  type KeepRestState,
  type KeepRestUnavailable,
  MASK_COMPOSITE_DEFAULTS,
  type Mark,
  marksSchema,
  newId,
  THUMB_RUNGS,
  t,
} from "@openfield/core";
import {
  type AssetRow,
  type Db,
  findLiveAssetBySha256,
  getAsset,
  hashesInUse,
  insertAsset,
  insertAssetEdges,
  isFavourite,
  pathsInUse,
  replaceKeptFile,
} from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import {
  AnalysisCache,
  areaMap,
  fittedResult,
  type KeepFiles,
  type KeepSettings,
  keptVersion,
} from "../files/composite";
import type { Ingest, StagedFile } from "../files/ingest";
import { probeImage } from "../files/probe";
import { loadSharp, type Sharp } from "../files/sharp";
import { Thumbs } from "../files/thumbs";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import { toAsset } from "../mappers/asset";
import type { LibraryService } from "./library";
import type { SettingsService } from "./settings";

// Keep the rest of the image, after the run (§0.9). An edit made with a mask or marks keeps the
// model's own result hidden with it (assets.result_path), so its kept version can be made again
// with other settings, in place and for free, and the model's result saved as an image of its own.
// The off state is never written: it's only a view of the stored result, which the browser shows
// from the files these hand out.

export interface KeepRestDeps {
  db: Db;
  ingest: Ingest;
  thumbs: Thumbs;
  library: LibraryService;
  settings: SettingsService;
  logger: Logger;
  /** files/sharp.ts unless given. */
  loadSharp?: () => Promise<Sharp>;
}

/** An edit that can be adjusted, with everything its kept version is made from. */
interface Adjustable {
  row: AssetRow;
  edit: EditOpParams;
  keep: KeepRestRecord;
  base: AssetRow;
  mask: AssetRow | undefined;
  marks: Mark[] | undefined;
  resultPath: string;
}

type Resolved = { ok: true; it: Adjustable } | { ok: false; why: KeepRestUnavailable; row: AssetRow };

export class KeepRestService {
  /** One change at a time per edit, so two quick Applies can't interleave their files. */
  readonly #queue = new Map<string, Promise<unknown>>();
  /** Comparing the two pictures is the slow part; deciding again for a slider is quick. */
  readonly #analyses = new AnalysisCache();

  constructor(private readonly deps: KeepRestDeps) {}

  /** GET /api/assets/:id/keep-rest */
  state(id: string): KeepRestState {
    const resolved = this.#resolve(id);
    return this.#stateOf(resolved);
  }

  /**
   * POST /api/assets/:id/keep-rest: the kept version made again with these settings and fixes, and
   * written over the library image in place. The model's result stays, so it can be done again.
   * `fixes` is a new fix layer (an RGBA PNG at the original's size).
   */
  apply(
    id: string,
    body: KeepRestApplyBody,
    fixes?: Uint8Array,
  ): Promise<{ asset: Asset; state: KeepRestState; changed: boolean }> {
    return this.#serial(id, () => this.#apply(id, body, fixes));
  }

  /**
   * POST /api/assets/:id/keep-rest/save: the model's own result as a library image of its own.
   * With a fix layer, its "use the original" strokes put the original back there first.
   */
  save(id: string, fixes?: Uint8Array): Promise<{ asset: Asset; existing: boolean }> {
    return this.#serial(id, () => this.#save(id, fixes));
  }

  /** The decided area as a grey PNG, for these settings or the stored ones. */
  /** The area map, or only its etag when the caller already has that one: making it is the slow part. */
  async area(
    id: string,
    query: KeepRestAreaQuery,
    known?: string,
  ): Promise<{ png?: Uint8Array<ArrayBuffer>; etag: string }> {
    const it = this.#adjustable(id, { trashed: true });
    const settings = this.#settingsOf(it, query);
    // The original can be adjusted too, and the fix layer changes the revision.
    const etag = `"${it.base.sha256.slice(0, 12)}-${it.row.sha256.slice(0, 12)}-${it.keep.revision}-${settings.mode}-${settings.sensitivity}-${settings.expandPx}-${settings.featherPx}"`;
    if (known === etag) return { etag };
    const sharp = await this.#sharp();
    const fixes = await this.#storedFixes(it.row);
    const made = await areaMap(
      sharp,
      this.deps.ingest,
      this.#files(it, fixes),
      settings,
      this.deps.logger,
      this.#cached(it),
    );
    if (made === "turned") throw turned();
    return { png: made.png, etag };
  }

  /**
   * The model's result as the server blends it, at the original's size (composite fittedResult), or
   * only its etag when the caller already has that one.
   */
  async fitted(id: string, known?: string): Promise<{ png?: Uint8Array<ArrayBuffer>; etag: string }> {
    const it = this.#adjustable(id, { trashed: true });
    const { ingest } = this.deps;
    const etag = `"fit-${it.row.id}-${it.base.sha256.slice(0, 16)}"`;
    if (known === etag) return { etag };
    const png = await fittedResult(await this.#sharp(), ingest, {
      base: ingest.fileOf(it.base.path),
      result: ingest.fileOf(it.resultPath),
    });
    return { png, etag };
  }

  /** Where the model's own result is, for /files/model-result. Undefined when there's none. */
  resultFile(id: string): { file: string; mime: string; etag: string } | undefined {
    const row = getAsset(this.deps.db, id, { includeDeleted: true });
    if (!row?.resultPath) return undefined;
    return {
      file: this.deps.ingest.fileOf(row.resultPath),
      mime: mimeOf(row.resultPath),
      etag: `"result-${row.id}"`,
    };
  }

  /** Where the fix layer is, for /files/keep-rest-fixes. */
  fixesFile(id: string): { file: string; etag: string } | undefined {
    const row = getAsset(this.deps.db, id, { includeDeleted: true });
    if (!row?.fixesPath) return undefined;
    return { file: this.deps.ingest.fileOf(row.fixesPath), etag: `"fixes-${row.updatedAt}"` };
  }

  async #apply(id: string, body: KeepRestApplyBody, upload?: Uint8Array) {
    const it = this.#adjustable(id);
    // Off is only a view of the model's result; it's saved with "Save as new image", never in place.
    // An edit that's off now (Sketch & point, by default) is turned on by asking for it.
    if (!(body.keep ?? it.edit.composite.applied)) {
      throw new ApiFailure(400, "bad_request", "Keep the rest can't be turned off in place", {
        field: "keep",
        userMessage: t("keepRest.offInPlace"),
      });
    }
    const { db, ingest, logger } = this.deps;
    const settings = this.#settingsOf(it, body);
    const sharp = await this.#sharp();

    // A new fix layer replaces the stored one, "clear" drops it, and otherwise the stored one stays.
    let fixes: Uint8Array | undefined;
    if (upload) fixes = (await canonicalFixes(sharp, upload, it.base))?.png;
    else if (body.fixes !== "clear") fixes = await this.#storedFixes(it.row);
    const keptFixes = upload ? fixes : undefined;

    let made: Awaited<ReturnType<typeof keptVersion>>;
    try {
      made = await keptVersion(sharp, ingest, this.#files(it, fixes), settings, logger, this.#cached(it));
    } catch (err) {
      logger.warn("Couldn't make an edit's kept version again", {
        assetId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ApiFailure(500, "internal", "The kept version couldn't be made", {
        userMessage: t("keepRest.failed"),
      });
    }
    if (made === "turned") throw turned();

    let staged = await this.#stage(made.png);
    // The same picture as before: the file stays, and only the record changes.
    const same = staged.sha256 === it.row.sha256;
    if (same) {
      ingest.discard(staged);
      staged = { ...staged, path: it.row.path, bytes: it.row.bytes, mime: it.row.mime as StagedFile["mime"] };
    }
    const fixesStaged = keptFixes ? await this.#stage(keptFixes, "uploads") : undefined;
    const fixesPath = fixesStaged ? fixesStaged.path : fixes ? it.row.fixesPath : null;
    const fixesBytes = fixesStaged ? fixesStaged.bytes : fixes ? it.row.fixesBytes : null;
    const edit: EditOpParams = {
      ...it.edit,
      composite: {
        applied: true,
        expandPx: settings.expandPx,
        featherPx: settings.featherPx,
        ...(made.resizedFrom && { resizedFrom: made.resizedFrom }),
      },
      keepRest: {
        ...it.keep,
        mode: settings.mode,
        sensitivity: settings.sensitivity,
        lineUp: made.decided.lineUp,
        fellBack: made.decided.fellBack,
        changed: made.decided.changed,
        fixes: fixesPath ? true : undefined,
        revision: it.keep.revision + 1,
      },
    };
    const replaced = db.transaction((tx) =>
      replaceKeptFile(tx, id, {
        path: staged.path,
        bytes: staged.bytes,
        sha256: staged.sha256,
        // A kept version is a PNG at the original's size, whatever the model sent.
        mime: staged.mime,
        width: staged.width,
        height: staged.height,
        opParams: { ...it.row.opParams, edit: clean(edit) },
        fixesPath,
        fixesBytes,
      }),
    );
    if (!replaced) {
      // Trashed or deleted while this was made: nothing changed, so nothing new stays either.
      if (!same) ingest.discard(staged);
      if (fixesStaged) ingest.discard(fixesStaged);
      throw gone(id);
    }
    const { before, after } = replaced;
    await this.#letGo(before, after);
    this.deps.library.announceUpdated([id]);
    const rung = THUMB_RUNGS[this.deps.settings.get().feedZoom] ?? 456;
    this.deps.thumbs.warm(after, Thumbs.sizeFor({ h: rung }));
    return {
      asset: toAsset(after, isFavourite(db, id), false),
      state: this.#stateOf(this.#resolve(id)),
      changed: before.sha256 !== after.sha256,
    };
  }

  async #save(id: string, upload?: Uint8Array): Promise<{ asset: Asset; existing: boolean }> {
    const it = this.#adjustable(id);
    const { db, ingest } = this.deps;
    // Only "use the original" strokes change the model's own result; "use the model" ones are moot.
    const fixes = upload && (await canonicalFixes(await this.#sharp(), upload, it.base));
    if (fixes?.codes.includes(FIX_ORIGINAL)) return this.#saveTouchedUp(it, fixes.png);

    const saved = it.keep.savedAs && getAsset(db, it.keep.savedAs);
    if (saved) return { asset: toAsset(saved, isFavourite(db, saved.id), false), existing: true };

    const file = Bun.file(ingest.fileOf(it.resultPath));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const probed = probeImage(bytes);
    if (!probed?.width) {
      throw new ApiFailure(500, "internal", "The stored result can't be read", {
        userMessage: t("keepRest.failed"),
      });
    }
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const asset = this.#insertSaved(
      it,
      {
        path: it.resultPath,
        mime: probed.mime,
        width: probed.width,
        height: probed.height,
        bytes: bytes.byteLength,
        sha256,
      },
      { savedAs: true },
    );
    return { asset, existing: false };
  }

  /**
   * The model's result at the original's size, with the original put back where the fix layer says
   * so: the whole picture is the area, so nothing else is decided. Saving the same strokes again
   * finds the copy already made.
   */
  async #saveTouchedUp(it: Adjustable, fixes: Uint8Array): Promise<{ asset: Asset; existing: boolean }> {
    const { db, ingest, logger } = this.deps;
    const files: KeepFiles = {
      base: ingest.fileOf(it.base.path),
      result: ingest.fileOf(it.resultPath),
      area: { everywhere: true },
      fixes,
    };
    const settings: KeepSettings = {
      mode: "mask",
      sensitivity: KEEP_REST_SENSITIVITY.default,
      expandPx: 0,
      featherPx: 0,
    };
    let made: Awaited<ReturnType<typeof keptVersion>>;
    try {
      made = await keptVersion(await this.#sharp(), ingest, files, settings, logger);
    } catch (err) {
      logger.warn("Couldn't touch up an edit's model result", {
        assetId: it.row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ApiFailure(500, "internal", "The touched-up result couldn't be made", {
        userMessage: t("keepRest.failed"),
      });
    }
    if (made === "turned") throw turned();
    const staged = await this.#stage(made.png);
    const before = findLiveAssetBySha256(db, staged.sha256);
    if (before && before.opParams?.savedFrom === it.row.id) {
      ingest.discard(staged);
      return { asset: toAsset(before, isFavourite(db, before.id), false), existing: true };
    }
    const asset = this.#insertSaved(it, staged, { savedAs: false });
    return { asset, existing: false };
  }

  /** Adds a saved copy of an edit's model result to the library, a child of the original. */
  #insertSaved(
    it: Adjustable,
    file: Pick<AssetRow, "path" | "mime" | "width" | "height" | "bytes" | "sha256">,
    opts: { savedAs: boolean },
  ): Asset {
    const { db } = this.deps;
    const { row } = it;
    const record: EditOpParams = {
      composite: {
        applied: false,
        expandPx: it.edit.composite.expandPx,
        featherPx: it.edit.composite.featherPx,
        reason: "off",
      },
      ...(it.edit.fallback && { fallback: it.edit.fallback }),
    };
    const asset = db.transaction((tx) => {
      const made = insertAsset(tx, {
        id: newId(),
        kind: "edited",
        // Not one of the run's own images, so a canvas node or a job set never lists it.
        jobId: null,
        jobSetId: null,
        path: file.path,
        mime: file.mime,
        width: file.width,
        height: file.height,
        bytes: file.bytes,
        sha256: file.sha256,
        seed: row.seed,
        providerId: row.providerId,
        modelId: row.modelId,
        prompt: row.prompt,
        params: row.params,
        tags: row.tags,
        // Paid for with the edit, so it carries no cost of its own.
        costUsd: null,
        parentAssetId: row.parentAssetId,
        rootAssetId: row.rootAssetId,
        op: row.op,
        opParams: { ...withoutEdit(row.opParams), edit: record, savedFrom: row.id },
        maskAssetId: row.maskAssetId,
        generative: true,
        approximate: row.approximate,
        approximateReason: row.approximateReason,
        modality: "image",
      });
      if (row.parentAssetId)
        insertAssetEdges(tx, [
          { parentAssetId: row.parentAssetId, childAssetId: made.id, relation: "derived" },
        ]);
      // The edit points at the model's own result saved as it is; touched-up copies are found by hash.
      if (!opts.savedAs) return made;
      const edit = { ...it.edit, keepRest: { ...it.keep, savedAs: made.id } };
      replaceKeptFile(tx, row.id, {
        path: row.path,
        bytes: row.bytes,
        sha256: row.sha256,
        mime: row.mime,
        width: row.width,
        height: row.height,
        opParams: { ...row.opParams, edit: clean(edit) },
        fixesPath: row.fixesPath,
        fixesBytes: row.fixesBytes,
      });
      return made;
    });
    this.deps.library.announceUpdated([row.id, asset.id]);
    const rung = THUMB_RUNGS[this.deps.settings.get().feedZoom] ?? 456;
    this.deps.thumbs.warm(asset, Thumbs.sizeFor({ h: rung }));
    return toAsset(asset, false, false);
  }

  /** Deletes the old kept file, fix layer and thumbnails once no row names them. */
  async #letGo(before: AssetRow, after: AssetRow): Promise<void> {
    const { db } = this.deps;
    const files = [before.path, ...(before.fixesPath ? [before.fixesPath] : [])].filter(
      (p) => p !== after.path && p !== after.fixesPath,
    );
    const used = pathsInUse(db, files);
    const hashes =
      before.sha256 !== after.sha256 && !hashesInUse(db, [before.sha256]).size ? [before.sha256] : [];
    await this.deps.library.removeLeftovers(
      files.filter((p) => !used.has(p)),
      hashes,
    );
  }

  /** `trashed` reads an edit in the Trash as if it weren't: its views still show, nothing changes. */
  #resolve(id: string, opts: { trashed?: boolean } = {}): Resolved {
    const { db } = this.deps;
    const row = getAsset(db, id, { includeDeleted: true });
    if (!row || row.kind === "mask" || row.modality !== "image") {
      throw new ApiFailure(404, "not_found", `No image ${id}`, { userMessage: t("masks.imageGone") });
    }
    if (row.opParams?.savedFrom) return { ok: false, why: "saved_result", row };
    const edit = editOpParamsSchema.safeParse(row.opParams?.edit).data;
    if (!edit) return { ok: false, why: "not_an_edit", row };
    const keep = edit.keepRest;
    // A file gone from disk (moved by hand, say) is as good as never kept.
    if (!keep?.stored || !row.resultPath || !existsSync(this.deps.ingest.fileOf(row.resultPath)))
      return { ok: false, why: "not_stored", row };
    if (row.deletedAt && !opts.trashed) return { ok: false, why: "in_trash", row };
    const base = row.parentAssetId ? getAsset(db, row.parentAssetId, { includeDeleted: true }) : undefined;
    if (!base) return { ok: false, why: "original_gone", row };
    const mask = row.maskAssetId ? getAsset(db, row.maskAssetId, { includeDeleted: true }) : undefined;
    const marks = onBase(marksSchema.safeParse(row.params?.marks).data);
    // An edit with a mask needs it; Sketch & point without one needs its marks.
    if (keep.start === "mask" ? !mask : !mask && !marks) return { ok: false, why: "area_gone", row };
    return { ok: true, it: { row, edit, keep, base, mask, marks, resultPath: row.resultPath } };
  }

  #adjustable(id: string, opts: { trashed?: boolean } = {}): Adjustable {
    const resolved = this.#resolve(id, opts);
    if (resolved.ok) return resolved.it;
    throw new ApiFailure(409, "conflict", `${id} can't be adjusted: ${resolved.why}`, {
      userMessage: t(`keepRest.unavailable.${resolved.why}`),
    });
  }

  #settingsOf(it: Adjustable, asked: Partial<KeepSettings>): KeepSettings {
    return {
      mode: asked.mode ?? it.keep.mode,
      sensitivity: asked.sensitivity ?? it.keep.sensitivity ?? KEEP_REST_SENSITIVITY.default,
      expandPx: asked.expandPx ?? it.edit.composite.expandPx ?? MASK_COMPOSITE_DEFAULTS.expandPx,
      featherPx: asked.featherPx ?? it.edit.composite.featherPx ?? MASK_COMPOSITE_DEFAULTS.featherPx,
    };
  }

  /** Same original, same model result, same area: same comparison. */
  #cached(it: Adjustable) {
    const area = it.mask ? `mask:${it.mask.id}` : `marks:${JSON.stringify(it.marks)}`;
    return { cache: this.#analyses, key: `${it.base.sha256}|${it.resultPath}|${area}` };
  }

  #files(it: Adjustable, fixes?: Uint8Array): KeepFiles {
    const { ingest } = this.deps;
    return {
      base: ingest.fileOf(it.base.path),
      result: ingest.fileOf(it.resultPath),
      // The mask it was made with; Sketch & point without one, the area its marks cover.
      area: it.mask ? { mask: ingest.fileOf(it.mask.path) } : { marks: it.marks! },
      ...(fixes && { fixes }),
    };
  }

  async #storedFixes(row: AssetRow): Promise<Uint8Array | undefined> {
    if (!row.fixesPath) return undefined;
    const file = Bun.file(this.deps.ingest.fileOf(row.fixesPath));
    return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
  }

  #stateOf(resolved: Resolved): KeepRestState {
    const row = resolved.ok ? resolved.it.row : resolved.row;
    const edit = resolved.ok ? resolved.it.edit : editOpParamsSchema.safeParse(row.opParams?.edit).data;
    const keep = edit?.keepRest;
    const composite = edit?.composite;
    const common = {
      assetId: row.id,
      keep: composite?.applied ?? false,
      mode: keep?.mode ?? ("mask" as const),
      sensitivity: keep?.sensitivity ?? KEEP_REST_SENSITIVITY.default,
      expandPx: composite?.expandPx ?? MASK_COMPOSITE_DEFAULTS.expandPx,
      featherPx: composite?.featherPx ?? MASK_COMPOSITE_DEFAULTS.featherPx,
      lineUp: keep?.lineUp ?? null,
      fellBack: keep?.fellBack ?? null,
      changed: keep?.changed ?? null,
      revision: keep?.revision ?? 0,
    };
    if (!resolved.ok) {
      return {
        ...common,
        available: false,
        unavailable: resolved.why,
        note: t(`keepRest.unavailable.${resolved.why}`),
        start: keep?.start ?? null,
        mask: null,
        marks: null,
        fixesUrl: null,
        base: null,
        modelResult: null,
        areaUrl: null,
      };
    }
    const { it } = resolved;
    const id = row.id;
    const saved = it.keep.savedAs ? getAsset(this.deps.db, it.keep.savedAs) : undefined;
    const probed = this.#probeResult(it.resultPath);
    const trashed = (a: AssetRow) => (a.deletedAt ? "?trash=1" : "");
    return {
      ...common,
      available: true,
      ...(it.keep.fellBack && common.keep && { note: t(`keepRest.maskOnly.${it.keep.fellBack}`) }),
      start: it.keep.start,
      mask: it.mask ? { assetId: it.mask.id, url: assetFileUrl(it.mask.id) } : null,
      marks: it.marks ?? null,
      fixesUrl: row.fixesPath ? `/files/keep-rest-fixes/${id}?v=${common.revision}` : null,
      base: {
        assetId: it.base.id,
        url: assetFileUrl(it.base.id) + trashed(it.base),
        width: it.base.width,
        height: it.base.height,
      },
      modelResult: {
        url: `/files/model-result/${id}`,
        fittedUrl: `/files/model-result/${id}?fit=1`,
        width: probed?.width ?? 0,
        height: probed?.height ?? 0,
        mime: probed?.mime ?? mimeOf(it.resultPath),
        bytes: row.resultBytes ?? 0,
        savedAs: saved ? saved.id : null,
      },
      areaUrl: `/files/keep-rest-area/${id}?v=${common.revision}`,
    };
  }

  /** The stored result's type and size, from its header. */
  #probeResult(path: string) {
    try {
      const fd = openSync(this.deps.ingest.fileOf(path), "r");
      try {
        const head = new Uint8Array(256 * 1024);
        const n = readSync(fd, head, 0, head.length, 0);
        return probeImage(head.subarray(0, n)) ?? undefined;
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }

  async #stage(png: Uint8Array, folder: "assets" | "uploads" = "assets"): Promise<StagedFile> {
    try {
      return await this.deps.ingest.stage(new Blob([png as Uint8Array<ArrayBuffer>]).stream(), { folder });
    } catch (err) {
      if (isProviderError(err) && err.code === "disk_full") {
        throw new ApiFailure(507, "disk_full", err.message, { userMessage: t("errors.disk_full.reason") });
      }
      throw err;
    }
  }

  async #sharp(): Promise<Sharp> {
    try {
      return await (this.deps.loadSharp ?? loadSharp)();
    } catch {
      throw new ApiFailure(500, "internal", "sharp can't load on this computer", {
        userMessage: t("keepRest.cantOpen"),
      });
    }
  }

  #serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.#queue.get(id) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(work);
    this.#queue.set(id, next);
    void next
      .finally(() => {
        if (this.#queue.get(id) === next) this.#queue.delete(id);
      })
      .catch(() => undefined);
    return next;
  }
}

/**
 * A fix layer as uploaded, checked against the original's size and saved the one way it's read: an
 * RGBA PNG, opaque white for the model, opaque black for the original, transparent elsewhere.
 * Undefined when it says nothing anywhere.
 */
async function canonicalFixes(
  sharp: Sharp,
  upload: Uint8Array,
  base: AssetRow,
): Promise<{ png: Uint8Array; codes: Uint8Array } | undefined> {
  let decoded: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    decoded = await sharp(upload, { failOn: "truncated", limitInputPixels: base.width * base.height })
      .ensureAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ApiFailure(400, "bad_request", "The fixes can't be decoded", {
      field: "fixes",
      userMessage: t("keepRest.fixesUnreadable"),
    });
  }
  const { data, info } = decoded;
  if (info.width !== base.width || info.height !== base.height || info.channels !== 4) {
    throw new ApiFailure(400, "bad_request", `The fixes are ${info.width}×${info.height}`, {
      field: "fixes",
      userMessage: t("keepRest.fixesWrongSize", {
        fixWidth: info.width,
        fixHeight: info.height,
        width: base.width,
        height: base.height,
      }),
    });
  }
  const fixes = fixesFromRgba(data);
  if (isEmptyFixes(fixes)) return undefined;
  const png = await sharp(fixesToRgba(fixes), {
    raw: { width: base.width, height: base.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { png: new Uint8Array(png), codes: fixes };
}

/** The marks on the image being edited (1); those on references say nothing about its area. */
function onBase(marks: Mark[] | undefined): Mark[] | undefined {
  const mine = marks?.filter((m) => (m.image ?? 1) === 1);
  return mine?.length ? mine : undefined;
}

/** The record without fields left undefined, so the stored JSON stays tidy. */
function clean(edit: EditOpParams): EditOpParams {
  return JSON.parse(JSON.stringify(edit)) as EditOpParams;
}

function withoutEdit(opParams: Record<string, unknown> | null): Record<string, unknown> {
  const { edit: _edit, ...rest } = opParams ?? {};
  return rest;
}

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}

const turned = () =>
  new ApiFailure(400, "bad_request", "The image is stored turned (EXIF orientation 2 to 8)", {
    userMessage: t("masks.turned"),
  });

const gone = (id: string) =>
  new ApiFailure(409, "conflict", `${id} was moved to the Trash while it was being adjusted`, {
    userMessage: t("keepRest.unavailable.in_trash"),
  });
