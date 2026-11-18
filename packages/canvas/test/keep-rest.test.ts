// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { CanvasNodeResult } from "@openfield/core/canvas";
import { buildEngineContext } from "../src/engine/context-base";
import { deriveDisplay } from "../src/engine/display";
import { evaluateGraph, isRunnable } from "../src/engine/evaluate";
import { planFingerprints, resolveFingerprints } from "../src/engine/fingerprint";
import {
  canReblend,
  editKeepRestOf,
  keepRestBody,
  keptEditsOf,
  onlyKeepRest,
  reblendOps,
  sameKeepRest,
} from "../src/nodes/edit/keep-rest";
import { specRegistry } from "../src/nodes/specs";
import { applyOps, type DocSlice } from "../src/store/ops";
import { banana, docOf, edge, node } from "./fixtures";

// Keep the rest after an Edit node ran: changing only how the rest is kept blends its images again
// for free, so the node stays up to date while the nodes after it go out of date (their image
// changed in place).

const ctx = buildEngineContext(
  [banana],
  { defaultModel: banana.key, defaultBatch: 1, defaultAspect: null },
  undefined,
);

const BASE = "01K6BQ80000000000000BASE01";
const MASK = "01K6BQ80000000000000MASK01";
const OUT = "01K6BQ800000000000000OUT01";
const SAVED = "01K6BQ80000000000000SAVED1";
const NEXT = "01K6BQ80000000000000NEXT01";

const fingerprintsOf = (doc: DocSlice) =>
  resolveFingerprints(planFingerprints(doc, specRegistry, ctx), new Map());

const resultOf = (fingerprint: string, assetIds: string[], inputs: string[]): CanvasNodeResult => ({
  state: "done",
  assetIds,
  jobSetId: null,
  jobSetIds: [],
  outputs: assetIds.map((assetId) => ({ assetId })),
  fingerprint,
  costUsd: null,
  ranAt: null,
  error: null,
  inputs,
});

/** Upload, then Edit, then a Generate reading the Edit's image; the two after the upload have run. */
async function ranGraph(params: Record<string, unknown> = {}): Promise<DocSlice> {
  let doc = docOf(
    [
      node("u", "image.upload", { params: { assetIds: [BASE] } }),
      node("e", "image.edit", {
        params: { prompt: "Pale berries", maskAssetId: MASK, maskFor: BASE, ...params },
      }),
      node("g", "image.generate", { params: { prompt: "Make it night" } }),
    ],
    [edge("e1", "u", "images", "e", "image"), edge("e2", "e", "images", "g", "input_images")],
  );
  let fp = await fingerprintsOf(doc);
  doc = { ...doc, results: { ...doc.results, e: resultOf(fp.e!, [OUT], [BASE, MASK].sort()) } };
  fp = await fingerprintsOf(doc);
  return { ...doc, results: { ...doc.results, g: resultOf(fp.g!, [NEXT], [OUT]) } };
}

async function displays(doc: DocSlice) {
  const fingerprints = await fingerprintsOf(doc);
  const evaluation = evaluateGraph({
    doc,
    registry: specRegistry,
    ctx,
    fingerprints,
    runs: (id) => isRunnable(doc, specRegistry, id),
  });
  const of = (id: string) =>
    deriveDisplay({
      result: doc.results[id] ?? null,
      runtime: undefined,
      fingerprint: fingerprints[id],
      blocker: null,
      fanOut: 1,
      inputsChanged: evaluation.nodes.get(id)?.inputsChanged ?? false,
    });
  return { e: of("e"), g: of("g"), fingerprints, evaluation };
}

describe("Keep the rest after an Edit node ran", () => {
  test("only the settings that decide how the rest is kept count as a free change", () => {
    expect(onlyKeepRest({ sensitivity: 70 })).toBe(true);
    expect(onlyKeepRest({ keepOriginal: false, featherPx: 2 })).toBe(true);
    expect(onlyKeepRest({ sketchKeepOriginal: true })).toBe(true);
    expect(onlyKeepRest({ sensitivity: 70, prompt: "x" })).toBe(false);
    expect(onlyKeepRest({})).toBe(false);
  });

  test("reads the node's settings as the run sends them, and asks the server to keep the rest on", () => {
    expect(editKeepRestOf({ prompt: "x" }, ctx)).toEqual({
      sketch: false,
      keep: true,
      mode: "smart",
      sensitivity: 50,
      expandPx: 4,
      featherPx: 8,
    });
    const sketch = editKeepRestOf({ mode: "sketch", sketchKeepOriginal: true, sensitivity: 80 }, ctx);
    expect(sketch).toMatchObject({ sketch: true, keep: true, sensitivity: 80 });
    expect(editKeepRestOf({ mode: "sketch" }, ctx).keep).toBe(false);
    expect(keepRestBody(sketch)).toEqual({
      keep: true,
      mode: "smart",
      sensitivity: 80,
      expandPx: 4,
      featherPx: 8,
    });
    expect(sameKeepRest(sketch, { ...sketch })).toBe(true);
    expect(sameKeepRest(sketch, { ...sketch, featherPx: 9 })).toBe(false);
  });

  test("a re-blend keeps the Edit node up to date, and the node after it reads Inputs changed", async () => {
    const doc = await ranGraph();
    const before = await displays(doc);
    expect([before.e.state, before.g.state]).toEqual(["done", "done"]);
    expect(canReblend(doc, "e", before.fingerprints.e, false)).toBe(true);

    const ops = await reblendOps(doc, specRegistry, ctx, "e", { sensitivity: 70, featherPx: 2 });
    expect(ops.map((op) => op.op)).toEqual(["setParams", "setResult"]);
    const after = await displays(applyOps(doc, ops).doc);
    expect(after.e).toMatchObject({ state: "done", chip: null });
    expect(after.g).toMatchObject({ state: "stale", chip: "inputs_changed" });

    // Without the result marked, the same change leaves the Edit node itself out of date.
    const plain = await displays(applyOps(doc, [ops[0]!]).doc);
    expect(plain.e.state).toBe("stale");
  });

  test("undo takes the settings and the result's mark back together", async () => {
    const doc = await ranGraph();
    const ops = await reblendOps(doc, specRegistry, ctx, "e", { expandPx: 12 });
    const { doc: next, inverse } = applyOps(doc, ops);
    const back = applyOps(next, inverse).doc;
    const shown = await displays(back);
    expect(shown.e.state).toBe("done");
    expect(back.params.e).toEqual(doc.params.e);
    expect(back.results.e?.fingerprint).toBe(doc.results.e?.fingerprint);
  });

  test("Sensitivity at 50 and the smart way hash as a node without them, so older nodes stay settled", async () => {
    const doc = await ranGraph();
    const fingerprintOf = async (patch: Record<string, unknown>) => {
      const set = (await reblendOps(doc, specRegistry, ctx, "e", patch))[1]!;
      return set.op === "setResult" ? set.result?.fingerprint : null;
    };
    expect(await fingerprintOf({ sensitivity: 50 })).toBe(doc.results.e!.fingerprint);
    expect(await fingerprintOf({ keepRestMode: "smart" })).toBe(doc.results.e!.fingerprint);
    expect(await fingerprintOf({ keepRestMode: "mask" })).not.toBe(doc.results.e!.fingerprint);
  });

  test("the mask-only way goes with the run's keep-the-rest settings", () => {
    expect(editKeepRestOf({ keepRestMode: "mask" }, ctx).mode).toBe("mask");
    expect(editKeepRestOf({ keepRestMode: "other" }, ctx).mode).toBe("smart");
  });

  test("the switch off points the node at the model's own result, each image in its place", async () => {
    const doc = await ranGraph();
    const off = await reblendOps(
      doc,
      specRegistry,
      ctx,
      "e",
      { keepOriginal: false },
      { swap: { assetIds: [SAVED], keptEdits: [OUT] } },
    );
    const next = applyOps(doc, off).doc;
    expect(next.results.e).toMatchObject({
      assetIds: [SAVED],
      outputs: [{ assetId: SAVED, keptEdit: OUT }],
      jobSetId: doc.results.e!.jobSetId,
      costUsd: doc.results.e!.costUsd,
    });
    expect(keptEditsOf(next.results.e!)).toEqual([OUT]);
    const shown = await displays(next);
    expect(shown.e.state).toBe("done");
    expect(shown.g.chip).toBe("inputs_changed");

    // The node after it runs again on the model's result.
    const fp = (await displays(next)).fingerprints;
    const rerun = { ...next, results: { ...next.results, g: resultOf(fp.g!, [NEXT], [SAVED]) } };
    expect((await displays(rerun)).g.state).toBe("done");

    // On again: back to the same kept edit, still done, and what reads it out of date once more.
    const on = await reblendOps(
      rerun,
      specRegistry,
      ctx,
      "e",
      { keepOriginal: true },
      { swap: { assetIds: [OUT] } },
    );
    const back = applyOps(rerun, on).doc;
    expect(back.results.e).toMatchObject({ assetIds: [OUT], outputs: [{ assetId: OUT }] });
    expect(back.results.e!.outputs[0]).not.toHaveProperty("keptEdit");
    expect(back.results.e!.fingerprint).toBe(doc.results.e!.fingerprint);
    const again = await displays(back);
    expect(again.e.state).toBe("done");
    expect(again.g).toMatchObject({ state: "stale", chip: "inputs_changed" });
  });

  test("a node that's out of date, locked, not an edit, or without images waits for its Run", async () => {
    const doc = await ranGraph();
    const { fingerprints } = await displays(doc);
    expect(canReblend(doc, "e", fingerprints.e, true)).toBe(false);
    expect(canReblend(doc, "e", "another", false)).toBe(false);
    expect(canReblend(doc, "g", fingerprints.g, false)).toBe(false);
    const locked = applyOps(doc, [{ op: "setLocked", id: "e", locked: true }]).doc;
    expect(canReblend(locked, "e", fingerprints.e, false)).toBe(false);
    const empty = applyOps(doc, [{ op: "setResult", id: "e", result: null }]).doc;
    expect(canReblend(empty, "e", fingerprints.e, false)).toBe(false);
  });
});
