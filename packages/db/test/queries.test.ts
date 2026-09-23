import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newId } from "@openfield/core";
import type { Capabilities, NormalizedRequest } from "@openfield/core/schemas";
import {
  activeJobSets,
  activeJobs,
  activeProviderBatches,
  addToFolder,
  assetVersions,
  clearFavourite,
  createFolder,
  createJobSet,
  createProviderBatch,
  deleteFolder,
  deriveJobSetStatus,
  dueProviderBatches,
  feedPage,
  findLiveAssetBySha256,
  finishProviderBatch,
  getAssets,
  getJobSetBundle,
  getModel,
  getProvider,
  getProviderBatch,
  getProviderBatchForJobSet,
  getProviderSettings,
  InvalidCursorError,
  insertAsset,
  insertUsage,
  listFolders,
  listJobSets,
  listKeyStatus,
  listModels,
  markBatchCleaned,
  markBatchNotified,
  type OpenDb,
  openDb,
  providerBatchesForJobSets,
  readSettings,
  recordBatchPoll,
  recordBatchSubmitted,
  recordKeyCheck,
  refreshJobSetStatus,
  removeFromFolder,
  restoreAsset,
  resumableBatches,
  seedProviders,
  setAssetFileState,
  setFavourite,
  setModelEnabled,
  setProviderCredential,
  softDeleteAssets,
  transitionJob,
  transitionJobsInSet,
  trashedBefore,
  unannouncedBatches,
  uncleanedBatches,
  updateFolder,
  updateJob,
  updateProviderSettings,
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

function newRun(key: string | null = newId(), batch = 2, speed: "standard" | "batch" = "standard") {
  return createJobSet(db(), {
    jobSet: {
      id: newId(),
      idempotencyKey: key,
      op: "generate",
      providerId: "google",
      modelId: "m",
      requestJson: request,
      speed,
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

  test("a run keeps its speed, and a job records the speed it was served at", () => {
    const run = newRun(null, 1);
    expect(run.jobSet.speed).toBe("standard");
    const job = run.jobs[0]!;
    expect(job.speedUsed).toBeNull();
    expect(transitionJob(db(), job.id, "succeeded", { speedUsed: "standard" })?.speedUsed).toBe("standard");
    expect(newRun(null, 1, "batch").jobSet.speed).toBe("batch");
  });

  test("the queue scan can leave Batch runs to the batch watcher", () => {
    const sync = newRun(null, 1);
    const batch = newRun(null, 2, "batch");
    expect(activeJobs(db()).map((r) => r.jobSet.id)).toEqual([
      sync.jobSet.id,
      batch.jobSet.id,
      batch.jobSet.id,
    ]);
    expect(activeJobs(db(), { skipBatch: true }).map((r) => r.jobSet.id)).toEqual([sync.jobSet.id]);
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

describe("company settings", () => {
  test("only changed values are stored; a value back at its default is removed", () => {
    expect(getProviderSettings(db(), "google")).toEqual({});
    updateProviderSettings(db(), "google", { set: { speed: "flex", flexBusy: "standard" } });
    expect(getProviderSettings(db(), "google")).toEqual({ speed: "flex", flexBusy: "standard" });
    const row = updateProviderSettings(db(), "google", { set: { speed: "batch" }, unset: ["flexBusy"] });
    expect(row?.settings).toEqual({ speed: "batch" });
    expect(updateProviderSettings(db(), "google", { unset: ["speed"] })?.settings).toBeNull();
    expect(getProviderSettings(db(), "google")).toEqual({});
  });

  test("the Limits panel writes the concurrency cap", () => {
    expect(updateProviderSettings(db(), "google", { concurrencyCap: 2 })?.concurrencyCap).toBe(2);
    expect(getProvider(db(), "google")?.settings).toBeNull();
    expect(updateProviderSettings(db(), "nobody", { concurrencyCap: 2 })).toBeUndefined();
    expect(getProviderSettings(db(), "nobody")).toEqual({});
  });
});

describe("provider batches", () => {
  const handle = {
    remoteId: "batches/abc123",
    displayName: "",
    expiresAt: "2026-09-25T10:00:00.000Z",
    resume: { uploads: [] },
  };

  function newBatch() {
    const run = newRun(null, 2, "batch");
    const batch = createProviderBatch(db(), {
      jobSetId: run.jobSet.id,
      providerId: "google",
      modelId: "m",
      itemCount: 2,
      credentialHint: "a1b2",
      createdAt: "2026-09-23T10:00:00.000Z",
    });
    return { run, batch };
  }

  test("written before the create call, named after its run, one per run", () => {
    const { run, batch } = newBatch();
    expect(batch).toMatchObject({
      state: "submitting",
      remoteId: null,
      displayName: `openfield-${run.jobSet.id}`,
      itemCount: 2,
    });
    expect(getProviderBatchForJobSet(db(), run.jobSet.id)?.id).toBe(batch.id);
    expect(() =>
      createProviderBatch(db(), {
        jobSetId: run.jobSet.id,
        providerId: "google",
        modelId: "m",
        itemCount: 2,
      }),
    ).toThrow(/UNIQUE/);
    expect(providerBatchesForJobSets(db(), [run.jobSet.id]).get(run.jobSet.id)?.id).toBe(batch.id);
  });

  test("the company's id is stored the moment create returns, and polls follow the schedule", () => {
    const { batch } = newBatch();
    const sent = recordBatchSubmitted(
      db(),
      batch.id,
      { ...handle, displayName: batch.displayName },
      {
        nextPollAt: "2026-09-23T10:00:30.000Z",
        submittedAt: "2026-09-23T10:00:01.000Z",
      },
    );
    expect(sent).toMatchObject({
      state: "queued",
      remoteId: "batches/abc123",
      expiresAt: handle.expiresAt,
      submittedAt: "2026-09-23T10:00:01.000Z",
    });
    expect(getProviderBatch(db(), batch.id)?.handle?.resume).toEqual({ uploads: [] });

    expect(dueProviderBatches(db(), "2026-09-23T10:00:29.000Z")).toEqual([]);
    expect(dueProviderBatches(db(), "2026-09-23T10:00:30.000Z").map((b) => b.id)).toEqual([batch.id]);
    const polled = recordBatchPoll(db(), batch.id, {
      state: "running",
      nextPollAt: "2026-09-23T10:01:00.000Z",
      at: "2026-09-23T10:00:30.000Z",
    });
    expect(polled).toMatchObject({ state: "running", lastPolledAt: "2026-09-23T10:00:30.000Z" });
  });

  test("a cancel during the create call keeps its state, and the id is still stored", () => {
    const { batch } = newBatch();
    finishProviderBatch(db(), batch.id, { state: "canceled" });
    const sent = recordBatchSubmitted(db(), batch.id, handle, { nextPollAt: "2026-09-23T10:00:30.000Z" });
    expect(sent).toMatchObject({ state: "canceled", remoteId: "batches/abc123" });
  });

  test("restart: every batch in flight comes back with the jobs still waiting", () => {
    const { run, batch } = newBatch();
    const done = newBatch();
    finishProviderBatch(db(), done.batch.id, { state: "succeeded" });
    transitionJob(db(), run.jobs[0]!.id, "queued");
    transitionJob(db(), run.jobs[1]!.id, "failed", { errorCode: "content_refused" });
    expect(activeProviderBatches(db()).map((b) => b.id)).toEqual([batch.id]);
    const [resumed] = resumableBatches(db());
    expect(resumed?.batch.id).toBe(batch.id);
    expect(resumed?.jobSet.id).toBe(run.jobSet.id);
    expect(resumed?.jobs.map((j) => j.id)).toEqual([run.jobs[0]!.id]);
  });

  test("finishes once, notifies once, and is cleaned up at the company", () => {
    const { batch } = newBatch();
    recordBatchSubmitted(db(), batch.id, handle, { nextPollAt: "2026-09-23T10:00:30.000Z" });
    expect(unannouncedBatches(db())).toEqual([]);
    const finished = finishProviderBatch(db(), batch.id, {
      state: "expired",
      errorCode: "timeout",
      at: "2026-09-25T10:00:00.000Z",
    });
    expect(finished).toMatchObject({ state: "expired", nextPollAt: null, errorCode: "timeout" });
    expect(finishProviderBatch(db(), batch.id, { state: "succeeded" })).toBeUndefined();
    expect(recordBatchPoll(db(), batch.id, { state: "running", nextPollAt: "x" })).toBeUndefined();
    expect(dueProviderBatches(db(), "2030-01-01T00:00:00.000Z")).toEqual([]);

    expect(unannouncedBatches(db()).map((b) => b.id)).toEqual([batch.id]);
    expect(markBatchNotified(db(), batch.id)).toBe(true);
    expect(markBatchNotified(db(), batch.id)).toBe(false);
    expect(unannouncedBatches(db())).toEqual([]);

    expect(uncleanedBatches(db()).map((b) => b.id)).toEqual([batch.id]);
    markBatchCleaned(db(), batch.id);
    expect(uncleanedBatches(db())).toEqual([]);
  });

  test("a batch goes with its run", () => {
    const { run, batch } = newBatch();
    opened.db.$client.run("DELETE FROM job_sets WHERE id = ?", [run.jobSet.id]);
    expect(getProviderBatch(db(), batch.id)).toBeUndefined();
  });

  test("the database refuses states and speeds outside the lists", () => {
    const { batch } = newBatch();
    expect(() =>
      opened.db.$client.run("UPDATE provider_batches SET state = 'done' WHERE id = ?", [batch.id]),
    ).toThrow(/CHECK constraint failed/);
    expect(() => opened.db.$client.run("UPDATE job_sets SET speed = 'turbo'")).toThrow(
      /CHECK constraint failed/,
    );
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

  test("fake mode costs nothing and never reaches a spend total, but its images still count", () => {
    const base = {
      providerId: "google",
      modelId: "m",
      operation: "generate" as const,
      outcome: "succeeded" as const,
    };
    const fake = insertUsage(db(), {
      ...base,
      ts: "2026-09-23T11:00:00.000Z",
      costUsd: 0.067,
      speed: "batch",
      simulated: true,
    });
    expect([fake.costUsd, fake.simulated, fake.speed]).toEqual([0, true, "batch"]);
    insertUsage(db(), {
      ...base,
      ts: "2026-09-23T11:01:00.000Z",
      outcome: "canceled",
      discarded: true,
      costUsd: 0.2,
      simulated: true,
    });
    expect(usageRollup(db(), { from: "2026-09-23" })).toEqual([
      { day: "2026-09-23", providerId: "google", modelId: "m", runs: 2, images: 1, usd: 0, usdDiscarded: 0 },
    ]);
    // Even a fake row that carries a cost adds nothing to a total.
    db().$client.run("UPDATE usage_log SET cost_usd = 0.5 WHERE simulated = 1 AND outcome = 'succeeded'");
    const real = insertUsage(db(), {
      ...base,
      ts: "2026-09-23T11:02:00.000Z",
      costUsd: 0.067,
      speed: "flex",
    });
    expect([real.simulated, real.speed]).toEqual([false, "flex"]);
    expect(usageRollup(db(), { from: "2026-09-23" })[0]).toMatchObject({
      runs: 3,
      images: 2,
      usd: 0.067,
      usdDiscarded: 0,
    });
  });
});
