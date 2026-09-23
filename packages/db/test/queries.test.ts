import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newId } from "@openfield/core";
import type { Capabilities, NormalizedRequest } from "@openfield/core/schemas";
import {
  activeJobSets,
  activeJobs,
  addToFolder,
  assetVersions,
  clearFavourite,
  createFolder,
  createJobSet,
  deleteFolder,
  deriveJobSetStatus,
  feedPage,
  findLiveAssetBySha256,
  getAssets,
  getJobSetBundle,
  getModel,
  InvalidCursorError,
  insertAsset,
  insertUsage,
  listFolders,
  listJobSets,
  listKeyStatus,
  listModels,
  type OpenDb,
  openDb,
  readSettings,
  recordKeyCheck,
  refreshJobSetStatus,
  removeFromFolder,
  restoreAsset,
  seedProviders,
  setAssetFileState,
  setFavourite,
  setModelEnabled,
  setProviderCredential,
  softDeleteAssets,
  transitionJob,
  transitionJobsInSet,
  trashedBefore,
  updateFolder,
  updateJob,
  upsertModels,
  usageRollup,
  writeSettings,
} from "../src";

let opened: OpenDb;
const db = () => opened.db;

beforeEach(() => {
  opened = openDb(":memory:");
  seedProviders(db(), [
    { id: "google", displayName: "Google", adapter: "google", authKind: "api_key", concurrencyCap: 4 },
  ]);
});
afterEach(() => opened.close());

const request = {} as NormalizedRequest; // the frozen request is opaque to these helpers

function newRun(key: string | null = newId(), batch = 2) {
  return createJobSet(db(), {
    jobSet: {
      id: newId(),
      idempotencyKey: key,
      op: "generate",
      providerId: "google",
      modelId: "m",
      requestJson: request,
    },
    jobs: Array.from({ length: batch }, (_, idx) => ({ id: newId(), idx })),
  });
}

function asset(id: string, extra: Partial<Parameters<typeof insertAsset>[1]> = {}) {
  return insertAsset(db(), {
    id,
    kind: "generated",
    path: `assets/${id}.png`,
    mime: "image/png",
    width: 1,
    height: 1,
    bytes: 10,
    sha256: "f".repeat(64),
    ...extra,
  });
}

describe("job sets", () => {
  test("creates a set and its jobs in one go, with per-job idempotency keys", () => {
    const run = newRun("01K6BQ7Y2M8N4P0R3S5T7V9W1X");
    expect(run.created).toBe(true);
    expect(run.jobSet.batchSize).toBe(2);
    expect(run.jobSet.status).toBe("pending");
    expect(run.jobs.map((j) => j.idempotencyKey)).toEqual([
      "01K6BQ7Y2M8N4P0R3S5T7V9W1X:0",
      "01K6BQ7Y2M8N4P0R3S5T7V9W1X:1",
    ]);
  });

  test("a repeated idempotency key returns the first set", () => {
    const first = newRun("01K6BQ8A1C4D7E9F2G3H4J5K6M");
    const again = newRun("01K6BQ8A1C4D7E9F2G3H4J5K6M");
    expect(again.created).toBe(false);
    expect(again.jobSet.id).toBe(first.jobSet.id);
    expect(again.jobs.map((j) => j.id)).toEqual(first.jobs.map((j) => j.id));
  });

  test("a batch over 4 is refused by the database", () => {
    expect(() => newRun(null, 5)).toThrow(/CHECK constraint failed/);
  });

  test("a finished job can't be moved again, so a late result never beats a cancel", () => {
    const { jobs } = newRun();
    const job = jobs[0]!;
    expect(transitionJob(db(), job.id, "canceled")?.status).toBe("canceled");
    expect(transitionJob(db(), job.id, "succeeded")).toBeUndefined();
    expect(updateJob(db(), job.id, { progress: 0.5 })).toBeUndefined();
  });

  test("timestamps follow the state machine, and a retry clears finished_at", () => {
    const { jobs } = newRun();
    const id = jobs[0]!.id;
    const submitting = transitionJob(db(), id, "submitting", {}, { at: "2026-09-23T10:00:00.000Z" });
    expect(submitting?.startedAt).toBe("2026-09-23T10:00:00.000Z");
    const running = transitionJob(
      db(),
      id,
      "running",
      { providerJobId: "op-1" },
      { at: "2026-09-23T10:00:05.000Z" },
    );
    expect(running?.startedAt).toBe("2026-09-23T10:00:00.000Z");
    expect(running?.providerJobId).toBe("op-1");
    const retry = transitionJob(db(), id, "pending", {
      attempt: 1,
      nextAttemptAt: "2026-09-23T10:00:09.000Z",
    });
    expect(retry?.finishedAt).toBeNull();
    expect(retry?.attempt).toBe(1);
    const done = transitionJob(
      db(),
      id,
      "failed",
      { errorCode: "timeout" },
      { at: "2026-09-23T10:01:00.000Z" },
    );
    expect(done?.finishedAt).toBe("2026-09-23T10:01:00.000Z");
    expect(done?.errorCode).toBe("timeout");
  });

  test("the set's status follows its jobs", () => {
    const { jobSet, jobs } = newRun();
    transitionJob(db(), jobs[0]!.id, "running");
    expect(refreshJobSetStatus(db(), jobSet.id)?.status).toBe("running");
    transitionJob(db(), jobs[0]!.id, "succeeded");
    transitionJob(db(), jobs[1]!.id, "failed", { errorCode: "content_refused" });
    const done = refreshJobSetStatus(db(), jobSet.id, "2026-09-23T10:02:00.000Z");
    expect(done?.status).toBe("partial");
    expect(done?.startedAt).not.toBeNull();
    expect(done?.finishedAt).toBe("2026-09-23T10:02:00.000Z");
  });

  test("status derivation", () => {
    expect(deriveJobSetStatus(["pending", "pending"])).toBe("pending");
    expect(deriveJobSetStatus(["succeeded", "pending"])).toBe("running");
    expect(deriveJobSetStatus(["queued", "submitting"])).toBe("queued");
    expect(deriveJobSetStatus(["succeeded", "succeeded"])).toBe("succeeded");
    expect(deriveJobSetStatus(["succeeded", "canceled"])).toBe("partial");
    expect(deriveJobSetStatus(["canceled", "failed"])).toBe("failed");
    expect(deriveJobSetStatus(["canceled", "interrupted"])).toBe("interrupted");
    expect(deriveJobSetStatus(["canceled", "canceled"])).toBe("canceled");
  });

  test("cancel what hasn't started, leave what has", () => {
    const { jobSet, jobs } = newRun();
    transitionJob(db(), jobs[0]!.id, "running");
    const canceled = transitionJobsInSet(db(), jobSet.id, "canceled", { from: ["pending", "queued"] });
    expect(canceled.map((j) => j.id)).toEqual([jobs[1]!.id]);
  });

  test("active lists and bundles", () => {
    const a = newRun();
    const b = newRun();
    transitionJob(db(), b.jobs[0]!.id, "succeeded");
    transitionJob(db(), b.jobs[1]!.id, "succeeded");
    refreshJobSetStatus(db(), b.jobSet.id);
    asset("A1", { jobId: b.jobs[0]!.id, jobSetId: b.jobSet.id });

    expect(activeJobSets(db()).map((s) => s.jobSet.id)).toEqual([a.jobSet.id]);
    expect(activeJobs(db()).map((r) => r.job.id)).toEqual(a.jobs.map((j) => j.id));
    expect(listJobSets(db(), { status: "all" }).items).toHaveLength(2);
    const bundle = getJobSetBundle(db(), b.jobSet.id);
    expect(bundle?.jobs).toHaveLength(2);
    expect(bundle?.assets.map((x) => x.jobId)).toEqual([b.jobs[0]!.id]);
  });
});

describe("assets", () => {
  test("soft delete hides, restore brings back, dedupe only sees live assets", () => {
    asset("A1");
    expect(findLiveAssetBySha256(db(), "f".repeat(64))?.id).toBe("A1");
    expect(softDeleteAssets(db(), ["A1", "A1"])).toEqual(["A1"]);
    expect(feedPage(db()).items).toEqual([]);
    expect(findLiveAssetBySha256(db(), "f".repeat(64))).toBeUndefined();
    expect(restoreAsset(db(), "A1")?.deletedAt).toBeNull();
    expect(feedPage(db()).items.map((a) => a.id)).toEqual(["A1"]);
  });

  test("an original is its own lineage root", () => {
    expect(asset("A1").rootAssetId).toBe("A1");
    expect(asset("A2", { parentAssetId: "A1", rootAssetId: "A1", op: "edit" }).rootAssetId).toBe("A1");
  });

  test("feed filters: favourites and folders", () => {
    asset("A1", { createdAt: "2026-09-23T10:00:00.000Z" });
    asset("A2", { createdAt: "2026-09-23T10:00:01.000Z" });
    setFavourite(db(), ["A1"]);
    const all = feedPage(db()).items;
    expect(all.map((a) => [a.id, a.isFavourite])).toEqual([
      ["A2", false],
      ["A1", true],
    ]);
    expect(feedPage(db(), { favouritesOnly: true }).items.map((a) => a.id)).toEqual(["A1"]);
    clearFavourite(db(), ["A1"]);
    expect(feedPage(db(), { favouritesOnly: true }).items).toEqual([]);

    const folder = createFolder(db(), { id: newId(), name: "Moodboard" });
    addToFolder(db(), folder.id, ["A2", "A2"]);
    expect(feedPage(db(), { folderId: folder.id }).items.map((a) => a.id)).toEqual(["A2"]);
    softDeleteAssets(db(), ["A2"]);
    expect(listFolders(db()).map((f) => [f.name, f.count])).toEqual([["Moodboard", 0]]);
  });

  test("a cursor we didn't mint is refused", () => {
    expect(() => feedPage(db(), { cursor: "garbage" })).toThrow(InvalidCursorError);
  });

  test("lookups skip the trash, versions follow their root, and the trash can be aged", () => {
    asset("V1", { createdAt: "2026-09-23T10:00:00.000Z" });
    asset("V2", {
      parentAssetId: "V1",
      rootAssetId: "V1",
      op: "edit",
      createdAt: "2026-09-23T10:00:01.000Z",
    });
    asset("V3", {
      parentAssetId: "V2",
      rootAssetId: "V1",
      op: "edit",
      createdAt: "2026-09-23T10:00:02.000Z",
    });
    expect(assetVersions(db(), "V1").map((a) => a.id)).toEqual(["V1", "V2", "V3"]);
    expect(getAssets(db(), []).length).toBe(0);

    softDeleteAssets(db(), ["V2"], "2026-09-01T00:00:00.000Z");
    softDeleteAssets(db(), ["V3"], "2026-09-20T00:00:00.000Z");
    expect(getAssets(db(), ["V1", "V2", "nope"]).map((a) => a.id)).toEqual(["V1"]);
    expect(assetVersions(db(), "V1").map((a) => a.id)).toEqual(["V1"]);
    expect(trashedBefore(db(), "2026-09-10T00:00:00.000Z").map((a) => a.id)).toEqual(["V2"]);

    setAssetFileState(db(), "V1", "missing");
    expect(getAssets(db(), ["V1"])[0]?.fileState).toBe("missing");
  });
});

describe("folders", () => {
  test("rename, take assets out, delete", () => {
    asset("F1");
    asset("F2");
    const folder = createFolder(db(), { id: newId(), name: "Moodboard" });
    addToFolder(db(), folder.id, ["F1", "F2"]);
    expect(updateFolder(db(), folder.id, { name: "Board" })?.name).toBe("Board");
    removeFromFolder(db(), folder.id, ["F1"]);
    expect(feedPage(db(), { folderId: folder.id }).items.map((a) => a.id)).toEqual(["F2"]);
    expect(deleteFolder(db(), folder.id)).toBe(true);
    expect(deleteFolder(db(), folder.id)).toBe(false);
    // The images stay; only the folder goes.
    expect(
      feedPage(db())
        .items.map((a) => a.id)
        .sort(),
    ).toEqual(["F1", "F2"]);
  });
});

describe("settings", () => {
  test("defaults until saved, null saves as a real value", () => {
    const initial = readSettings(db());
    expect(initial.trashRetentionDays).toBeNull();
    expect(initial.feedZoom).toBe(3);
    const saved = writeSettings(db(), { trashRetentionDays: 30, feedZoom: 1, defaultModel: "google:m" });
    expect(saved.trashRetentionDays).toBe(30);
    expect(writeSettings(db(), { trashRetentionDays: null }).trashRetentionDays).toBeNull();
    expect(readSettings(db()).feedZoom).toBe(1);
  });

  test("a stored value that no longer parses falls back to its default", () => {
    opened.db.$client.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('feedZoom', '99', 'x'), ('gone', '1', 'x')",
    );
    const s = readSettings(db());
    expect(s.feedZoom).toBe(3);
    expect("gone" in s).toBe(false);
  });
});

describe("providers and models", () => {
  test("seeding keeps existing rows", () => {
    expect(
      seedProviders(db(), [{ id: "google", displayName: "Renamed", adapter: "google", authKind: "api_key" }]),
    ).toEqual([]);
    expect(listKeyStatus(db())).toEqual([
      { providerId: "google", source: "unset", hint: null, lastOkAt: null, lastError: null },
    ]);
  });

  test("key status tracks source, hint and the last check", () => {
    setProviderCredential(db(), "google", { source: "file", ref: "keys.google", hint: "a1b2" });
    recordKeyCheck(db(), "google", { ok: false, code: "auth_invalid" });
    expect(listKeyStatus(db())[0]).toMatchObject({ source: "file", hint: "a1b2", lastError: "auth_invalid" });
    recordKeyCheck(db(), "google", { ok: true }, "2026-09-23T10:00:00.000Z");
    expect(listKeyStatus(db())[0]).toMatchObject({ lastOkAt: "2026-09-23T10:00:00.000Z", lastError: null });
    setProviderCredential(db(), "google", { source: "unset", ref: null, hint: null });
    expect(listKeyStatus(db())[0]?.lastOkAt).toBeNull();
  });

  const capabilities: Capabilities = {
    ops: {
      textToImage: true,
      imageEdit: true,
      inpaint: false,
      outpaint: false,
      upscale: false,
      removeBackground: false,
      detectText: false,
      decomposeLayers: false,
    },
    references: {
      supported: false,
      max: 0,
      roles: [],
      mimeTypes: [],
      maxBytes: 0,
      weights: false,
      strengthMode: "none",
    },
    size: { mode: "aspect", ratios: ["1:1"], default: "1:1" },
    batch: { max: 4, native: false },
    seed: { supported: false, echoed: false },
    negativePrompt: false,
    promptEnhance: "none",
    styleStrength: false,
    transparency: false,
    streaming: { partialImages: false, progressPercent: false },
    output: { formats: ["png"], default: "png" },
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    limits: { requestTimeoutMs: 120_000, typicalLatencyMs: [3000, 9000], maxConcurrent: 4 },
    controlOrder: ["model", "aspect", "batch"],
    unsupportedParamPolicy: "drop-with-warning",
  };
  const model = {
    providerId: "google",
    modelId: "m",
    displayName: "Nano Banana 2",
    capabilities,
    source: "static" as const,
  };

  test("upsert validates manifests and keeps the person's enabled choice", () => {
    upsertModels(db(), [model]);
    setModelEnabled(db(), "google", "m", false);
    const [row] = upsertModels(db(), [{ ...model, displayName: "Nano Banana 2 (new)" }]);
    expect(row?.displayName).toBe("Nano Banana 2 (new)");
    expect(row?.enabled).toBe(false);
    expect(row?.capabilities.batch.max).toBe(4);
    expect(listModels(db(), { enabledOnly: true })).toEqual([]);
    expect(getModel(db(), "google", "m")?.enabled).toBe(false);
    expect(getModel(db(), "google", "nope")).toBeUndefined();
    const broken = { ...capabilities, batch: { max: 8, native: false } };
    expect(() => upsertModels(db(), [{ ...model, capabilities: broken }])).toThrow();
  });
});

describe("usage", () => {
  test("failures cost nothing, cancels after submit count as discarded", () => {
    const base = { providerId: "google", modelId: "m", operation: "generate" as const };
    insertUsage(db(), {
      ...base,
      ts: "2026-09-23T10:00:00.000Z",
      outcome: "succeeded",
      costUsd: 0.134,
      costSource: "estimated",
    });
    insertUsage(db(), {
      ...base,
      ts: "2026-09-23T10:01:00.000Z",
      outcome: "failed",
      costUsd: 0,
      costSource: "unknown",
    });
    insertUsage(db(), {
      ...base,
      ts: "2026-09-23T10:02:00.000Z",
      outcome: "canceled",
      costUsd: 0.134,
      costSource: "estimated",
      discarded: true,
    });
    expect(usageRollup(db(), { from: "2026-09-23" })).toEqual([
      {
        day: "2026-09-23",
        providerId: "google",
        modelId: "m",
        runs: 2,
        images: 1,
        usd: 0.134,
        usdDiscarded: 0.134,
      },
    ]);
  });
});
