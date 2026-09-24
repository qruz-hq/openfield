// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  canvasNodeResultSchema,
  canvasRunRecordSchema,
  freeEstimate,
  resultOfRunNode,
  scaleCostEstimate,
  sumCostEstimates,
} from "../src/canvas";
import { CANVAS_RUN_MAX_JOBS } from "../src/constants";
import { newId } from "../src/ids";
import {
  type CanvasRunState,
  type CostEstimate,
  canvasRunBodySchema,
  canvasRunStateSchema,
  canvasSummarySchema,
  parseSseFrame,
} from "../src/schemas";

// The canvas wire contracts (§8.3): the run body the browser compiles, the run state
// the server streams, and the one rule for adding estimates up.

const HASH = `sha256:${"a".repeat(64)}`;

const planItem = {
  nodeId: "n_gen",
  type: "image.generate",
  typeVersion: 1,
  fingerprint: HASH,
  model: "google:gemini-3-pro-image",
  params: { prompt: "", batch: 4 },
  inputs: [
    {
      port: "input_images",
      to: "references",
      role: "subject",
      arity: "multi",
      values: [
        { kind: "asset", assetId: newId() },
        { kind: "node", nodeId: "n_gen0", port: "images" },
      ],
    },
  ],
  calls: [
    {
      model: "google:gemini-3-pro-image",
      op: "generate",
      prompt: "Lighthouse at dusk\nlong exposure",
      size: { kind: "aspect", ratio: "3:4" },
      resolution: "2K",
      batch: 4,
      seed: null,
      label: "Line one",
    },
  ],
  cached: { fingerprint: HASH, assetIds: [newId()] },
  bypassCache: false,
};

describe("run body", () => {
  test("takes the plan as the browser compiles it", () => {
    const body = canvasRunBodySchema.parse({
      scope: "all",
      nodeIds: ["n_gen"],
      plan: [planItem],
      confirmed: true,
    });
    expect(body.plan[0]!.calls[0]).toMatchObject({ op: "generate", seed: null, label: "Line one" });
  });

  test("refuses what a plan can't hold", () => {
    const bad = (patch: Record<string, unknown>) =>
      canvasRunBodySchema.safeParse({ scope: "all", nodeIds: [], plan: [{ ...planItem, ...patch }] }).success;
    expect(bad({ fingerprint: "abc" })).toBe(false);
    expect(bad({ calls: [] })).toBe(false);
    expect(bad({ nodeId: "has spaces" })).toBe(false);
    expect(bad({ calls: [{ ...planItem.calls[0], op: "upscale" }] })).toBe(false);
    expect(bad({ calls: [{ ...planItem.calls[0], batch: 5 }] })).toBe(false);
    expect(canvasRunBodySchema.safeParse({ scope: "all", nodeIds: [], plan: [] }).success).toBe(false);
  });

  test("carries every image a run can make, so a big fan-out still runs again or feeds the next node", () => {
    const many = Array.from({ length: 72 }, () => newId());
    const body = canvasRunBodySchema.safeParse({
      scope: "all",
      nodeIds: [],
      plan: [
        {
          ...planItem,
          cached: { fingerprint: HASH, assetIds: many },
          inputs: [{ ...planItem.inputs[0], values: many.map((assetId) => ({ kind: "asset", assetId })) }],
        },
      ],
    });
    expect(body.success).toBe(true);
    const over = Array.from({ length: CANVAS_RUN_MAX_JOBS + 1 }, () => newId());
    expect(
      canvasRunBodySchema.safeParse({
        scope: "all",
        nodeIds: [],
        plan: [{ ...planItem, cached: { fingerprint: HASH, assetIds: over } }],
      }).success,
    ).toBe(false);
  });
});

describe("node results", () => {
  test("documents saved before jobSetIds, outputs and error still read", () => {
    const old = canvasNodeResultSchema.parse({
      state: "done",
      assetIds: [],
      jobSetId: null,
      fingerprint: null,
      costUsd: null,
      ranAt: null,
    });
    expect(old).toMatchObject({ jobSetIds: [], outputs: [], error: null });
    expect(old.inputs).toBeUndefined();
  });

  test("a run node settles into the result every tab writes; one canceled before it started, none", () => {
    const node = {
      nodeId: "n_gen",
      state: "done" as const,
      fingerprint: HASH,
      jobSetIds: [newId()],
      done: 1,
      total: 1,
      assetIds: [newId()],
      outputs: [],
      inputs: [newId()],
      costUsd: 0.04,
      error: null,
      blocked: null,
      startedAt: null,
      finishedAt: "2026-09-24T10:00:00.000Z",
    };
    expect(resultOfRunNode(node, "2026-09-24T11:00:00.000Z")).toMatchObject({
      state: "done",
      ranAt: "2026-09-24T10:00:00.000Z",
      inputs: node.inputs,
      jobSetId: node.jobSetIds[0],
    });
    expect(resultOfRunNode({ ...node, state: "canceled", jobSetIds: [], assetIds: [] }, "x")).toBeNull();
    expect(resultOfRunNode({ ...node, state: "cached" }, "x")).toBeNull();
  });

  test("a cancel or a failure that made nothing leaves the images a node had", () => {
    const node = {
      nodeId: "n_gen",
      state: "canceled" as const,
      fingerprint: HASH,
      jobSetIds: [newId()],
      done: 0,
      total: 2,
      assetIds: [],
      outputs: [],
      inputs: [],
      costUsd: null,
      error: null,
      blocked: null,
      startedAt: null,
      finishedAt: "2026-09-24T10:00:00.000Z",
    };
    const had = canvasNodeResultSchema.parse({
      state: "done",
      assetIds: [newId(), newId()],
      jobSetId: null,
      fingerprint: HASH,
      costUsd: 0.08,
      ranAt: "2026-09-24T09:00:00.000Z",
      inputs: [newId()],
    });
    // Its job set existed, but nothing came of it: the run changed nothing.
    expect(resultOfRunNode(node, "x", had)).toBeNull();
    const error = { code: "provider_error" as const };
    const failed = resultOfRunNode({ ...node, state: "failed", error }, "x", had);
    expect(failed).toMatchObject({ state: "failed", error, assetIds: had.assetIds, inputs: had.inputs });
    expect(failed?.jobSetIds).toEqual(node.jobSetIds);
    // With nothing to keep, the failure stands alone.
    expect(resultOfRunNode({ ...node, state: "failed", error }, "x", null)?.assetIds).toEqual([]);
  });
});

describe("run state", () => {
  const state: CanvasRunState = {
    runId: newId(),
    canvasId: newId(),
    scope: "all",
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    nodes: [
      {
        nodeId: "n_gen",
        state: "running",
        fingerprint: HASH,
        jobSetIds: [newId()],
        done: 1,
        total: 4,
        assetIds: [],
        outputs: [{ assetId: newId(), model: "google:gemini-3-pro-image", call: 0, source: 0 }],
        inputs: [newId()],
        costUsd: null,
        error: null,
        blocked: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    ],
  };

  test("canvas_run.updated carries the whole run", () => {
    const frame = parseSseFrame("canvas_run.updated", JSON.stringify(state));
    expect(frame?.event).toBe("canvas_run.updated");
    expect(canvasRunStateSchema.parse(frame?.data)).toEqual(state);
  });

  test("the stored run record fills its bookkeeping defaults", () => {
    const record = canvasRunRecordSchema.parse({ nodeIds: [], items: [planItem] });
    expect(record).toMatchObject({ launches: [], canceled: false });
  });

  test("an index card says how many nodes it has and its version", () => {
    expect(
      canvasSummarySchema.safeParse({
        id: newId(),
        name: "Untitled",
        previewUrl: null,
        createdAt: state.createdAt,
        updatedAt: state.createdAt,
        nodeCount: 0,
        coverAssetId: null,
        graphVersion: 1,
      }).success,
    ).toBe(true);
  });
});

describe("adding estimates up", () => {
  const est = (
    min: number,
    max: number,
    confidence: CostEstimate["confidence"],
    pricedAt = "2026-09-01",
  ) => ({
    currency: "USD",
    min,
    max,
    confidence,
    basis: `${min}`,
    pricedAt,
  });

  test("nothing to run is free", () => {
    expect(sumCostEstimates([])).toEqual(freeEstimate());
  });

  test("exact only when every part is exact; unknown parts are left out of the amounts", () => {
    expect(sumCostEstimates([est(0.1, 0.1, "exact"), est(0.2, 0.2, "exact")])).toMatchObject({
      min: 0.3,
      max: 0.3,
      confidence: "exact",
    });
    const mixed = sumCostEstimates([
      est(0.1, 0.1, "exact"),
      est(0.05, 0.2, "estimated"),
      est(0, 0, "unknown"),
    ]);
    expect(mixed).toMatchObject({ min: 0.15, max: 0.3, confidence: "estimated" });
    expect(sumCostEstimates([est(0, 0, "exact"), est(0, 0, "unknown")]).confidence).toBe("estimated");
    expect(sumCostEstimates([est(0, 0, "unknown")]).confidence).toBe("unknown");
  });

  test("the oldest price date wins, and a fan-out multiplies", () => {
    expect(
      sumCostEstimates([est(1, 1, "exact", "2026-09-10"), est(1, 1, "exact", "2026-08-01")]).pricedAt,
    ).toBe("2026-08-01");
    expect(scaleCostEstimate(est(0.134, 0.134, "exact"), 3)).toMatchObject({ min: 0.402, max: 0.402 });
  });
});
