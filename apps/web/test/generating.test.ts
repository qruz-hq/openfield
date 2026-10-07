// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CanvasRunState, JobSetState } from "@openfield/core";
import { applyEvent } from "../src/api/events";
import { startDesktopBridge } from "../src/lib/desktop";
import { selectGenerating, useLive } from "../src/lib/live";
import { at, jobSet } from "./fixtures";

// Whether anything is generating, which animates the brand mark and the desktop app's icon.

const generating = () => selectGenerating(useLive.getState());

const snapshot = (activeJobSets: ReturnType<typeof jobSet>[] = []) =>
  applyEvent({ event: "snapshot", data: { activeJobSets, batches: [], serverTime: at(0) } });

const canvasRun = (runId: string, status: JobSetState): CanvasRunState => ({
  runId,
  canvasId: "01K6BQ8000000000000000CCCC",
  scope: "all",
  status,
  createdAt: at(0),
  finishedAt: null,
  nodes: [],
});

beforeEach(() => {
  useLive.getState().setConnected(true);
  snapshot();
});

describe("generating", () => {
  test("a run starts it and finishing that run ends it", () => {
    expect(generating()).toBe(false);
    const run = jobSet(at(0), ["pending"], { status: "pending" });
    applyEvent({ event: "job_set.created", data: run });
    expect(generating()).toBe(true);
    applyEvent({
      event: "job_set.completed",
      data: { jobSetId: run.jobSet.id, status: "succeeded", costActualUsd: null, durationMs: 10 },
    });
    expect(generating()).toBe(false);
  });

  test("with two runs, it lasts until both finish", () => {
    const a = jobSet(at(0), ["running"]);
    const b = jobSet(at(1), ["running"]);
    applyEvent({ event: "job_set.created", data: a });
    applyEvent({ event: "job_set.created", data: b });
    applyEvent({
      event: "job_set.completed",
      data: { jobSetId: a.jobSet.id, status: "failed", costActualUsd: null, durationMs: 10 },
    });
    expect(generating()).toBe(true);
    applyEvent({
      event: "job_set.completed",
      data: { jobSetId: b.jobSet.id, status: "canceled", costActualUsd: null, durationMs: 10 },
    });
    expect(generating()).toBe(false);
  });

  test("the snapshot replaces the list, so a run that ended while offline drops out", () => {
    const gone = jobSet(at(0), ["running"]);
    applyEvent({ event: "job_set.created", data: gone });
    snapshot([]);
    expect(generating()).toBe(false);

    const still = jobSet(at(1), ["running"]);
    const done = jobSet(at(1), ["succeeded"], { status: "succeeded" });
    snapshot([still, done]);
    expect(Object.keys(useLive.getState().activeJobSets)).toEqual([still.jobSet.id]);
    expect(generating()).toBe(true);
  });

  test("a canvas run counts until it settles, and the snapshot clears it", () => {
    applyEvent({ event: "canvas_run.updated", data: canvasRun("01K6BQ8000000000000000RUN1", "running") });
    expect(generating()).toBe(true);
    applyEvent({ event: "canvas_run.updated", data: canvasRun("01K6BQ8000000000000000RUN1", "partial") });
    expect(generating()).toBe(false);

    applyEvent({ event: "canvas_run.updated", data: canvasRun("01K6BQ8000000000000000RUN2", "queued") });
    snapshot();
    expect(generating()).toBe(false);
  });

  test("a Batch run waiting at a company counts", () => {
    useLive.getState().setBatch("01K6BQ8000000000000000BAT1", {
      providerId: "openai",
      state: "running",
      stopping: false,
    });
    expect(generating()).toBe(true);
    useLive.getState().setBatch("01K6BQ8000000000000000BAT1", undefined);
    expect(generating()).toBe(false);
  });

  test("not while the stream is down, since nothing would say when it ends", () => {
    const run = jobSet(at(0), ["running"]);
    applyEvent({ event: "job_set.created", data: run });
    useLive.getState().setConnected(false, true);
    expect(generating()).toBe(false);
    // Back, but what this tab knows is from before the drop until the snapshot lands.
    useLive.getState().setConnected(true);
    expect(generating()).toBe(false);
    snapshot([run]);
    expect(generating()).toBe(true);
  });
});

describe("desktop bridge", () => {
  const g = globalThis as { __TAURI_INTERNALS__?: unknown };
  let calls: unknown[][];
  let stop: () => void = () => {};

  beforeEach(() => {
    calls = [];
    g.__TAURI_INTERNALS__ = {
      invoke: mock((...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      }),
    };
  });
  afterEach(() => {
    stop();
    delete g.__TAURI_INTERNALS__;
  });

  test("tells the app once at start, then only when it flips", () => {
    stop = startDesktopBridge();
    expect(calls).toEqual([["set_generating", { on: false }]]);

    const run = jobSet(at(0), ["running"]);
    applyEvent({ event: "job_set.created", data: run });
    useLive.getState().setPosition("x", 2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["set_generating", { on: true }]);

    applyEvent({
      event: "job_set.completed",
      data: { jobSetId: run.jobSet.id, status: "succeeded", costActualUsd: null, durationMs: 10 },
    });
    expect(calls.at(-1)).toEqual(["set_generating", { on: false }]);
    expect(calls).toHaveLength(3);
  });

  test("says it again once the stream is back and caught up, even when nothing changed", () => {
    stop = startDesktopBridge();
    useLive.getState().setConnected(false, true);
    useLive.getState().setConnected(true);
    expect(calls).toEqual([["set_generating", { on: false }]]);
    snapshot();
    expect(calls).toEqual([
      ["set_generating", { on: false }],
      ["set_generating", { on: false }],
    ]);
  });

  test("keeps the last answer while the stream is down, so quitting still asks first", () => {
    const run = jobSet(at(0), ["running"]);
    applyEvent({ event: "job_set.created", data: run });
    stop = startDesktopBridge();
    expect(calls).toEqual([["set_generating", { on: true }]]);
    useLive.getState().setConnected(false, true);
    // Back with the old list: a run that ended while offline must not flash the icon on again.
    useLive.getState().setConnected(true);
    expect(calls).toHaveLength(1);
    snapshot([]);
    expect(calls).toEqual([
      ["set_generating", { on: true }],
      ["set_generating", { on: false }],
    ]);
  });

  test("a failing or throwing invoke never breaks the page", () => {
    g.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error("no such command")) };
    stop = startDesktopBridge();
    g.__TAURI_INTERNALS__ = {
      invoke: () => {
        throw new Error("boom");
      },
    };
    expect(() => applyEvent({ event: "job_set.created", data: jobSet(at(0), ["running"]) })).not.toThrow();
  });

  test("does nothing in a browser tab", () => {
    delete g.__TAURI_INTERNALS__;
    stop = startDesktopBridge();
    applyEvent({ event: "job_set.created", data: jobSet(at(0), ["running"]) });
    expect(calls).toEqual([]);
  });
});
