// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { canvasRunPlanItemSchema, type ModelListItem } from "@openfield/core";
import { type CanvasNodeResult, canvasEditsSchema } from "@openfield/core/canvas";
import { estimate } from "@openfield/providers/manifest";
import { compileEdits, EditError } from "../src/edits/compile";
import { compileRun } from "../src/engine/compile";
import { buildEngineContext } from "../src/engine/context-base";
import { ZERO_COST } from "../src/engine/cost";
import { evaluateGraph, isRunnable } from "../src/engine/evaluate";
import { planFingerprints, resolveFingerprints } from "../src/engine/fingerprint";
import { imagesOf, planValue, STANDING_BLOCKERS } from "../src/engine/inputs";
import { limitProblem } from "../src/nodes/limits";
import { createNodeRegistry, type NodeSpec } from "../src/nodes/registry";
import { DATA_SPECS, specRegistry } from "../src/nodes/specs";
import type { DocSlice } from "../src/store/ops";
import { banana, counters, docOf, edge, node } from "./fixtures";

// The Edit node (image.edit, design nRuORN2ZyA): an image in, a mask painted in the node or
// connected, words, and the run it compiles. The server decides the op and keeps the original
// outside the mask; these check the plan asks it the same way the detail view's Edit tab does, and
// that a finished edit stays up to date instead of running (and billing) again.

/** A model that takes a mask itself (GPT Image's inpaint). Banana only redraws the whole image. */
const painter: ModelListItem = {
  ...banana,
  key: "openai:painter",
  providerId: "openai",
  modelId: "painter",
  displayName: "Painter",
  capabilities: { ...banana.capabilities, ops: { ...banana.capabilities.ops, inpaint: true } },
};
const textOnly: ModelListItem = {
  ...banana,
  key: "google:words",
  modelId: "words",
  capabilities: { ...banana.capabilities, ops: { ...banana.capabilities.ops, imageEdit: false } },
};
const ctx = buildEngineContext(
  [banana, painter, textOnly],
  { defaultModel: banana.key, defaultBatch: 1, defaultAspect: null },
  undefined,
);

const BASE = "01K6BQ80000000000000BASE01";
const OTHER = "01K6BQ80000000000000BASE02";
const MASK = "01K6BQ80000000000000MASK01";
const WIRED = "01K6BQ80000000000000MASK02";
const OUT = "01K6BQ800000000000000OUT01";

const upload = (id: string, assetIds: string[]) => node(id, "image.upload", { params: { assetIds } });
const editNode = (params: Record<string, unknown> = {}, extra = {}) =>
  node("e", "image.edit", {
    params: { prompt: "Make the berries pale", maskAssetId: MASK, maskFor: BASE, ...params },
    ...extra,
  });
/** An upload of the base, wired into the Edit node's image. */
const painted = (params: Record<string, unknown> = {}, base = [BASE]) =>
  docOf([upload("u", base), editNode(params)], [edge("e1", "u", "images", "e", "image")]);

const fingerprintsOf = (doc: DocSlice) =>
  resolveFingerprints(planFingerprints(doc, specRegistry, ctx), new Map());

async function compile(doc: DocSlice) {
  const out = compileRun({
    doc,
    registry: specRegistry,
    ctx,
    fingerprints: await fingerprintsOf(doc),
    request: { scope: "all", nodeIds: [] },
  });
  if (out.kind !== "plan") throw new Error(out.kind);
  return out;
}

async function evaluate(doc: DocSlice) {
  const evaluation = evaluateGraph({
    doc,
    registry: specRegistry,
    ctx,
    fingerprints: await fingerprintsOf(doc),
    runs: (id) => isRunnable(doc, specRegistry, id),
  });
  return evaluation.nodes;
}

/** The doc after a run of `id` that read `inputs`, as the server saves it. */
async function ran(doc: DocSlice, id: string, inputs: string[], assetIds = [OUT]): Promise<DocSlice> {
  const result: CanvasNodeResult = {
    state: "done",
    assetIds,
    jobSetId: null,
    jobSetIds: [],
    outputs: [],
    fingerprint: (await fingerprintsOf(doc))[id]!,
    costUsd: null,
    ranAt: null,
    error: null,
    inputs: [...inputs].sort(),
  };
  return { ...doc, results: { ...doc.results, [id]: result } };
}

describe("the Edit node", () => {
  test("ports: the image, a mask, words and references in, images out", () => {
    const ports = specRegistry.ports("image.edit").map((p) => [p.id, p.direction, p.type, p.arity]);
    expect(ports).toEqual([
      ["image", "in", "image", "single"],
      ["mask", "in", "mask", "single"],
      ["prompt", "in", "text", "single"],
      ["input_images", "in", "image", "multi"],
      ["images", "out", "image", "single"],
    ]);
    expect(specRegistry.port("image.edit", "image")).toMatchObject({
      required: true,
      binding: { to: "base" },
    });
  });

  test("sits after Generate in the menu, and starts on a model that takes a mask, keeping the rest", () => {
    const image = specRegistry.menu(ctx).find((g) => g.group === "image");
    expect(image?.items.map((i) => i.type)).toEqual(["image.generate", "image.edit", "image.variations"]);
    const made = specRegistry.instantiate("image.edit", { position: { x: 0, y: 0 }, ctx });
    expect(made.params).toEqual({
      model: painter.key,
      prompt: "",
      keepOriginal: true,
      featherPx: 8,
      expandPx: 4,
      batch: 1,
      seed: { mode: "random" },
      providerOptions: {},
    });
    // Nothing that can edit, nothing to list.
    const none = buildEngineContext([textOnly], undefined, undefined);
    expect(specRegistry.menu(none).flatMap((g) => g.items.map((i) => i.type))).not.toContain("image.edit");
  });

  test("compiles an inpaint with the painted mask and its keep-the-rest settings", async () => {
    const doc = docOf(
      [
        node("p", "prompt", { params: { text: "Dried berries" } }),
        upload("u", [BASE]),
        editNode({ model: painter.key, prompt: "Keep the stems", batch: 2, featherPx: 12 }),
      ],
      [edge("e1", "p", "text", "e", "prompt"), edge("e2", "u", "images", "e", "image")],
    );
    const out = await compile(doc);
    const compiled = out.items.find((i) => i.item.nodeId === "e")!;
    expect(compiled.item.calls).toEqual([
      {
        model: painter.key,
        op: "inpaint",
        prompt: "Dried berries\nKeep the stems",
        // The server asks for the base's own shape, at the tier the chip shows.
        size: { kind: "auto" },
        resolution: "1K",
        batch: 2,
        seed: null,
        mask: { composite: true, expandPx: 4, featherPx: 12 },
      },
    ]);
    expect(compiled.item.inputs).toEqual([
      { port: "image", to: "base", arity: "single", values: [{ kind: "asset", assetId: BASE }] },
      { port: "mask", to: "mask", arity: "single", values: [{ kind: "asset", assetId: MASK }] },
    ]);
    expect([compiled.fanOut, compiled.expectedJobs]).toEqual([1, 2]);
    expect(canvasRunPlanItemSchema.safeParse(compiled.item).success).toBe(true);
  });

  test("on a model without a mask input, a whole-image edit that still sends the mask to keep the rest", async () => {
    const out = await compile(painted({ model: banana.key }));
    const compiled = out.items[0]!;
    const call = compiled.item.calls[0]!;
    expect(call.op).toBe("edit");
    expect(call.mask).toEqual({ composite: true, expandPx: 4, featherPx: 8 });
    expect(compiled.item.inputs.map((i) => i.port)).toEqual(["image", "mask"]);
    // One job per image, priced as the server prices the plan: the base is billed as an image sent
    // in, the mask never is.
    expect(compiled.fanOut).toBe(1);
    expect(compiled.estimate).toEqual(
      estimate(banana, { op: "edit", batch: 1, prompt: call.prompt, resolution: "1K", inputImages: 1 }),
    );

    // Off, the mask still goes along with the run, which then keeps the model's image as it is.
    const off = await compile(painted({ model: banana.key, keepOriginal: false }));
    expect(off.items[0]!.item.calls[0]!.mask).toEqual({ composite: false, expandPx: 4, featherPx: 8 });
  });

  test("with approximate area edits off, a whole-image model waits and edits start on one that takes a mask", async () => {
    const strict = buildEngineContext(
      [banana, painter],
      { defaultModel: banana.key, defaultBatch: 1, defaultAspect: null, regionalFallback: false },
      undefined,
    );
    const doc = painted({ model: banana.key });
    const evaluation = evaluateGraph({
      doc,
      registry: specRegistry,
      ctx: strict,
      fingerprints: await fingerprintsOf(doc),
      runs: () => true,
    });
    const e = evaluation.nodes.get("e")!;
    // Said up front, with no plan or job: the server would refuse it at launch.
    expect(e.blocker).toEqual({ kind: "area_edit_off", model: banana.key, name: banana.displayName });
    expect(STANDING_BLOCKERS.has("area_edit_off")).toBe(true);
    expect(e.compiled).toBeNull();
    // Only a model that takes the mask itself is picked for a new Edit node, even one with no key yet.
    const settings = { defaultModel: banana.key, defaultBatch: 1, defaultAspect: null };
    const noKey = { ...painter, ready: false };
    expect(buildEngineContext([banana, noKey], settings, undefined).defaultEditModel).toBe(banana.key);
    expect(
      buildEngineContext([banana, noKey], { ...settings, regionalFallback: false }, undefined)
        .defaultEditModel,
    ).toBe(painter.key);
    expect(buildEngineContext([banana], settings, undefined).regionalFallback).toBe(true);
  });

  test("a mask on the Mask input is used instead of the painted one", async () => {
    // Painted on another image, which doesn't matter once a mask is connected.
    const doc = docOf(
      [upload("u", [BASE]), upload("m", [WIRED]), editNode({ maskFor: OTHER })],
      [edge("e1", "u", "images", "e", "image"), edge("e2", "m", "images", "e", "mask")],
    );
    const out = await compile(doc);
    expect(out.blocked).toEqual({});
    expect(out.items[0]!.item.inputs[1]).toEqual({
      port: "mask",
      to: "mask",
      arity: "single",
      values: [{ kind: "asset", assetId: WIRED }],
    });
    // Disconnected, the painted one is back.
    const alone = await compile(docOf([upload("m", [WIRED]), editNode({ maskFor: null })]));
    expect(alone.blocked.e).toEqual({ kind: "missing_input", port: "image" });
    const painted = await compile(
      docOf([upload("u", [BASE]), editNode({ maskFor: null })], [edge("e1", "u", "images", "e", "image")]),
    );
    expect(painted.items[0]!.item.inputs[1]!.values).toEqual([{ kind: "asset", assetId: MASK }]);
  });

  test("a mask painted on another image says so, and isn't sent", async () => {
    const stale = await evaluate(painted({}, [OTHER]));
    const e = stale.get("e")!;
    expect(e.blocker).toEqual({ kind: "mask_stale" });
    // Shown right away, not only once a run tried.
    expect(STANDING_BLOCKERS.has("mask_stale")).toBe(true);
    // Still priced, but without the mask.
    expect(e.estimate).not.toBeNull();
    expect(e.compiled).toBeNull();
    // A list fits no painted mask: it was painted on one image, and can't be painted again over several.
    expect((await evaluate(painted({}, [BASE, OTHER]))).get("e")!.blocker).toEqual({
      kind: "mask_stale",
      several: true,
    });

    // From a Generate node: the image it has now, whether or not it runs again.
    const generated = () =>
      docOf(
        [
          node("g", "image.generate", { params: { prompt: "Vases", model: banana.key } }),
          editNode({ model: painter.key }),
        ],
        [edge("e1", "g", "images", "e", "image")],
      );
    const before = await ran(generated(), "g", [], [BASE]);
    expect((await evaluate(before)).get("e")!.blocker).toBeNull();
    const after = await ran(generated(), "g", [], [OTHER]);
    expect((await evaluate(after)).get("e")!.blocker).toEqual({ kind: "mask_stale" });
  });

  test("blocks without an image, a mask or words, and on a model that can't edit", async () => {
    const blocked = async (doc: DocSlice) => (await compile(doc)).blocked.e;
    expect(await blocked(docOf([editNode()]))).toEqual({ kind: "missing_input", port: "image" });
    expect(await blocked(painted({ maskAssetId: null, maskFor: null }))).toEqual({ kind: "no_mask" });
    expect(await blocked(painted({ prompt: "" }))).toEqual({ kind: "no_description" });
    expect(await blocked(painted({ model: textOnly.key }))).toEqual({
      kind: "model_unavailable",
      model: textOnly.key,
    });
    // A painted mask that isn't in this library (an imported canvas) is never sent.
    const doc = painted();
    const missing = evaluateGraph({
      doc,
      registry: specRegistry,
      ctx: { ...ctx, missing: new Set([MASK]) },
      fingerprints: await fingerprintsOf(doc),
      runs: () => true,
    });
    expect(missing.nodes.get("e")!.blocker).toEqual({ kind: "missing_asset" });
  });

  test("its fingerprint follows the mask and how the rest is kept, and nothing else", async () => {
    const fp = async (params: Record<string, unknown>) => (await fingerprintsOf(painted(params))).e;
    const plain = await fp({});
    // Unset and set to the defaults are the same node.
    expect(await fp({ keepOriginal: true, featherPx: 8, expandPx: 4, resolution: "1K", batch: 1 })).toBe(
      plain,
    );
    // Where the mask was painted is metadata; the image itself counts through its own node.
    expect(await fp({ maskFor: OTHER })).toBe(plain);
    for (const change of [
      { maskAssetId: WIRED },
      { keepOriginal: false },
      { featherPx: 9 },
      { expandPx: 0 },
      { prompt: "Other words" },
      { model: banana.key },
    ]) {
      expect(await fp(change)).not.toBe(plain);
    }
    // With the rest not kept, growing and softening the mask change nothing.
    expect(await fp({ keepOriginal: false, featherPx: 20 })).toBe(await fp({ keepOriginal: false }));
  });

  test("a painted mask counts only while it's used: not while a mask is wired in", async () => {
    const wired = (params: Record<string, unknown>) =>
      docOf(
        [upload("u", [BASE]), upload("m", [WIRED]), editNode(params)],
        [edge("e1", "u", "images", "e", "image"), edge("e2", "m", "images", "e", "mask")],
      );
    const fp = async (params: Record<string, unknown>) => (await fingerprintsOf(wired(params))).e;
    const kept = await fp({});
    expect(await fp({ maskAssetId: undefined, maskFor: undefined })).toBe(kept);
    expect(await fp({ maskAssetId: OTHER })).toBe(kept);
    // So taking the unused one off keeps a finished run up to date (an agent's set_node_mask null).
    const done = await ran(wired({}), "e", [BASE, WIRED]);
    const cleared = { ...done, params: { ...done.params, e: { ...done.params.e, maskAssetId: undefined } } };
    expect((await evaluate(cleared)).get("e")!.upToDate).toBe(true);
  });

  test("a finished edit stays up to date: the mask it read counts, painted or connected", async () => {
    // The server records the base and the mask a run sent (canvas runs.ts).
    const done = await ran(painted(), "e", [BASE, MASK]);
    const e = (await evaluate(done)).get("e")!;
    expect([e.upToDate, e.inputsChanged]).toEqual([true, false]);
    expect((await compile(done)).upToDate).toEqual(["e"]);

    const wired = docOf(
      [upload("u", [BASE]), upload("m", [WIRED]), editNode()],
      [edge("e1", "u", "images", "e", "image"), edge("e2", "m", "images", "e", "mask")],
    );
    const wiredDone = (await evaluate(await ran(wired, "e", [BASE, WIRED]))).get("e")!;
    expect([wiredDone.upToDate, wiredDone.inputsChanged]).toEqual([true, false]);

    // A new image coming in is a change, as anywhere else.
    const moved = await ran(painted(), "e", [OTHER, MASK]);
    expect((await evaluate(moved)).get("e")!.inputsChanged).toBe(true);
  });

  test("after a Generate node that's up to date, an edit of its image stays up to date too", async () => {
    let doc = docOf(
      [node("g", "image.generate", { params: { prompt: "Vases", model: banana.key } }), editNode()],
      [edge("e1", "g", "images", "e", "image")],
    );
    doc = await ran(doc, "g", [], [BASE]);
    doc = await ran(doc, "e", [BASE, MASK]);
    const nodes = await evaluate(doc);
    expect(nodes.get("g")!.upToDate).toBe(true);
    expect([nodes.get("e")!.upToDate, nodes.get("e")!.inputsChanged]).toEqual([true, false]);
  });

  test("agents can add one, within its limits", () => {
    const out = compileEdits(
      docOf([]),
      canvasEditsSchema.parse([
        { op: "add_node", type: "image.edit", params: { maskAssetId: MASK, maskFor: BASE, featherPx: 16 } },
      ]),
      { specs: specRegistry, ctx, ...counters() },
    );
    expect(out.doc.params.n_1).toMatchObject({ maskAssetId: MASK, maskFor: BASE, featherPx: 16 });
    expect(() =>
      compileEdits(
        docOf([]),
        canvasEditsSchema.parse([{ op: "add_node", type: "image.edit", params: { featherPx: 40 } }]),
        { specs: specRegistry, ctx, ...counters() },
      ),
    ).toThrow(EditError);
    expect(limitProblem("image.edit", { prompt: "x".repeat(32_001) })).toMatch(
      /Edit prompt.*at most 32,?000/,
    );
  });
});

describe("what a node reads", () => {
  // A node that takes images on two inputs but sends only the first: only what it sends can put
  // it out of date, the way the server records what a run read.
  const holdsBack: NodeSpec = {
    ...(specRegistry.get("image.generate") as NodeSpec),
    type: "image.upscale",
    menu: null,
    ports: [
      { id: "image", direction: "in", type: "image", arity: "single", items: "one", required: false },
      { id: "extra", direction: "in", type: "image", arity: "single", items: "one", required: false },
      { id: "images", direction: "out", type: "image", arity: "single", items: "list", required: false },
    ],
    defaults: () => ({}),
    parseParams: () => ({}),
    engine: {
      fingerprintParams: () => ({ params: {}, model: banana.key, manifestVersion: "1", cacheable: true }),
      outputs: (n) => ({ images: (n.result?.assetIds ?? []).map((assetId) => ({ kind: "asset", assetId })) }),
      blocker: () => null,
      compile: (n, inputs, _ctx, fingerprint) => ({
        ok: true,
        node: {
          item: {
            nodeId: n.id,
            type: n.type,
            typeVersion: 1,
            fingerprint,
            model: banana.key,
            params: {},
            inputs: [
              {
                port: "image",
                to: "base",
                arity: "single",
                values: imagesOf(inputs, "image").map(planValue),
              },
            ],
            calls: [],
            cached: null,
          },
          expectedJobs: 1,
          estimate: ZERO_COST,
          fanOut: 1,
        },
      }),
    },
  };
  const registry = createNodeRegistry([...DATA_SPECS, holdsBack] as NodeSpec[]);

  test("an image a node doesn't send can't put it out of date", async () => {
    let doc = docOf(
      [upload("a", [BASE]), upload("b", [OTHER]), node("x", "image.upscale")],
      [edge("e1", "a", "images", "x", "image"), edge("e2", "b", "images", "x", "extra")],
    );
    const fingerprints = await resolveFingerprints(planFingerprints(doc, registry, ctx), new Map());
    doc = {
      ...doc,
      results: {
        x: {
          state: "done",
          assetIds: [OUT],
          jobSetId: null,
          jobSetIds: [],
          outputs: [],
          fingerprint: fingerprints.x!,
          costUsd: null,
          ranAt: null,
          error: null,
          inputs: [BASE],
        },
      },
    };
    const x = evaluateGraph({ doc, registry, ctx, fingerprints, runs: () => true }).nodes.get("x")!;
    expect([x.upToDate, x.inputsChanged]).toEqual([true, false]);
  });
});
