// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type EditBody,
  type JobSetWithJobs,
  type SseEvent,
  t,
  UPLOAD_MAX_BYTES,
  type UploadResponse,
} from "@openfield/core";
import {
  followJobSet,
  followRun,
  isTurnedPhoto,
  mergeJobSet,
  runEdit,
  saveMask,
} from "../src/api/hooks/edit";
import { ApiError } from "../src/api/raw";
import { asset, at, jobSet } from "./fixtures";

// The Edit tab's data: the painted area is saved once (POST /api/masks), the edit is asked for by
// the saved mask's id (POST /api/edit), and the run is followed on the stream from before the 202.
// The server here is a stub that records what it was sent.

const BASE = "01K6BQ8000000000000000BASE";
const MASK = "01K6BQ8000000000000000MASK";

interface Sent {
  path: string;
  form?: FormData;
  json?: unknown;
}
const sent: Sent[] = [];
let answer: (path: string) => Response;

const realFetch = globalThis.fetch;
// The typed client reads the session token from the page; this one has none.
const hadDocument = "document" in globalThis;
if (!hadDocument) globalThis.document = { querySelector: () => null } as unknown as Document;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input instanceof Request ? input.url : input), "http://openfield.local")
    .pathname;
  const body = init?.body;
  sent.push({
    path,
    ...(body instanceof FormData ? { form: body } : body ? { json: JSON.parse(String(body)) } : {}),
  });
  return answer(path);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  if (!hadDocument) Reflect.deleteProperty(globalThis, "document");
});

const saved = (id: string): UploadResponse => ({
  asset: { ...asset(at(0), { id, kind: "mask" }), deletedAt: null } as UploadResponse["asset"],
  duplicate: false,
});
const refusal = (status: number, field: string, userMessage: string) =>
  Response.json(
    { error: { code: "bad_request", message: "refused", retryable: false, field, userMessage } },
    { status },
  );

const run = jobSet(at(0), ["pending", "pending"], { op: "inpaint", source: "detail_editor" });
const body = (maskAssetId: string | undefined): EditBody => ({
  idempotencyKey: "01K6BQ8000000000000000IDEM",
  model: "openai:flare-edit",
  op: "inpaint",
  prompt: "pale dried berries",
  size: { kind: "pixels", width: 768, height: 1024 },
  batch: 2,
  seed: null,
  source: "detail_editor",
  base: { assetId: BASE, role: "base" },
  ...(maskAssetId && { mask: { assetId: maskAssetId, composite: true, expandPx: 4, featherPx: 8 } }),
});

beforeEach(() => {
  sent.length = 0;
  answer = (path) =>
    path === "/api/masks" ? Response.json(saved(MASK), { status: 201 }) : Response.json(run, { status: 202 });
});

describe("saving a mask", () => {
  test("posts the PNG as the form's mask, with the image it was drawn on", async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const result = await saveMask(png, BASE);
    expect(result.asset.id).toBe(MASK);
    expect(sent.map((s) => s.path)).toEqual(["/api/masks"]);
    const form = sent[0]!.form!;
    expect(form.get("baseAssetId")).toBe(BASE);
    const file = form.get("mask") as File;
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  test("a mask past the upload limit is refused here, before it's sent", async () => {
    const huge = new Blob([new Uint8Array(UPLOAD_MAX_BYTES + 1)], { type: "image/png" });
    const error = await saveMask(huge, BASE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 413, field: "mask" });
    expect((error as ApiError).userMessage).toStartWith("This mask is too large.");
    expect(sent).toEqual([]);
  });
});

describe("running an edit", () => {
  test("saves the painted area, then asks for the edit by the saved mask's id", async () => {
    const png = new Blob([new Uint8Array([1])], { type: "image/png" });
    const started = await runEdit({ baseAssetId: BASE, mask: png, body });
    expect(sent.map((s) => s.path)).toEqual(["/api/masks", "/api/edit"]);
    expect(sent[1]!.json).toEqual(body(MASK));
    expect(started).toEqual({ accepted: run, maskAssetId: MASK });
  });

  test("a mask already saved is sent again by id, without saving it twice", async () => {
    const started = await runEdit({ baseAssetId: BASE, mask: MASK, body });
    expect(sent.map((s) => s.path)).toEqual(["/api/edit"]);
    expect(started.maskAssetId).toBe(MASK);
  });

  test("nothing is asked for when the mask can't be saved", async () => {
    answer = () => refusal(400, "baseAssetId", t("masks.turned"));
    const error = await runEdit({ baseAssetId: BASE, mask: new Blob([]), body }).catch((e: unknown) => e);
    expect(sent.map((s) => s.path)).toEqual(["/api/masks"]);
    // A photo saved on its side gets its own kind message (design 6YuF99zpGo).
    expect(isTurnedPhoto(error)).toBe(true);
  });

  test("an edit refused for its base says so, and other refusals aren't a turned photo", async () => {
    answer = () => refusal(400, "base", t("masks.turned"));
    expect(isTurnedPhoto(await runEdit({ baseAssetId: BASE, mask: MASK, body }).catch((e) => e))).toBe(true);
    answer = () => refusal(400, "mask", t("masks.maskGone"));
    const gone = await runEdit({ baseAssetId: BASE, mask: MASK, body }).catch((e: unknown) => e);
    expect(isTurnedPhoto(gone)).toBe(false);
    expect((gone as ApiError).userMessage).toBe(t("masks.maskGone"));
    expect(isTurnedPhoto(new Error("x"))).toBe(false);
  });
});

const [first, second] = run.jobs as [JobSetWithJobs["jobs"][0], JobSetWithJobs["jobs"][0]];
const ref = (jobId: string, idx: number) => ({ jobSetId: run.jobSet.id, jobId, idx });
const started = (jobId: string, idx: number): SseEvent => ({
  event: "job.started",
  data: { ...ref(jobId, idx), startedAt: at(1) },
});
const output = (jobId: string, idx: number, assetId: string): SseEvent => ({
  event: "job.output",
  data: { ...ref(jobId, idx), asset: asset(at(2), { id: assetId }) },
});
const failed = (jobId: string, idx: number): SseEvent => ({
  event: "job.failed",
  data: {
    ...ref(jobId, idx),
    error: {
      code: "content_refused",
      message: "blocked",
      reason: "The company turned it down.",
      retryable: false,
    },
  },
});
const completed = (status: "succeeded" | "partial" | "failed"): SseEvent => ({
  event: "job_set.completed",
  data: { jobSetId: run.jobSet.id, status, costActualUsd: 0.02, durationMs: 4000 },
});
const statuses = (set: JobSetWithJobs) => set.jobs.map((j) => j.status);
const RESULT = "01K6BQ8000000000000000RSLT";

describe("following a run", () => {
  test("each frame moves its own job along, and the run ends with the server's status and cost", () => {
    let set = followJobSet(run, started(first.id, 0));
    expect(statuses(set)).toEqual(["running", "pending"]);
    set = followJobSet(set, output(first.id, 0, RESULT));
    set = followJobSet(set, failed(second.id, 1));
    expect(statuses(set)).toEqual(["succeeded", "failed"]);
    expect(set.jobs[0]!.assetId).toBe(RESULT);
    expect(set.jobs[1]).toMatchObject({
      errorCode: "content_refused",
      errorReason: "The company turned it down.",
    });
    set = followJobSet(set, completed("partial"));
    expect(set.jobSet).toMatchObject({ status: "partial", costActualUsd: 0.02 });
  });

  test("frames for other runs leave it as it is", () => {
    const other = jobSet(at(0), ["pending"]);
    const frame: SseEvent = {
      event: "job.started",
      data: { jobSetId: other.jobSet.id, jobId: other.jobs[0]!.id, idx: 0, startedAt: at(1) },
    };
    expect(followJobSet(run, frame)).toBe(run);
  });

  test("a job that ended stays ended, whatever arrives late", () => {
    let set = followJobSet(run, output(first.id, 0, RESULT));
    set = followJobSet(set, started(first.id, 0));
    set = followJobSet(set, {
      event: "job.queued",
      data: { ...ref(first.id, 0), position: 1 },
    });
    expect(set.jobs[0]).toMatchObject({ status: "succeeded", assetId: RESULT });
    // So does a copy of the run read before it ended.
    const stale = { ...run, jobSet: { ...run.jobSet, status: "running" as const } };
    const ended = followJobSet(set, completed("succeeded"));
    expect(mergeJobSet(ended, stale)).toMatchObject({ jobSet: { status: "succeeded" } });
    expect(statuses(mergeJobSet(ended, stale))).toEqual(["succeeded", "pending"]);
  });

  test("a snapshot that lists the run catches it up", () => {
    const fresh: JobSetWithJobs = {
      ...run,
      jobs: run.jobs.map((j) => ({ ...j, status: "running" as const, startedAt: at(1) })),
    };
    const set = followJobSet(run, {
      event: "snapshot",
      data: { activeJobSets: [fresh], serverTime: at(3), batches: [] },
    });
    expect(statuses(set)).toEqual(["running", "running"]);
  });
});

describe("the follower", () => {
  type Listener = (event: SseEvent) => void;
  const stream = () => {
    const listeners = new Set<Listener>();
    return {
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: (event: SseEvent) => {
        for (const listener of listeners) listener(event);
      },
      get size() {
        return listeners.size;
      },
    };
  };

  test("frames that beat the 202 are kept and applied once it names the run", () => {
    const events = stream();
    const seen: JobSetWithJobs[] = [];
    const following = followRun({ onChange: (s) => seen.push(s), subscribe: events.subscribe });
    events.send({ event: "job_set.created", data: run });
    events.send(started(first.id, 0));
    events.send(output(first.id, 0, RESULT));
    // Another tab's run at the same moment.
    const other = jobSet(at(0), ["pending"]);
    events.send({
      event: "job.output",
      data: { jobSetId: other.jobSet.id, jobId: other.jobs[0]!.id, idx: 0, asset: asset(at(2)) },
    });
    expect(seen).toEqual([]);

    following.accept(run);
    expect(statuses(seen.at(-1)!)).toEqual(["succeeded", "pending"]);
    events.send(failed(second.id, 1));
    events.send(completed("partial"));
    expect(seen.at(-1)).toMatchObject({ jobSet: { status: "partial" } });
    expect(statuses(seen.at(-1)!)).toEqual(["succeeded", "failed"]);
    following.stop();
  });

  test("stopping lets go of the stream", () => {
    const events = stream();
    const seen: JobSetWithJobs[] = [];
    const following = followRun({ onChange: (s) => seen.push(s), subscribe: events.subscribe });
    following.accept(run);
    following.stop();
    expect(events.size).toBe(0);
    events.send(started(first.id, 0));
    following.accept(run);
    expect(seen).toHaveLength(1);
  });

  test("a run that ended while the stream was down is asked for again on reconnect", async () => {
    const events = stream();
    const seen: JobSetWithJobs[] = [];
    const asked: string[] = [];
    const done: JobSetWithJobs = {
      jobSet: { ...run.jobSet, status: "succeeded" },
      jobs: run.jobs.map((j, i) => ({
        ...j,
        status: "succeeded" as const,
        assetId: `${RESULT.slice(0, -1)}${i}`,
      })),
    };
    const following = followRun({
      onChange: (s) => seen.push(s),
      subscribe: events.subscribe,
      fetchJobSet: async (id) => {
        asked.push(id);
        return done;
      },
    });
    following.accept(run);
    // Still running, as the snapshot says: nothing to ask.
    events.send({ event: "snapshot", data: { activeJobSets: [run], serverTime: at(3), batches: [] } });
    expect(asked).toEqual([]);
    events.send({ event: "snapshot", data: { activeJobSets: [], serverTime: at(4), batches: [] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual([run.jobSet.id]);
    expect(seen.at(-1)).toEqual(done);
    following.stop();
  });

  test("a poll that fails leaves the run as it was", async () => {
    const seen: JobSetWithJobs[] = [];
    const following = followRun({
      onChange: (s) => seen.push(s),
      subscribe: stream().subscribe,
      fetchJobSet: () => Promise.reject(new ApiError(0, "network", "offline", true)),
    });
    following.accept(run);
    await following.refresh();
    expect(seen).toEqual([run]);
    following.stop();
  });
});
