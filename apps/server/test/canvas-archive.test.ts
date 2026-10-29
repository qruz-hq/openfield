import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanvasArchiveJob,
  type CanvasArchiveManifest,
  type CanvasDetail,
  canvasArchiveJobSchema,
  canvasArchiveManifestSchema,
  canvasDetailSchema,
  canvasSource,
  sseEventSchema,
  uploadResponseSchema,
} from "@openfield/core";
import { type CanvasDocument, canvasDocumentSchema } from "@openfield/core/canvas";
import {
  edgesInto,
  foldersOfAsset,
  getAsset,
  getCanvas,
  getFolder,
  insertAsset,
  isFavourite,
  listCanvases,
  listFolders,
  setFavourite,
} from "@openfield/db";
import { LAST_FRAME_JPEG, VIDEO_SILENT } from "../../../packages/providers/src/byteplus/__fixtures__/media";
import { importArchive } from "../src/canvas/archive-import";
import { openArchiveSource } from "../src/canvas/archive-source";
import { serverEngineContext } from "../src/canvas/engine-context";
import { absolutePath } from "../src/config/home";
import { ZipArchive } from "../src/files/unzip";
import { finished, libraryImages, MODEL, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { quarterMask, texture, whiteQuarter } from "./pixels";

// Canvas archives (§7.8): a canvas with every image it shows goes out as one .ofcanvas.zip and comes
// into another library whole, with each image's details, in a folder named after it, at no cost,
// and still up to date. What the library already has is used, not copied again.

const servers: TestServer[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(opts: { desktop?: boolean } = {}): Promise<TestServer> {
  const s = await startTestServer({
    env: { OPENFIELD_FFMPEG: "off", ...(opts.desktop && { OPENFIELD_DESKTOP: "1" }) },
  });
  servers.push(s);
  await saveKey(s);
  return s;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openfield-archive-"));
  scratch.push(dir);
  return dir;
}

const tab = { kind: "tab" as const, tabId: "tab-archive1" };
const NAME = "Lighthouse ☕";

interface Made {
  canvas: CanvasDetail;
  ref: string;
  up: string;
  gen: string;
  generated: string[];
}

/** A canvas like a real one: an uploaded reference and a prompt into a Generate node that ran. */
async function madeCanvas(s: TestServer): Promise<Made> {
  const [ref] = await libraryImages(s, 1);
  const canvas = await newCanvas(s, { name: NAME });
  const { aliases } = s.services.canvases.edit(
    canvas.id,
    [
      { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [ref!] } },
      { op: "add_node", as: "p", type: "prompt", params: { text: "A lighthouse at dusk" } },
      { op: "add_node", as: "g", type: "image.generate", params: { model: MODEL, batch: 2 } },
      { op: "connect", source: "p", target: "g" },
      { op: "connect", source: "up", target: "g", targetHandle: "input_images" },
    ],
    tab,
  );
  const run = await s.services.canvasRuns.runScope(canvas.id, { scope: "all" });
  expect((await finished(s, run.runId!)).status).toBe("succeeded");
  const gen = aliases.g!;
  const generated = savedDoc(s, canvas.id).nodes.find((n) => n.id === gen)!.result!.assetIds;
  expect(generated).toHaveLength(2);
  return { canvas, ref: ref!, up: aliases.up!, gen, generated };
}

const savedDoc = (s: TestServer, id: string): CanvasDocument =>
  canvasDocumentSchema.parse(getCanvas(s.services.db, id)!.graph);

/** The nodes a Run all would leave alone because they're up to date. */
async function upToDate(s: TestServer, canvasId: string): Promise<string[]> {
  return (await s.services.canvasRuns.runScope(canvasId, { scope: "all", dryRun: true })).upToDate;
}

async function exportZip(s: TestServer, canvasId: string, dir = tempDir()): Promise<string> {
  const res = await s.request(`/api/canvases/${canvasId}/export`);
  expect(res.status).toBe(200);
  const file = join(dir, "export.ofcanvas.zip");
  writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  return file;
}

/** Imports through the service, as the desktop app's path import does, and waits for the end. */
async function imported(s: TestServer, path: string, name?: string): Promise<CanvasArchiveJob> {
  const job = s.services.archives.startImport({ path }, name ? { name } : {});
  const done = await s.services.archives.wait(job.jobId, 10_000);
  return done!;
}

function resultOf(job: CanvasArchiveJob) {
  if (job.result?.kind !== "import") throw new Error(`The import ${job.state}: ${JSON.stringify(job.error)}`);
  return job.result;
}

async function readArchive(file: string) {
  const zip = await ZipArchive.open(file);
  const text = async (name: string) => new Response(await zip.open(zip.find(name)!)).text();
  return {
    zip,
    doc: canvasDocumentSchema.parse(JSON.parse(await text("canvas.json"))),
    manifest: canvasArchiveManifestSchema.parse(
      JSON.parse(await text("manifest.json")),
    ) as CanvasArchiveManifest,
  };
}

/** Every file under the library's assets folder. */
function assetFiles(s: TestServer): string[] {
  const root = s.services.paths.assets;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const assetCount = (s: TestServer) =>
  (s.services.db.$client.query("SELECT count(*) AS n FROM assets").get() as { n: number }).n;

describe("GET /api/canvases/:id/export", () => {
  test("streams a zip with the document, the manifest and every image's original", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    setFavourite(a.services.db, [made.generated[0]!]);
    const res = await a.request(`/api/canvases/${made.canvas.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-openfield-zip-count")).toBe("3");
    expect(res.headers.get("x-openfield-archive-missing")).toBe("0");
    // A Latin-1 header carries the plain name; the real one rides in filename*.
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Lighthouse _.ofcanvas.zip"; filename*=UTF-8''${encodeURIComponent(`${NAME}.ofcanvas.zip`)}`,
    );
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(Number(res.headers.get("x-openfield-zip-bytes")));
    const file = join(tempDir(), "a.zip");
    writeFileSync(file, body);
    const { zip, doc, manifest } = await readArchive(file);

    expect(zip.entries.slice(0, 2).map((e) => e.name)).toEqual(["canvas.json", "manifest.json"]);
    expect(doc.id).toBe(made.canvas.id);
    expect(doc.meta.previewPath).toBeNull();
    expect(manifest.canvas).toMatchObject({ id: made.canvas.id, name: NAME, nodeCount: 3, edgeCount: 2 });
    expect(manifest.assets.map((m) => m.id).sort()).toEqual([made.ref, ...made.generated].sort());
    const first = manifest.assets.find((m) => m.id === made.generated[0])!;
    const row = getAsset(a.services.db, first.id)!;
    expect(first).toMatchObject({
      file: `assets/${row.id}.png`,
      sha256: row.sha256,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      kind: "generated",
      modelId: row.modelId,
      prompt: row.prompt,
      seed: row.seed,
      favourite: true,
    });
    expect(first.costUsd).toBeGreaterThan(0);
    // Its originals, byte for byte, and the reference links.
    const original = await Bun.file(absolutePath(a.services.paths, row.path)).bytes();
    expect(new Uint8Array(await new Response(await zip.open(zip.find(first.file)!)).arrayBuffer())).toEqual(
      original,
    );
    expect(manifest.edges).toContainEqual({
      parentAssetId: made.ref,
      childAssetId: first.id,
      relation: "reference",
      ordinal: 0,
    });
  });

  test("images in the Trash stay out and count as missing; a stale graphVersion is a 409", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    a.services.library.trash([made.generated[1]!]);
    const res = await a.request(`/api/canvases/${made.canvas.id}/export`);
    expect(res.headers.get("x-openfield-zip-count")).toBe("2");
    expect(res.headers.get("x-openfield-archive-missing")).toBe("1");
    const file = join(tempDir(), "a.zip");
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
    const { manifest } = await readArchive(file);
    expect(manifest.missing).toEqual([made.generated[1]!]);

    const version = getCanvas(a.services.db, made.canvas.id)!.graphVersion;
    expect(
      (await a.request(`/api/canvases/${made.canvas.id}/export?graphVersion=${version + 1}`)).status,
    ).toBe(409);
    expect((await a.request(`/api/canvases/${made.canvas.id}/export?graphVersion=${version}`)).status).toBe(
      200,
    );
    expect((await a.request("/api/canvases/01K6BQ8000000000000000NONE/export")).status).toBe(404);
  });
});

describe("importing an archive", () => {
  test("a fresh library gets every image with its details, in a folder named after the canvas, at no cost", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    setFavourite(a.services.db, [made.generated[0]!]);
    const file = await exportZip(a, made.canvas.id);

    const b = await start({ desktop: true });
    const res = await b.json<CanvasArchiveJob>("/api/canvas-imports", {
      method: "POST",
      body: { path: file },
    });
    expect(res.status).toBe(202);
    expect(canvasArchiveJobSchema.parse(res.body)).toMatchObject({ kind: "import", state: "waiting" });
    const job = (await b.services.archives.wait(res.body.jobId, 10_000))!;
    const result = resultOf(job);
    expect(result).toMatchObject({ name: NAME, imported: 3, reused: 0, missing: 0 });

    // The canvas: new ids, the same wiring and results, nothing spent, filed with its folder.
    const detail = canvasDetailSchema.parse((await b.json(`/api/canvases/${result.canvasId}`)).body);
    expect(detail.missingAssetIds).toEqual([]);
    const doc = detail.graph;
    expect(doc.nodes.map((n) => n.id)).not.toContain(made.gen);
    const gen = doc.nodes.find((n) => n.type === "image.generate")!;
    expect(gen.result).toMatchObject({
      assetIds: made.generated,
      costUsd: null,
      jobSetId: null,
      jobSetIds: [],
    });
    expect(getCanvas(b.services.db, result.canvasId)!.folderId).toBe(result.folderId);
    expect((await b.json<{ usd: number }>(`/api/canvases/${result.canvasId}/spend`)).body.usd).toBe(0);
    // Still up to date: Run all would make nothing.
    expect(await upToDate(b, result.canvasId)).toEqual([gen.id]);

    // The images: originals byte for byte, their details, no job or cost, Open in Canvas here.
    const folder = getFolder(b.services.db, result.folderId!)!;
    expect(folder).toMatchObject({ name: NAME, count: 3 });
    for (const id of [made.ref, ...made.generated]) {
      const there = getAsset(a.services.db, id)!;
      const here = getAsset(b.services.db, id)!;
      expect(here).toMatchObject({
        kind: there.kind,
        sha256: there.sha256,
        mime: there.mime,
        width: there.width,
        height: there.height,
        prompt: there.prompt,
        modelId: there.modelId,
        providerId: there.providerId,
        seed: there.seed,
        createdAt: there.createdAt,
        costUsd: null,
        jobId: null,
        jobSetId: null,
      });
      expect(await Bun.file(absolutePath(b.services.paths, here.path)).bytes()).toEqual(
        await Bun.file(absolutePath(a.services.paths, there.path)).bytes(),
      );
      expect(foldersOfAsset(b.services.db, id).map((f) => f.id)).toEqual([result.folderId!]);
    }
    const one = getAsset(b.services.db, made.generated[0]!)!;
    expect(one.opParams).toEqual({ source: canvasSource(result.canvasId, gen.id) });
    expect(isFavourite(b.services.db, one.id)).toBe(true);
    expect(edgesInto(b.services.db, [one.id]).map((e) => [e.parentAssetId, e.relation])).toEqual([
      [made.ref, "reference"],
    ]);

    // Other tabs heard; the job said how far it got.
    expect(b.events.some((e) => e.event === "folder.updated")).toBe(true);
    const frames = b.events
      .filter((e) => e.event === "canvas_archive.updated")
      .map((e) => sseEventSchema.parse(e).data as CanvasArchiveJob);
    expect(frames.at(-1)).toMatchObject({
      state: "done",
      canvasId: result.canvasId,
      files: { done: 3, total: 3 },
    });
    expect(frames.at(-1)!.done).toBe(frames.at(-1)!.total);
  });

  test("into the library it came from, every image is used as it is", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const before = assetFiles(a).length;
    const result = resultOf(await imported(a, await exportZip(a, made.canvas.id)));
    expect(result).toMatchObject({ imported: 0, reused: 3, missing: 0 });
    expect(assetFiles(a)).toHaveLength(before);
    const doc = savedDoc(a, result.canvasId);
    const gen = doc.nodes.find((n) => n.type === "image.generate")!;
    expect(gen.result!.assetIds).toEqual(made.generated);
    // Reused images are filed into the new canvas's folder too, and keep their other folders.
    expect(foldersOfAsset(a.services.db, made.generated[0]!).map((f) => f.id)).toContain(result.folderId!);
    expect(await upToDate(a, result.canvasId)).toEqual([gen.id]);
  });

  test("the same bytes under another id are used, and nodes that were up to date stay so", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = await exportZip(a, made.canvas.id);

    const b = await start();
    // The same picture, uploaded here first: another id, the same bytes.
    const [mine] = await libraryImages(b, 1);
    expect(mine).not.toBe(made.ref);
    expect(getAsset(b.services.db, mine!)!.sha256).toBe(getAsset(a.services.db, made.ref)!.sha256);

    const result = resultOf(await imported(b, file));
    expect(result).toMatchObject({ imported: 2, reused: 1, missing: 0 });
    expect(getAsset(b.services.db, made.ref)).toBeUndefined();
    const doc = savedDoc(b, result.canvasId);
    const up = doc.nodes.find((n) => n.type === "image.upload")!;
    const gen = doc.nodes.find((n) => n.type === "image.generate")!;
    expect(up.params.assetIds).toEqual([mine]);
    expect(gen.result!.inputs).toEqual([mine!]);
    // The upload's fingerprint changed with its image, so the Generate node's was recomputed.
    const original = savedDoc(a, made.canvas.id).nodes.find((n) => n.id === made.gen)!;
    expect(gen.result!.fingerprint).not.toBe(original.result!.fingerprint);
    expect(await upToDate(b, result.canvasId)).toEqual([gen.id]);
    // The links point at the image that's here.
    expect(edgesInto(b.services.db, [made.generated[0]!]).map((e) => e.parentAssetId)).toEqual([mine!]);
  });

  test("an id held by an image in the Trash gets a new one, and the canvas follows", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    a.services.library.trash(made.generated);

    const result = resultOf(await imported(a, file));
    expect(result).toMatchObject({ imported: 2, reused: 1, missing: 0 });
    const gen = savedDoc(a, result.canvasId).nodes.find((n) => n.type === "image.generate")!;
    const fresh = gen.result!.assetIds;
    expect(fresh).toHaveLength(2);
    for (const [i, id] of fresh.entries()) {
      expect(id).not.toBe(made.generated[i]);
      expect(getAsset(a.services.db, id)!.sha256).toBe(
        getAsset(a.services.db, made.generated[i]!, { includeDeleted: true })!.sha256,
      );
    }
    expect(gen.result!.outputs.map((o) => o.assetId)).toEqual(fresh);
    // The trashed images stay in the Trash.
    expect(getAsset(a.services.db, made.generated[0]!)).toBeUndefined();
    expect(await upToDate(a, result.canvasId)).toEqual([gen.id]);
    expect(
      canvasDetailSchema.parse((await a.json(`/api/canvases/${result.canvasId}`)).body).missingAssetIds,
    ).toEqual([]);
  });

  test("the unzipped folder imports the same, with or without the folder around it", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const zipFile = await exportZip(a, made.canvas.id);
    const dir = tempDir();
    const unpack = Bun.spawnSync(["unzip", "-q", zipFile, "-d", join(dir, "Lighthouse.ofcanvas")]);
    if (unpack.exitCode !== 0) return;
    const b = await start();
    // The folder the zip unpacked into, and the one above it.
    expect(resultOf(await imported(b, join(dir, "Lighthouse.ofcanvas")))).toMatchObject({ imported: 3 });
    expect(resultOf(await imported(b, dir))).toMatchObject({ imported: 0, reused: 3 });
  });

  test("a plain .ofcanvas.json brings the canvas; its images show as missing unless they're here", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = join(tempDir(), "Lighthouse.ofcanvas.json");
    writeFileSync(file, JSON.stringify(savedDoc(a, made.canvas.id)));

    const b = await start();
    const there = resultOf(await imported(b, file, "Copied"));
    expect(there).toMatchObject({ name: "Copied", imported: 0, reused: 0, missing: 3, folderId: null });
    const detail = canvasDetailSchema.parse((await b.json(`/api/canvases/${there.canvasId}`)).body);
    expect(detail.missingAssetIds?.sort()).toEqual([made.ref, ...made.generated].sort());

    const here = resultOf(await imported(a, file));
    expect(here).toMatchObject({ imported: 0, reused: 3, missing: 0 });
    expect(here.folderId).not.toBeNull();
  });

  test("what isn't a canvas is refused with words a person can act on", async () => {
    const b = await start();
    const dir = tempDir();
    const notJson = join(dir, "x.ofcanvas.json");
    writeFileSync(notJson, "hello");
    const notZip = join(dir, "x.txt");
    writeFileSync(notZip, "hello");
    const newer = join(dir, "newer.ofcanvas.json");
    writeFileSync(newer, JSON.stringify({ schema: "openfield.canvas/99" }));
    const badNode = join(dir, "bad.ofcanvas.json");
    const doc = savedDoc(await (async () => b)(), (await newCanvas(b)).id);
    writeFileSync(badNode, JSON.stringify({ ...doc, nodes: [{ id: "n1", type: "image.generate" }] }));

    for (const [path, words] of [
      [notJson, "This isn't a canvas or a canvas export."],
      [notZip, "This isn't a canvas or a canvas export."],
      [join(dir, "nothing.zip"), `There's nothing at ${join(dir, "nothing.zip")}.`],
      [dir, "This isn't a canvas or a canvas export."],
      [newer, "This canvas needs a newer version of Openfield."],
      [badNode, "Node 1 can't be read."],
    ] as const) {
      const job = await imported(b, path);
      expect(job.state).toBe("failed");
      expect(job.error?.userMessage).toBe(words);
    }
    expect(listCanvases(b.services.db)).toHaveLength(1);
  });

  test("a cancel part way leaves nothing behind: no canvas, images, files or folder", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    const b = await start();
    const real = await openArchiveSource(file);
    const controller = new AbortController();
    let opened = 0;
    // Cancels as the second image starts, with the first already staged in the library folder.
    const source = {
      ...real,
      open: async (name: string) => {
        if (name.startsWith("assets/") && ++opened === 2) controller.abort(new Error("Canceled"));
        return real.open(name);
      },
    };
    const progress = { named() {}, sized() {}, copied() {}, fileDone() {}, committing() {} };
    const deps = { ...b.services, engineContext: () => serverEngineContext(b.services) };
    await expect(importArchive(deps, source, {}, progress, controller.signal)).rejects.toThrow("Canceled");
    expect(assetCount(b)).toBe(0);
    expect(assetFiles(b)).toEqual([]);
    expect(listCanvases(b.services.db)).toEqual([]);
    expect(listFolders(b.services.db)).toEqual([]);
    expect(readdirSync(b.services.paths.tmp).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  test("a cancel through the job stops it, and one waiting its turn never starts", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    const b = await start();
    const first = b.services.archives.startImport({ path: file });
    const second = b.services.archives.startImport({ path: file });
    expect(b.services.archives.cancel(second.jobId)).toMatchObject({ state: "waiting" });
    expect(b.services.archives.cancel(first.jobId)?.jobId).toBe(first.jobId);
    const [one, two] = await Promise.all([
      b.services.archives.wait(first.jobId, 5_000),
      b.services.archives.wait(second.jobId, 5_000),
    ]);
    expect([one!.state, two!.state]).toEqual(["canceled", "canceled"]);
    expect(assetCount(b)).toBe(0);
    expect(listCanvases(b.services.db)).toEqual([]);
    // A finished job answers as it is; an unknown one is a 404.
    const res = await b.json<CanvasArchiveJob>(`/api/canvas-archive-jobs/${first.jobId}`, {
      method: "DELETE",
    });
    expect(res.body.state).toBe("canceled");
    expect((await b.request("/api/canvas-archive-jobs/01K6BQ8000000000000000NONE")).status).toBe(404);
  });

  test("a failure while saving rolls everything back", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    const b = await start();
    b.services.canvases.insertImported = () => {
      throw new Error("The disk went away");
    };
    const job = await imported(b, file);
    expect(job.state).toBe("failed");
    expect(assetCount(b)).toBe(0);
    expect(assetFiles(b)).toEqual([]);
    expect(listFolders(b.services.db)).toEqual([]);
  });

  test("imports of the same archive at once go one at a time, the later reusing the first's images", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    const b = await start();
    const jobs = [0, 1, 2].map(() => b.services.archives.startImport({ path: file }));
    // One canceled while it waits doesn't let the next one past the import still running.
    b.services.archives.cancel(jobs[1]!.jobId);
    const [one, two, three] = await Promise.all(jobs.map((j) => b.services.archives.wait(j.jobId, 10_000)));
    expect(resultOf(one!)).toMatchObject({ imported: 3, reused: 0 });
    expect(two!.state).toBe("canceled");
    expect(resultOf(three!)).toMatchObject({ imported: 0, reused: 3 });
    expect(assetCount(b)).toBe(3);
  });

  test("two images with the same bytes keep their ids and share one file", async () => {
    const a = await start();
    const [ref] = await libraryImages(a, 1);
    const row = getAsset(a.services.db, ref!)!;
    // A second row on the same file, as an upload of an image made here gets (§8.5.1).
    const twin = "01K6BQ80000000000000000TWN";
    insertAsset(a.services.db, { ...row, id: twin, kind: "generated", rootAssetId: twin });
    const canvas = await newCanvas(a, { name: "Twins" });
    a.services.canvases.edit(
      canvas.id,
      [{ op: "add_node", type: "image.asset", params: { assetIds: [ref!, twin] } }],
      tab,
    );
    const file = await exportZip(a, canvas.id);
    const b = await start();
    expect(resultOf(await imported(b, file))).toMatchObject({ imported: 2, reused: 0, missing: 0 });
    expect(getAsset(b.services.db, ref!)!.path).toBe(getAsset(b.services.db, twin)!.path);
    expect(assetFiles(b)).toHaveLength(1);
  });

  test("a damaged image is left out and shows as missing; the rest come in", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const dir = tempDir();
    const zipFile = await exportZip(a, made.canvas.id);
    if (Bun.spawnSync(["unzip", "-q", zipFile, "-d", dir]).exitCode !== 0) return;
    const { manifest } = await readArchive(zipFile);
    const broken = manifest.assets.find((m) => m.id === made.generated[1])!;
    writeFileSync(join(dir, broken.file), "not an image");
    const b = await start();
    const result = resultOf(await imported(b, dir));
    expect(result).toMatchObject({ imported: 2, missing: 1 });
    const detail = canvasDetailSchema.parse((await b.json(`/api/canvases/${result.canvasId}`)).body);
    expect(detail.missingAssetIds).toEqual([made.generated[1]!]);
  });
});

describe("browser uploads", () => {
  test("a zip goes up in pieces, each where the last ended, then imports", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const zip = new Uint8Array(await Bun.file(await exportZip(a, made.canvas.id)).arrayBuffer());
    const b = await start();
    const { body: upload } = await b.json<{ uploadId: string }>("/api/canvas-imports/uploads", {
      method: "POST",
    });
    const put = (offset: number, chunk: Uint8Array, path = "Lighthouse.ofcanvas.zip") =>
      b.request(
        `/api/canvas-imports/uploads/${upload.uploadId}/files?path=${encodeURIComponent(path)}&offset=${offset}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: chunk,
        },
      );
    const half = Math.floor(zip.byteLength / 2);
    expect(await (await put(0, zip.slice(0, half))).json()).toEqual({
      path: "Lighthouse.ofcanvas.zip",
      size: half,
    });
    // Not where the file ends: refused, with nothing written.
    expect((await put(half + 5, zip.slice(half))).status).toBe(409);
    expect(await (await put(half, zip.slice(half))).json()).toMatchObject({ size: zip.byteLength });
    expect((await put(0, zip, "../escape.zip")).status).toBe(400);

    const res = await b.json<CanvasArchiveJob>("/api/canvas-imports", {
      method: "POST",
      body: { uploadId: upload.uploadId, name: "Uploaded" },
    });
    expect(res.status).toBe(202);
    const job = (await b.services.archives.wait(res.body.jobId, 10_000))!;
    expect(resultOf(job)).toMatchObject({ name: "Uploaded", imported: 3 });
    // The staging area is cleared once the import is done.
    expect((await put(0, zip)).status).toBe(404);
  });

  test("a folder sends canvas.json and manifest.json first, then only the files the library lacks", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const { zip } = await readArchive(await exportZip(a, made.canvas.id));
    const files = new Map<string, Uint8Array>();
    for (const entry of zip.entries) {
      files.set(
        `Lighthouse.ofcanvas/${entry.name}`,
        new Uint8Array(await new Response(await zip.open(entry)).arrayBuffer()),
      );
    }
    const send = async (s: TestServer, uploadId: string, path: string) => {
      const res = await s.request(
        `/api/canvas-imports/uploads/${uploadId}/files?path=${encodeURIComponent(path)}&offset=0`,
        { method: "PUT", body: files.get(path)! },
      );
      expect(res.status).toBe(200);
    };
    const neededIn = async (s: TestServer) => {
      const { body } = await s.json<{ uploadId: string }>("/api/canvas-imports/uploads", { method: "POST" });
      await send(s, body.uploadId, "Lighthouse.ofcanvas/canvas.json");
      await send(s, body.uploadId, "Lighthouse.ofcanvas/manifest.json");
      const res = await s.json<{ files: string[] }>(`/api/canvas-imports/uploads/${body.uploadId}/needed`, {
        method: "POST",
      });
      return { uploadId: body.uploadId, needed: res.body.files };
    };

    // The library it came from has every image already.
    expect((await neededIn(a)).needed).toEqual([]);

    const b = await start();
    await libraryImages(b, 1);
    const { uploadId, needed } = await neededIn(b);
    // The reference is here under another id; the two generated images aren't.
    expect(needed.sort()).toEqual(made.generated.map((id) => `Lighthouse.ofcanvas/assets/${id}.png`).sort());
    for (const path of needed) await send(b, uploadId, path);
    const res = await b.json<CanvasArchiveJob>("/api/canvas-imports", { method: "POST", body: { uploadId } });
    expect(resultOf((await b.services.archives.wait(res.body.jobId, 10_000))!)).toMatchObject({
      imported: 2,
      reused: 1,
      missing: 0,
    });
    // Dropping an upload twice is fine; an unknown one is a 404 for pieces.
    const { body: spare } = await b.json<{ uploadId: string }>("/api/canvas-imports/uploads", {
      method: "POST",
    });
    expect(
      (await b.request(`/api/canvas-imports/uploads/${spare.uploadId}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await b.request(`/api/canvas-imports/uploads/${spare.uploadId}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (
        await b.request(`/api/canvas-imports/uploads/${spare.uploadId}/files?path=a.zip&offset=0`, {
          method: "PUT",
          body: "x",
        })
      ).status,
    ).toBe(404);
  });
});

describe("paths on this computer", () => {
  test("only the desktop app may name them", async () => {
    const a = await start();
    const made = await madeCanvas(a);
    const target = join(tempDir(), "out.ofcanvas.zip");
    const exported = await a.json(`/api/canvases/${made.canvas.id}/export-to`, {
      method: "POST",
      body: { path: target },
    });
    expect(exported.status).toBe(403);
    const importing = await a.json("/api/canvas-imports", { method: "POST", body: { path: target } });
    expect(importing.status).toBe(403);
    expect(existsSync(target)).toBe(false);
  });

  test("export-to saves through a .part file, and won't replace a file unless told to", async () => {
    const a = await start({ desktop: true });
    const made = await madeCanvas(a);
    const dir = tempDir();
    const target = join(dir, "out.ofcanvas.zip");
    const res = await a.json<CanvasArchiveJob>(`/api/canvases/${made.canvas.id}/export-to`, {
      method: "POST",
      body: { path: target },
    });
    expect(res.status).toBe(202);
    const job = (await a.services.archives.wait(res.body.jobId, 10_000))!;
    expect(job).toMatchObject({ state: "done", canvasId: made.canvas.id, name: NAME });
    expect(job.result).toEqual({
      kind: "export",
      path: target,
      bytes: statSync(target).size,
      assets: 3,
      missing: 0,
    });
    expect(job.files.done).toBe(job.files.total);
    expect(readdirSync(dir)).toEqual(["out.ofcanvas.zip"]);
    expect((await readArchive(target)).manifest.assets).toHaveLength(3);

    const again = await a.json<{ error: { userMessage: string } }>(
      `/api/canvases/${made.canvas.id}/export-to`,
      {
        method: "POST",
        body: { path: target },
      },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.userMessage).toBe("There's already a file called out.ofcanvas.zip there.");
    const replaced = await a.json<CanvasArchiveJob>(`/api/canvases/${made.canvas.id}/export-to`, {
      method: "POST",
      body: { path: target, overwrite: true },
    });
    expect((await a.services.archives.wait(replaced.body.jobId, 10_000))!.state).toBe("done");

    for (const [path, status] of [
      [join(dir, "out.txt"), 400],
      [join(dir, "nowhere", "out.zip"), 400],
      ["relative.zip", 400],
    ] as const) {
      expect(
        (await a.json(`/api/canvases/${made.canvas.id}/export-to`, { method: "POST", body: { path } }))
          .status,
      ).toBe(status);
    }
  });

  test("a canceled export leaves no file behind", async () => {
    const a = await start({ desktop: true });
    const made = await madeCanvas(a);
    const dir = tempDir();
    const job = a.services.archives.exportTo(made.canvas.id, join(dir, "out.zip"));
    a.services.archives.cancel(job.jobId);
    expect((await a.services.archives.wait(job.jobId, 5_000))!.state).toBe("canceled");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("videos", () => {
  test("a video comes with its poster, so its thumbnails show here without ffmpeg", async () => {
    const a = await start();
    const { ingest, db } = a.services;
    const video = await ingest.stage(new Blob([Buffer.from(VIDEO_SILENT, "base64")]).stream(), {
      video: true,
    });
    const still = await ingest.stage(new Blob([Buffer.from(LAST_FRAME_JPEG, "base64")]).stream());
    const posterPath = await ingest.poster(video, still);
    expect(posterPath).not.toBeNull();
    insertAsset(db, {
      id: video.assetId,
      kind: "generated",
      modality: "video",
      path: video.path,
      mime: video.mime,
      width: video.width,
      height: video.height,
      bytes: video.bytes,
      sha256: video.sha256,
      prompt: "A kite over the hill",
      durationMs: video.durationMs ?? null,
      hasAudio: video.hasAudio ?? null,
      posterPath,
    });
    const canvas = await newCanvas(a, { name: "Kites" });
    a.services.canvases.edit(
      canvas.id,
      [{ op: "add_node", type: "image.asset", params: { assetIds: [video.assetId] } }],
      tab,
    );
    const file = await exportZip(a, canvas.id);
    const { manifest } = await readArchive(file);
    expect(manifest.assets[0]).toMatchObject({
      file: `assets/${video.assetId}.mp4`,
      poster: `assets/${video.assetId}.poster.jpg`,
      modality: "video",
    });

    const b = await start();
    expect(resultOf(await imported(b, file))).toMatchObject({ imported: 1, missing: 0 });
    const row = getAsset(b.services.db, video.assetId)!;
    expect(row).toMatchObject({
      modality: "video",
      mime: "video/mp4",
      durationMs: video.durationMs,
      prompt: "A kite over the hill",
    });
    expect(row.posterPath).not.toBeNull();
    expect(await Bun.file(absolutePath(b.services.paths, row.posterPath!)).bytes()).toEqual(
      await Bun.file(absolutePath(a.services.paths, posterPath!)).bytes(),
    );
  });
});

describe("Edit nodes", () => {
  const OPENAI = "openai:gpt-image-2";

  const withOpenAi = async (s: TestServer) => {
    const res = await s.json("/api/settings/keys/openai", {
      method: "PUT",
      body: { apiKey: "sk-test-0123456789abcdefghijklmnop" },
    });
    expect(res.status).toBe(200);
  };

  async function upload(s: TestServer, bytes: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new File([bytes], "photo"));
    const res = await s.request("/api/uploads", { method: "POST", body: form });
    return uploadResponseSchema.parse(await res.json()).asset.id;
  }

  /**
   * An image edited twice: once with a mask painted in the node, once with an image wired into its
   * Mask input, which the run saves as a mask the canvas doesn't show. Both ran.
   */
  async function editedCanvas(s: TestServer) {
    await withOpenAi(s);
    const base = await upload(s, await texture(640, 480));
    const wired = await upload(s, await whiteQuarter(640, 480));
    const form = new FormData();
    form.append("mask", new File([await quarterMask(640, 480)], "mask.png"));
    form.append("baseAssetId", base);
    // Inverted, so it isn't the mask the wired image makes: that one would be saved as this one.
    form.append("invert", "true");
    const res = await s.request("/api/masks", { method: "POST", body: form });
    const painted = uploadResponseSchema.parse(await res.json()).asset.id;
    const canvas = await newCanvas(s, { name: "Doors" });
    const { aliases } = s.services.canvases.edit(
      canvas.id,
      [
        { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [base] } },
        { op: "add_node", as: "m", type: "image.upload", params: { assetIds: [wired] } },
        {
          op: "add_node",
          as: "painted",
          type: "image.edit",
          params: { model: OPENAI, prompt: "a red door", maskAssetId: painted, maskFor: base },
        },
        { op: "add_node", as: "wired", type: "image.edit", params: { model: OPENAI, prompt: "a blue door" } },
        { op: "connect", source: "up", target: "painted", targetHandle: "image" },
        { op: "connect", source: "up", target: "wired", targetHandle: "image" },
        { op: "connect", source: "m", target: "wired", targetHandle: "mask" },
      ],
      tab,
    );
    const run = await s.services.canvasRuns.runScope(canvas.id, { scope: "all" });
    expect((await finished(s, run.runId!, 20_000)).status).toBe("succeeded");
    const resultOfNode = (alias: string) =>
      savedDoc(s, canvas.id).nodes.find((n) => n.id === aliases[alias])!.result!.assetIds[0]!;
    const [first, second] = [resultOfNode("painted"), resultOfNode("wired")];
    const saved = getAsset(s.services.db, second)!.maskAssetId!;
    expect(getAsset(s.services.db, first)!.maskAssetId).toBe(painted);
    expect(saved).not.toBe(wired);
    expect(saved).not.toBe(painted);
    return { canvas, base, wired, painted, saved, first, second };
  }

  test("an archive carries the painted mask and the masks the edits used, and both come back whole", async () => {
    const a = await start();
    const made = await editedCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    const { manifest } = await readArchive(file);
    expect(manifest.missing).toEqual([]);
    const listed = new Map(manifest.assets.map((m) => [m.id, m]));
    expect(listed.get(made.painted)).toMatchObject({ kind: "mask", parentAssetId: made.base });
    expect(listed.get(made.saved)).toMatchObject({ kind: "mask", parentAssetId: made.base });
    expect(listed.get(made.first)).toMatchObject({ kind: "edited", maskAssetId: made.painted });

    // The image is here already under another id, so the canvas and its masks follow it.
    const b = await start();
    await withOpenAi(b);
    const mine = await upload(b, await texture(640, 480));
    expect(mine).not.toBe(made.base);
    const result = resultOf(await imported(b, file));
    // Images as the new folder lists them: the two masks come along, but aren't counted.
    expect(result).toMatchObject({ imported: 3, reused: 1, missing: 0 });

    const doc = savedDoc(b, result.canvasId);
    const edits = doc.nodes.filter((n) => n.type === "image.edit");
    expect(edits.find((n) => n.params.maskAssetId)!.params).toMatchObject({
      maskAssetId: made.painted,
      maskFor: mine,
    });
    for (const mask of [made.painted, made.saved]) {
      expect(getAsset(b.services.db, mask)).toMatchObject({ kind: "mask", parentAssetId: mine });
    }
    // Each edit still names the mask it was made with.
    expect(getAsset(b.services.db, made.first)).toMatchObject({
      parentAssetId: mine,
      maskAssetId: made.painted,
    });
    expect(getAsset(b.services.db, made.second)).toMatchObject({
      parentAssetId: mine,
      maskAssetId: made.saved,
    });
    expect(
      canvasDetailSchema.parse((await b.json(`/api/canvases/${result.canvasId}`)).body).missingAssetIds,
    ).toEqual([]);
    // Nothing turned stale: the painted mask still fits the image it was painted on.
    expect((await upToDate(b, result.canvasId)).sort()).toEqual(edits.map((n) => n.id).sort());
  });

  test("a photo back from the Trash under a new id brings its painted mask with it", async () => {
    const a = await start();
    const made = await editedCanvas(a);
    const file = await exportZip(a, made.canvas.id);
    // The photo sits in the Trash, so the import gives it a new id; the mask here is still live.
    a.services.library.trash([made.base]);
    const result = resultOf(await imported(a, file));
    const doc = savedDoc(a, result.canvasId);
    const edit = doc.nodes.find((n) => n.type === "image.edit" && n.params.maskAssetId)!;
    const photo = doc.nodes.find((n) => n.type === "image.upload")!.params.assetIds as string[];
    expect(edit.params.maskFor).not.toBe(made.base);
    expect(photo).toContain(edit.params.maskFor as string);
    // A mask of its own, painted on the photo the canvas has now, so the editor and a run agree.
    expect(edit.params.maskAssetId).not.toBe(made.painted);
    expect(getAsset(a.services.db, edit.params.maskAssetId as string)).toMatchObject({
      kind: "mask",
      parentAssetId: edit.params.maskFor,
    });
    const plan = await a.services.canvasRuns.runScope(result.canvasId, { scope: "all", dryRun: true });
    expect(plan.blocked).toEqual([]);
  });

  test("a folder sends the masks with the edits that need them, and none the library has", async () => {
    const a = await start();
    const made = await editedCanvas(a);
    const { zip } = await readArchive(await exportZip(a, made.canvas.id));
    const files = new Map<string, Uint8Array>();
    for (const entry of zip.entries) {
      files.set(entry.name, new Uint8Array(await new Response(await zip.open(entry)).arrayBuffer()));
    }
    const neededIn = async (s: TestServer) => {
      const { body } = await s.json<{ uploadId: string }>("/api/canvas-imports/uploads", { method: "POST" });
      for (const name of ["canvas.json", "manifest.json"]) {
        const res = await s.request(
          `/api/canvas-imports/uploads/${body.uploadId}/files?path=${name}&offset=0`,
          { method: "PUT", body: files.get(name)! },
        );
        expect(res.status).toBe(200);
      }
      const res = await s.json<{ files: string[] }>(`/api/canvas-imports/uploads/${body.uploadId}/needed`, {
        method: "POST",
      });
      return res.body.files.sort();
    };
    expect(await neededIn(a)).toEqual([]);
    const b = await start();
    await upload(b, await texture(640, 480));
    const png = (id: string) => `assets/${id}.png`;
    expect(await neededIn(b)).toEqual(
      [made.wired, made.painted, made.saved, made.first, made.second].map(png).sort(),
    );
  });
});
