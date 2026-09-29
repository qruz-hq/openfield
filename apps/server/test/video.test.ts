import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssetListItem,
  type AssetsListResponse,
  isTerminalState,
  type JobSetAccepted,
  type JobSetsListResponse,
  type ModelsListResponse,
  newId,
  type SseEvent,
} from "@openfield/core";
import { getAsset, getJob, getJobSet } from "@openfield/db";
import { createFakeFetch, type FakeFetch } from "@openfield/providers/server";
import { absolutePath } from "../src/config/home";
import { call, item, newCanvas, finished as runFinished } from "./canvas-helpers";
import { generate, saveKey, startTestServer, type TestServer, waitFor } from "./helpers";

// Video end to end (Seedance on BytePlus, in fake mode): a run is created, followed by its task id,
// lands as a video with its length, sound and poster, and is billed from the tokens BytePlus
// reported. Restarts, cancels and the modality filters on every listing.

const MODEL = "byteplus:seedance-1-0-pro-250528";
const QUEUE = { poll: { firstMs: 5, factor: 1, capMs: 5 }, pollHintCapMs: 10 };

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

// The fake's clock: a task is queued for 1.5 s, then runs until 5 s.
const clock = { now: Date.now() };
const byteplusFake = (opts: { slowMs?: number } = {}) =>
  createFakeFetch({ delayMs: 0, now: () => clock.now, ...opts });

async function start(fetch: FakeFetch, opts: { home?: string; env?: Record<string, string> } = {}) {
  const s = await startTestServer({
    fetch,
    queue: QUEUE,
    ...(opts.home && { home: opts.home }),
    // No ffmpeg unless a test brings its own, so the poster path is the same on every computer.
    env: { OPENFIELD_FFMPEG: "off", ...opts.env },
  });
  if (!opts.home) {
    const res = await s.json("/api/settings/keys/byteplus", {
      method: "PUT",
      body: { apiKey: "ark-test-key" },
    });
    if (res.status !== 200) throw new Error(`Saving the key failed: ${JSON.stringify(res.body)}`);
  }
  return s;
}

function videoRun(s: TestServer, overrides: Record<string, unknown> = {}): Promise<JobSetAccepted> {
  return generate(s, {
    model: MODEL,
    prompt: "A kite over the hill",
    size: { kind: "aspect", ratio: "16:9" },
    video: { seconds: 5, resolution: "720p" },
    ...overrides,
  });
}

const finished = (s: TestServer, jobSetId: string, timeoutMs = 5_000) =>
  waitFor(() => {
    const set = getJobSet(s.services.db, jobSetId);
    return set && isTerminalState(set.status) ? set : undefined;
  }, timeoutMs);

const outputOf = (s: TestServer, jobSetId: string) =>
  waitFor(() => {
    const hit = s.events.find(
      (e) => e.event === "job.output" && (e.data as { jobSetId: string }).jobSetId === jobSetId,
    );
    return (hit?.data as Extract<SseEvent, { event: "job.output" }>["data"] | undefined)?.asset;
  });

/** Moves the fake's clock past the task's end once the runner holds its id. */
async function landed(s: TestServer, run: JobSetAccepted): Promise<AssetListItem> {
  await waitFor(() => getJob(s.services.db, run.jobs[0]!.id)?.handle ?? undefined);
  clock.now += 10_000;
  return outputOf(s, run.jobSet.id);
}

describe("a video run", () => {
  test("is a video run from the start, and lands as a video with its length, sound and poster", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const run = await videoRun(server);
    expect(run.jobSet.modality).toBe("video");
    // The placeholder is the video's own shape at its resolution, not an image tier's.
    expect([run.jobs[0]!.width, run.jobs[0]!.height]).toEqual([1280, 720]);

    const asset = await landed(server, run);
    expect(asset).toMatchObject({
      modality: "video",
      mime: "video/mp4",
      width: 1280,
      height: 720,
      durationMs: 1000,
      hasAudio: false,
      posterUrl: `/files/poster/${asset.id}`,
    });
    const set = await finished(server, run.jobSet.id);
    expect(set.status).toBe("succeeded");

    // The file, by ranges, with its own type; a readable .mp4 name to download.
    const whole = await server.request(asset.fileUrl);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    const bytes = new Uint8Array(await whole.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe("ftyp");
    const part = await server.request(asset.fileUrl, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${bytes.length}`);
    const download = await server.request(`${asset.fileUrl}?download=1`);
    expect(download.headers.get("content-disposition")).toMatch(/seedance-1-0-pro-250528_[a-z0-9]{6}\.mp4"/);

    // Without ffmpeg the poster is the last frame BytePlus sent, and thumbnails come from it.
    const poster = await server.request(asset.posterUrl!);
    expect([poster.status, poster.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    const row = getAsset(server.services.db, asset.id)!;
    expect(row.posterPath).toMatch(/\.poster\.jpg$/);
    const thumb = await server.request(asset.thumbUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toMatch(/^image\//);
    // Posters never stand on their own in the library.
    expect(server.services.db.$client.query("SELECT count(*) AS n FROM assets").get()).toEqual({ n: 1 });
  });

  test("is billed from the tokens BytePlus reported, and logs them with the seconds", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const run = await videoRun(server);
    await landed(server, run);
    const set = await finished(server, run.jobSet.id);
    // 1280 × 720 × 24 × 5 / 1024 = 108,000 tokens at $2.50 per million.
    expect(set.costActualUsd).toBeCloseTo(0.27, 6);
    const usage = server.services.db.$client
      .query<{ units: string; cost_usd: number; cost_source: string }, []>(
        "SELECT units, cost_usd, cost_source FROM usage_log",
      )
      .get()!;
    expect(JSON.parse(usage.units)).toEqual({ tokensOut: 108_000, seconds: 5 });
    expect([usage.cost_usd, usage.cost_source]).toEqual([0.27, "reconciled"]);
    // The estimate at submit came from the same size table, so it agrees.
    expect(getJobSet(server.services.db, run.jobSet.id)?.costEstimateUsd).toBeCloseTo(0.2574, 6);
  });

  test("takes its poster from the first frame when ffmpeg is there", async () => {
    clock.now = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "openfield-ffmpeg-"));
    // A stand-in ffmpeg: writes a JPEG to the last argument, as `-frames:v 1 out.jpg` would.
    const jpeg = join(dir, "frame.jpg");
    writeFileSync(
      jpeg,
      Buffer.from(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
        "base64",
      ),
    );
    const script = join(dir, "ffmpeg");
    writeFileSync(script, `#!/bin/sh\nfor last; do :; done\ncp "${jpeg}" "$last"\n`);
    chmodSync(script, 0o755);
    try {
      server = await start(byteplusFake(), { env: { OPENFIELD_FFMPEG: script } });
      const asset = await landed(server, await videoRun(server));
      const row = getAsset(server.services.db, asset.id)!;
      expect(row.posterPath).toBe(row.path.replace(/\.mp4$/, ".poster.jpg"));
      const poster = await Bun.file(absolutePath(server.services.paths, row.posterPath!)).bytes();
      expect(poster).toEqual(new Uint8Array(await Bun.file(jpeg).arrayBuffer()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a start frame goes with the run, and becomes the video's reference", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#3a6ea5" } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new File([png], "start.png"));
    const upload = (await (await server.request("/api/uploads", { method: "POST", body: form })).json()) as {
      asset: { id: string };
    };
    const run = await videoRun(server, { prompt: "", video: { startFrame: { assetId: upload.asset.id } } });
    const asset = await landed(server, run);
    const edges = server.services.db.$client
      .query<{ parent_asset_id: string; relation: string }, [string]>(
        "SELECT parent_asset_id, relation FROM asset_edges WHERE child_asset_id = ?",
      )
      .all(asset.id);
    expect(edges).toEqual([{ parent_asset_id: upload.asset.id, relation: "reference" }]);
  });

  test("fails with the company's words when BytePlus hasn't turned the model on", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const run = await videoRun(server, { prompt: "#fake:forbidden a kite" });
    const set = await finished(server, run.jobSet.id);
    expect(set.status).toBe("failed");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect(job.errorCode).toBe("auth_forbidden");
    expect(job.errorReason).toBe("Turn on Seedance 1.0 Pro in BytePlus first, then try again.");
  });

  test("a video the company refused bills nothing", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const run = await videoRun(server, { prompt: "#fake:refused a kite" });
    await waitFor(() => getJob(server!.services.db, run.jobs[0]!.id)?.handle ?? undefined);
    clock.now += 10_000;
    const set = await finished(server, run.jobSet.id);
    expect([set.status, set.costActualUsd]).toEqual(["failed", null]);
    expect(getJob(server.services.db, run.jobs[0]!.id)?.errorCode).toBe("content_refused");
  });
});

describe("restarts and cancels", () => {
  test("a video still at BytePlus when the server stops is picked up by its task id at the next start", async () => {
    clock.now = Date.now();
    const first = byteplusFake();
    server = await start(first);
    const run = await videoRun(server);
    const handle = await waitFor(() => getJob(server!.services.db, run.jobs[0]!.id)?.handle ?? undefined);
    const home = server.home;
    await server.close({ keepHome: true });

    clock.now += 10_000;
    const second = byteplusFake();
    server = await start(second, { home });
    const set = await finished(server, run.jobSet.id);
    expect(set.status).toBe("succeeded");
    expect(getJob(server.services.db, run.jobs[0]!.id)?.resumedAt).not.toBeNull();
    // Read by the same id, never sent again.
    expect(second.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(second.calls.some((c) => c.url.endsWith(encodeURIComponent(handle.providerRef!)))).toBe(true);
  });

  test("a task BytePlus no longer has after a restart ends the run, and isn't sent again", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const run = await videoRun(server, { prompt: "#fake:resume_gone a kite" });
    await waitFor(() => getJob(server!.services.db, run.jobs[0]!.id)?.handle ?? undefined);
    const home = server.home;
    await server.close({ keepHome: true });

    clock.now += 20_000;
    const second = byteplusFake();
    server = await start(second, { home });
    const set = await finished(server, run.jobSet.id);
    expect(set.status).toBe("failed");
    expect(getJob(server.services.db, run.jobs[0]!.id)?.errorReason).toBe(
      "BytePlus no longer has this image.",
    );
    expect(second.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("cancel while queued stops the task at BytePlus", async () => {
    clock.now = Date.now();
    const fake = byteplusFake({ slowMs: 600_000 });
    server = await start(fake);
    const run = await videoRun(server, { prompt: "#fake:slow a kite" });
    await waitFor(() => getJob(server!.services.db, run.jobs[0]!.id)?.handle ?? undefined);
    const res = await server.json<{ canceled: string[] }>(`/api/job-sets/${run.jobSet.id}/cancel`, {
      method: "POST",
    });
    expect(res.body.canceled).toEqual([run.jobs[0]!.id]);
    await waitFor(() => fake.calls.some((c) => c.method === "DELETE"));
    const set = await finished(server, run.jobSet.id);
    expect(set.status).toBe("canceled");
    // Sent, so it's logged as possibly charged, at its estimate: BytePlus bills nothing it didn't make.
    const usage = server.services.db.$client
      .query<{ outcome: string; discarded: number }, []>("SELECT outcome, discarded FROM usage_log")
      .get();
    expect(usage).toEqual({ outcome: "canceled", discarded: 1 });
  });
});

describe("on a canvas", () => {
  test("a Video node runs with its start frame from an upstream node and lands on the canvas", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    const canvas = await newCanvas(server);
    // A frame BytePlus takes is 300 px a side or more.
    const sharp = (await import("sharp")).default;
    const big = await sharp({ create: { width: 480, height: 320, channels: 3, background: "#204060" } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new File([big], "frame.png"));
    const upload = (await (await server.request("/api/uploads", { method: "POST", body: form })).json()) as {
      asset: { id: string };
    };
    const video = item("n_vid", {
      type: "video.generate",
      model: MODEL,
      inputs: [
        {
          port: "start_frame",
          to: "start_frame",
          arity: "single",
          values: [{ kind: "asset", assetId: upload.asset.id }],
        },
      ],
      calls: [
        call({
          model: MODEL,
          prompt: "The kite climbs",
          size: { kind: "aspect", ratio: "16:9" },
          video: { seconds: 5, resolution: "720p" },
        }),
      ],
    });
    const res = await server.json<{ runId: string; estimate: { min: number } }>(
      `/api/canvases/${canvas.id}/run`,
      { method: "POST", body: { scope: "all", nodeIds: ["n_vid"], plan: [video] } },
    );
    expect(res.status).toBe(201);
    expect(res.body.estimate.min).toBeCloseTo(0.2574, 6);
    const set = await waitFor(
      () =>
        server!.services.db.$client
          .query<{ id: string; modality: string; request_json: string }, []>(
            "SELECT id, modality, request_json FROM job_sets",
          )
          .get() ?? undefined,
    );
    expect(set.modality).toBe("video");
    expect(JSON.parse(set.request_json).video).toMatchObject({
      seconds: 5,
      resolution: "720p",
      startFrame: { assetId: upload.asset.id },
    });
    await waitFor(() =>
      server!.services.db.$client.query("SELECT handle FROM jobs WHERE handle IS NOT NULL").get(),
    );
    clock.now += 10_000;
    const done = await runFinished(server, res.body.runId);
    expect(done.status).toBe("succeeded");
    const asset = getAsset(server.services.db, done.nodes[0]!.assetIds[0]!)!;
    expect([asset.modality, asset.mime]).toEqual(["video", "video/mp4"]);
  });
});

describe("listings by modality", () => {
  test("models: images by default, videos when asked, both with all", async () => {
    server = await startTestServer({ fetch: byteplusFake() });
    const images = await server.json<ModelsListResponse>("/api/models");
    expect(images.body.models.some((m) => m.providerId === "byteplus")).toBe(false);
    expect(images.body.models.every((m) => m.modality === "image")).toBe(true);

    const videos = await server.json<ModelsListResponse>("/api/models?modality=video");
    expect(videos.body.models.map((m) => m.displayName)).toEqual([
      "Seedance 2.5",
      "Seedance 2.0",
      "Seedance 2.0 Fast",
      "Seedance 2.0 Mini",
      "Seedance 1.5 Pro",
      "Seedance 1.0 Pro",
      "Seedance 1.0 Pro Fast",
    ]);
    expect(videos.body.models.every((m) => m.modality === "video" && m.capabilities.video)).toBe(true);

    const all = await server.json<ModelsListResponse>("/api/models?modality=all");
    expect(all.body.models.length).toBe(images.body.models.length + videos.body.models.length);
    const one = await server.json<{ key: string }>("/api/models/byteplus/seedance-1-0-pro-250528");
    expect(one.body.key).toBe(MODEL);
  });

  test("a video model's price, asked like any other", async () => {
    server = await startTestServer({ fetch: byteplusFake() });
    const res = await server.json<{ min: number; confidence: string }>(
      "/api/models/byteplus/seedance-1-0-pro-250528/estimate",
      {
        method: "POST",
        body: {
          op: "generate",
          batch: 1,
          size: { kind: "aspect", ratio: "16:9" },
          video: { seconds: 5, resolution: "720p" },
        },
      },
    );
    expect(res.body.min).toBeCloseTo(0.2574, 6);
    expect(res.body.confidence).toBe("estimated");
  });

  test("assets and job sets: the Image page's lists stay images, the library shows both", async () => {
    clock.now = Date.now();
    server = await start(byteplusFake());
    await saveKey(server);
    const image = await generate(server);
    const video = await videoRun(server);
    await landed(server, video);
    await finished(server, image.jobSet.id);
    await finished(server, video.jobSet.id);

    const ids = async (path: string) =>
      (await server!.json<AssetsListResponse>(path)).body.items.map((i) => i.modality).sort();
    expect(await ids("/api/assets")).toEqual(["image", "video"]);
    expect(await ids("/api/assets?modality=video")).toEqual(["video"]);
    expect(await ids("/api/assets?modality=image")).toEqual(["image"]);

    const sets = async (path: string) =>
      (await server!.json<JobSetsListResponse>(path)).body.items.map((i) => i.jobSet.modality).sort();
    expect(await sets("/api/job-sets?status=all")).toEqual(["image"]);
    expect(await sets("/api/job-sets?status=all&modality=video")).toEqual(["video"]);
    expect(await sets("/api/job-sets?status=all&modality=all")).toEqual(["image", "video"]);
  });

  test("a video request on an image model is dropped with a warning, never sent", async () => {
    server = await start(byteplusFake());
    await saveKey(server);
    const run = await generate(server, { idempotencyKey: newId(), video: { seconds: 5 } });
    expect(run.jobSet.modality).toBe("image");
    expect(getJobSet(server.services.db, run.jobSet.id)?.requestJson.video).toBeUndefined();
    expect(existsSync(server.home)).toBe(true);
  });
});
