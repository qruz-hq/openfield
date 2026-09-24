// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { type CanvasRunBody, HASH_RE, type ModelListItem } from "@openfield/core";
import {
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeResult,
  freeEstimate,
} from "@openfield/core/canvas";
import { analyzeGraph } from "../src/canvas/engine/analysis";
import { compileRun } from "../src/canvas/engine/compile";
import { checkConnection } from "../src/canvas/engine/connect";
import { buildEngineContext } from "../src/canvas/engine/context-base";
import { deriveDisplay, visibleBlocker } from "../src/canvas/engine/display";
import { useEngineStore } from "../src/canvas/engine/engine-store";
import {
  type FingerprintCache,
  knownFingerprints,
  planFingerprints,
  resolveFingerprints,
} from "../src/canvas/engine/fingerprint";
import { createFollower } from "../src/canvas/engine/follow";
import { buildPreview } from "../src/canvas/engine/preview";
import { createRunController } from "../src/canvas/engine/run-controller";
import type { EngineContext, NodeRuntime, RunNodeState, RunState } from "../src/canvas/engine/types";
import { idleRuntime } from "../src/canvas/engine/types";
import { createNodeRegistry, type NodeDefinition } from "../src/canvas/nodes/registry";
import { nodeSpeed } from "../src/canvas/nodes/shell/speed";
import { DATA_SPECS } from "../src/canvas/nodes/specs";
import {
  applyOps,
  type CanvasOp,
  createCanvasStore,
  type DocSlice,
  emptyDocument,
  fromDocument,
} from "../src/canvas/store";
import { banana, flare, pro, speedSettings } from "./fixtures";

const registry = createNodeRegistry(
  DATA_SPECS.map((spec) => ({ ...spec, Component: () => null }) as unknown as NodeDefinition),
);

const models: ModelListItem[] = [
  banana,
  { ...flare, ready: true, key: "openai:flare" },
  { ...banana, key: "google:locked", modelId: "locked", displayName: "Locked", ready: false },
];
const ctx: EngineContext = {
  models,
  model: (key) => models.find((m) => m.key === key),
  defaultModel: "google:banana",
};

const ULID = (n: number) => `01K6BQ80000000000000AS${String(n).padStart(4, "0")}`;

const node = (id: string, type: CanvasNode["type"], params: Record<string, unknown> = {}): CanvasNode => ({
  id,
  type,
  typeVersion: 1,
  position: { x: 0, y: 0 },
  parentId: null,
  collapsed: false,
  title: null,
  params,
  presetLocks: [],
  result: null,
});

let edgeCount = 0;
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): CanvasEdge => ({
  id: `e_${edgeCount++}`,
  source,
  sourceHandle,
  target,
  targetHandle,
  kind: "data",
});

function docOf(nodes: CanvasNode[], edges: CanvasEdge[] = []): DocSlice {
  const doc = { ...emptyDocument("01K6BQ8000000000000000CNVS", "Test"), nodes, edges };
  return fromDocument(doc).slice;
}

const apply = (doc: DocSlice, ...ops: CanvasOp[]) => applyOps(doc, ops).doc;

async function fingerprintsOf(doc: DocSlice, cache: FingerprintCache = new Map()) {
  return resolveFingerprints(planFingerprints(doc, registry, ctx), cache);
}

/** Prompt → Generate (batch 4) → Variations (New takes, 4). */
function chain(): DocSlice {
  return docOf(
    [
      node("p", "prompt", { text: "Lighthouse at dusk" }),
      node("g", "image.generate", { model: "google:banana", prompt: "long exposure", batch: 4 }),
      node("v", "image.variations", { strategy: "same-prompt", count: 4 }),
    ],
    [edge("p", "text", "g", "prompt"), edge("g", "images", "v", "image")],
  );
}

/** What a finished run writes into the document. `inputs`: the images it read. */
function done(fingerprint: string, count: number, base = 0, inputs?: string[]): CanvasNodeResult {
  return {
    state: "done",
    assetIds: Array.from({ length: count }, (_, i) => ULID(base + i)),
    jobSetId: null,
    jobSetIds: [],
    outputs: [],
    fingerprint,
    costUsd: null,
    ranAt: null,
    error: null,
    ...(inputs && { inputs: [...inputs].sort() }),
  };
}

const ids = (count: number, base = 0) => Array.from({ length: count }, (_, i) => ULID(base + i));

describe("compiler", () => {
  test("compiles a chain upstream first, with the prompt joined and later nodes pointing back", async () => {
    const doc = chain();
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items.map((i) => i.item.nodeId)).toEqual(["g", "v"]);

    const generate = out.items[0]!.item;
    expect(generate.fingerprint).toMatch(HASH_RE);
    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0]).toMatchObject({ model: "google:banana", op: "generate", batch: 4, seed: null });
    expect(generate.calls[0]!.prompt).toBe("Lighthouse at dusk\nlong exposure");

    const variations = out.items[1]!.item;
    expect(variations.inputs).toEqual([
      {
        port: "image",
        to: "references",
        role: "subject",
        arity: "single",
        values: [{ kind: "node", nodeId: "g", port: "images" }],
      },
    ]);
    // New takes reuse the words that made the incoming image.
    expect(
      variations.calls.every((c) => c.op === "variation" && c.prompt === "Lighthouse at dusk\nlong exposure"),
    ).toBe(true);
    expect(out.jobs).toBe(4 + 4 * 4);
  });

  test("refuses a graph with a loop", async () => {
    const doc = docOf(
      [node("a", "image.generate", { prompt: "a" }), node("b", "image.variations", {})],
      [edge("a", "images", "b", "image"), edge("b", "images", "a", "input_images")],
    );
    const out = compileRun({ doc, registry, ctx, fingerprints: {}, request: { scope: "all", nodeIds: [] } });
    expect(out.kind).toBe("cycle");
  });

  test("Run all leaves out a loop and what's below it, and runs the rest", async () => {
    const doc = docOf(
      [
        node("a", "image.generate", { prompt: "a" }),
        node("b", "image.variations", {}),
        node("c", "image.variations", {}),
        node("d", "image.generate", { prompt: "d" }),
      ],
      [
        edge("a", "images", "b", "image"),
        edge("b", "images", "a", "input_images"),
        edge("b", "images", "c", "image"),
      ],
    );
    const fingerprints = await fingerprintsOf(doc);
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "all", nodeIds: [] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items.map((i) => i.item.nodeId)).toEqual(["d"]);
    expect(out.blocked).toEqual({ a: { kind: "loop" }, b: { kind: "loop" }, c: { kind: "loop" } });
    // The nodes say why, and Run all's count and price are only d's.
    const analysis = analyzeGraph(doc, registry, ctx, fingerprints);
    expect(analysis.nodes.a?.blocker).toEqual({ kind: "loop" });
    expect(analysis.nodes.c?.blocker).toEqual({ kind: "loop" });
    expect(analysis.runnable).toBe(1);
    expect(analysis.pending).toBe(1);
  });

  test("a single node with stale earlier nodes asks first, then runs them too", async () => {
    const doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    const ask = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "node", nodeIds: ["v"] } });
    expect(ask).toEqual({ kind: "needs_upstream", nodeIds: ["g"] });

    const both = compileRun({
      doc,
      registry,
      ctx,
      fingerprints,
      request: { scope: "node", nodeIds: ["v"], includeUpstream: true },
    });
    if (both.kind !== "plan") throw new Error(both.kind);
    expect(both.items.map((i) => i.item.nodeId)).toEqual(["g", "v"]);
  });

  test("an earlier node with current images is read, not run", async () => {
    let doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(doc, { op: "setResult", id: "g", result: done(fingerprints.g!, 2) });
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "node", nodeIds: ["v"] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items.map((i) => i.item.nodeId)).toEqual(["v"]);
    expect(out.items[0]!.item.inputs[0]!.values).toEqual([
      { kind: "asset", assetId: ULID(0) },
      { kind: "asset", assetId: ULID(1) },
    ]);
    expect(out.items[0]!.fanOut).toBe(2);
  });

  test("blocked nodes stay out of the plan, and so does what depends on them", async () => {
    const doc = docOf(
      [
        node("g", "image.generate", { model: "google:locked", prompt: "a" }),
        node("v", "image.variations", {}),
        node("free", "image.generate", { prompt: "b" }),
      ],
      [edge("g", "images", "v", "image")],
    );
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items.map((i) => i.item.nodeId)).toEqual(["free"]);
    expect(out.blocked.g).toEqual({ kind: "no_key", model: "google:locked" });
    expect(out.blocked.v).toEqual({ kind: "upstream_blocked", nodeId: "g" });
  });

  test("a Generate needs words or an image", async () => {
    const doc = docOf([node("g", "image.generate", {})]);
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "node", nodeIds: ["g"] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.blocked.g).toEqual({ kind: "no_prompt" });
  });

  test("running twice with nothing changed runs nothing the second time", async () => {
    let doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(
      doc,
      { op: "setResult", id: "g", result: done(fingerprints.g!, 4) },
      { op: "setResult", id: "v", result: done(fingerprints.v!, 16, 10) },
    );
    const again = await fingerprintsOf(doc);
    expect(again).toEqual(fingerprints);
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: again,
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.upToDate).toEqual(["g", "v"]);
    expect(out.jobs).toBe(0);
    // Every item carries its result, so the server can check the images still exist and skip it.
    for (const { item } of out.items) expect(item.cached?.fingerprint).toBe(item.fingerprint);
  });

  test("a node stopped part way runs again rather than reusing the images it kept", async () => {
    let doc = docOf([node("g", "image.generate", { prompt: "a", batch: 4 })]);
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(doc, {
      op: "setResult",
      id: "g",
      result: { ...done(fingerprints.g!, 2), state: "canceled" },
    });
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "all", nodeIds: [] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.upToDate).toEqual([]);
    expect(out.items[0]!.item.cached).toBeNull();
    expect(out.jobs).toBe(4);
  });

  test("⌥-click runs the pressed node even when nothing changed", async () => {
    let doc = docOf([node("g", "image.generate", { prompt: "a" })]);
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(doc, { op: "setResult", id: "g", result: done(fingerprints.g!, 1) });
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints,
      request: { scope: "node", nodeIds: ["g"], bypassCache: true },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items[0]!.item.bypassCache).toBe(true);
    expect(out.upToDate).toEqual([]);
    expect(out.jobs).toBe(1);
  });
});

describe("speeds (§0.3)", () => {
  /** Two Generate nodes, one on Pro (which has Flex) and one on Banana (which doesn't). */
  async function compileBoth(speed: string) {
    const speedCtx = buildEngineContext(
      [pro, banana],
      undefined,
      undefined,
      new Map([["google", speedSettings({ speed })]]),
    );
    const doc = docOf([
      node("a", "image.generate", { model: "google:pro", prompt: "a", batch: 1 }),
      node("b", "image.generate", { model: "google:banana", prompt: "b", batch: 1 }),
    ]);
    const fingerprints = await resolveFingerprints(planFingerprints(doc, registry, speedCtx), new Map());
    const out = compileRun({
      doc,
      registry,
      ctx: speedCtx,
      fingerprints,
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    return { speedCtx, items: out.items, fingerprints };
  }

  test("a node is priced at its company's speed, and a model without it at Standard", async () => {
    const { items } = await compileBoth("flex");
    const [onPro, onBanana] = items;
    expect(onPro!.estimate.max).toBeCloseTo(0.067, 6);
    expect(onPro!.estimate.basis).toContain("Flex");
    expect(onBanana!.estimate.max).toBeCloseTo(0.134, 6);
    expect(onBanana!.estimate.basis).not.toContain("Flex");
    // The speed rides on the company's settings, never in the plan, so the server decides it too.
    expect(onPro!.item.calls[0]).not.toHaveProperty("speed");
  });

  test("changing the speed changes prices, not fingerprints: nothing reruns for it", async () => {
    const standard = await compileBoth("standard");
    const batch = await compileBoth("batch");
    expect(standard.items[0]!.estimate.max).toBeCloseTo(0.134, 6);
    expect(batch.items[0]!.estimate.max).toBeCloseTo(0.067, 6);
    expect(batch.fingerprints).toEqual(standard.fingerprints);
  });

  test("the note says Standard for a model without the speed, and names the speed otherwise", async () => {
    const { speedCtx } = await compileBoth("flex");
    const company = () => "Google";
    expect(nodeSpeed(speedCtx, [banana], company)).toEqual({
      fallback: "Standard",
      tips: ["Banana has no Flex, so it runs at Standard."],
    });
    expect(nodeSpeed(speedCtx, [pro], company)).toEqual({
      tips: ["Speed: Flex. Change it in Google settings."],
    });
    expect(nodeSpeed(speedCtx, [pro, banana], company)?.fallback).toBe("Standard");
    const standard = await compileBoth("standard");
    expect(nodeSpeed(standard.speedCtx, [pro, banana], company)).toBeUndefined();
  });
});

describe("fingerprints", () => {
  test("a new node keeps the default aspect ratio it was made with; changing the setting changes nothing", async () => {
    const wide = { ...ctx, defaultAspect: "16:9" as const };
    const made = registry.instantiate("image.generate", { position: { x: 0, y: 0 }, ctx: wide });
    expect(made.params.size).toEqual({ kind: "aspect", ratio: "16:9" });
    expect(
      registry.instantiate("image.generate", { position: { x: 0, y: 0 }, ctx }).params.size,
    ).toBeUndefined();
    // A node saved without a size uses the model's own default, whatever the person's setting.
    const doc = chain();
    const plain = await resolveFingerprints(planFingerprints(doc, registry, ctx), new Map());
    const square = await resolveFingerprints(
      planFingerprints(doc, registry, { ...ctx, defaultAspect: "1:1" }),
      new Map(),
    );
    expect(square).toEqual(plain);
  });

  test("stable across passes, and only what changes the images changes them", async () => {
    const doc = chain();
    const first = await fingerprintsOf(doc);
    expect(await fingerprintsOf(doc)).toEqual(first);
    for (const fp of Object.values(first)) expect(fp).toMatch(HASH_RE);

    const moved = apply(
      doc,
      { op: "moveNode", id: "g", position: { x: 500, y: 20 } },
      { op: "setTitle", id: "g", title: "Hero shot" },
      { op: "setCollapsed", id: "g", collapsed: true },
      { op: "resizeNode", id: "g", size: { w: 400, h: 500 } },
    );
    expect(await fingerprintsOf(moved)).toEqual(first);
  });

  test("unset and the model's default hash the same", async () => {
    const unset = docOf([node("g", "image.generate", { prompt: "a" })]);
    const explicit = docOf([
      node("g", "image.generate", {
        model: "google:banana",
        prompt: "a",
        size: { kind: "auto" },
        resolution: "1K",
        batch: 1,
        seed: { mode: "random" },
      }),
    ]);
    expect((await fingerprintsOf(unset)).g).toBe((await fingerprintsOf(explicit)).g!);
  });

  test("a change upstream changes every node below it, and nothing beside it", async () => {
    const doc = docOf(
      [...chain().order.map((id) => chainNode(id)), node("other", "image.generate", { prompt: "unrelated" })],
      [edge("p", "text", "g", "prompt"), edge("g", "images", "v", "image")],
    );
    const before = await fingerprintsOf(doc);
    const after = await fingerprintsOf(
      apply(doc, { op: "setParams", id: "p", patch: { text: "Lighthouse at dawn" } }),
    );
    expect(after.p).not.toBe(before.p);
    expect(after.g).not.toBe(before.g);
    expect(after.v).not.toBe(before.v);
    expect(after.other).toBe(before.other!);
  });

  test("a changed node reads as changed within the same pass, before its digest lands", async () => {
    const cache: FingerprintCache = new Map();
    let doc = chain();
    const fingerprints = await fingerprintsOf(doc, cache);
    doc = apply(
      doc,
      { op: "setResult", id: "g", result: done(fingerprints.g!, 4) },
      { op: "setResult", id: "v", result: done(fingerprints.v!, 16, 10) },
    );
    const edited = apply(doc, { op: "setParams", id: "g", patch: { prompt: "long exposure, fog" } });
    const now = knownFingerprints(planFingerprints(edited, registry, ctx), cache);
    expect(now.p).toBe(fingerprints.p!);
    const display = (id: "g" | "v") =>
      deriveDisplay({
        result: edited.results[id] ?? null,
        runtime: undefined,
        fingerprint: now[id],
        blocker: null,
        fanOut: 1,
      });
    expect(display("g")).toMatchObject({ state: "stale", chip: "inputs_changed" });
    expect(display("v")).toMatchObject({ state: "stale", chip: "inputs_changed" });

    // Typing it back finds the old digest straight away: no flash of "changed".
    const reverted = knownFingerprints(planFingerprints(doc, registry, ctx), cache);
    expect(reverted.g).toBe(fingerprints.g!);
  });
});

function chainNode(id: string): CanvasNode {
  const doc = chain();
  return { ...doc.nodes[id]!, params: { ...doc.params[id] }, result: null };
}

describe("fan-out", () => {
  test("a list into a single input runs once per image, and the price follows", async () => {
    const uploads = [ULID(1), ULID(2), ULID(3)];
    const doc = docOf(
      [
        node("u", "image.upload", { assetIds: uploads }),
        node("v", "image.variations", { count: 2, strategy: "seed-jitter" }),
      ],
      [edge("u", "images", "v", "image")],
    );
    const fingerprints = await fingerprintsOf(doc);
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "node", nodeIds: ["v"] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    const item = out.items[0]!;
    expect(item.fanOut).toBe(3);
    expect(item.expectedJobs).toBe(6);
    expect(item.item.inputs[0]!.values).toHaveLength(3);
    // $0.134 an image at 1K, six images.
    expect(item.estimate.min).toBeCloseTo(0.804, 6);

    const analysis = analyzeGraph(doc, registry, ctx, fingerprints);
    expect(analysis.nodes.v?.fanOut).toBe(3);
  });

  test("a multi input never fans out", async () => {
    const doc = docOf(
      [
        node("u", "image.upload", { assetIds: [ULID(1), ULID(2)] }),
        node("g", "image.generate", { prompt: "a" }),
      ],
      [edge("u", "images", "g", "input_images")],
    );
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items[0]!.fanOut).toBe(1);
    expect(out.items[0]!.item.inputs[0]!.arity).toBe("multi");
  });

  test("Prompts and Models make one run per line or model", async () => {
    const doc = docOf(
      [
        node("a", "image.variations", { strategy: "prompt-list", prompts: ["in snow", "", "at noon", "  "] }),
        node("p", "prompt", { text: "A lighthouse" }),
        node("b", "image.variations", { strategy: "model-list", models: ["google:banana", "openai:flare"] }),
      ],
      [edge("p", "text", "b", "prompt")],
    );
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    const [a, b] = out.items;
    expect(a!.item.calls.map((c) => [c.prompt, c.label, c.batch])).toEqual([
      ["in snow", "in snow", 1],
      ["at noon", "at noon", 1],
    ]);
    expect(b!.item.calls.map((c) => [c.model, c.prompt])).toEqual([
      ["google:banana", "A lighthouse"],
      ["openai:flare", "A lighthouse"],
    ]);
    // Flare's price isn't known, so the node's estimate covers Banana only.
    expect(b!.estimate.min).toBeCloseTo(0.134, 6);
  });

  test("too few prompts or models blocks with a count", async () => {
    const doc = docOf([node("a", "image.variations", { strategy: "prompt-list", prompts: ["one"] })]);
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.blocked.a).toEqual({ kind: "needs_more", what: "prompts", min: 2 });
  });
});

describe("display", () => {
  const result = done("sha256:a", 2);
  const runtime = (patch: Partial<NodeRuntime>): NodeRuntime => ({ ...idleRuntime(), ...patch });

  test("first match wins", () => {
    const base = { result, fingerprint: "sha256:a", blocker: null, fanOut: 1 };
    expect(deriveDisplay({ ...base, runtime: runtime({ state: "running" }) }).state).toBe("running");
    expect(deriveDisplay({ ...base, runtime: undefined, blocker: { kind: "no_prompt" } }).state).toBe(
      "blocked",
    );
    expect(deriveDisplay({ ...base, runtime: runtime({ state: "cached", skipped: true }) })).toMatchObject({
      state: "done",
      chip: "up_to_date",
    });
    expect(
      deriveDisplay({ ...base, fingerprint: "sha256:b", runtime: runtime({ late: true }) }),
    ).toMatchObject({
      state: "stale",
      chip: "older_settings",
    });
    expect(deriveDisplay({ ...base, result: null, runtime: undefined }).state).toBe("idle");
    const failed = { ...result, state: "failed" as const, assetIds: [] };
    expect(deriveDisplay({ ...base, result: failed, runtime: undefined }).state).toBe("failed");
    expect(
      deriveDisplay({ ...base, result: failed, fingerprint: "sha256:b", runtime: undefined }).state,
    ).toBe("idle");
  });

  test("a stop part way shows the canceled band over the images it kept", () => {
    const base = { fingerprint: "sha256:a", blocker: null, fanOut: 1, runtime: undefined };
    const stopped = { ...result, state: "canceled" as const };
    expect(deriveDisplay({ ...base, result: stopped }).state).toBe("canceled");
    // Once the settings move on, the kept images are just out of date.
    expect(deriveDisplay({ ...base, result: stopped, fingerprint: "sha256:b" })).toMatchObject({
      state: "stale",
      chip: "inputs_changed",
    });
  });

  test("key problems show at once, input problems only after a run hit them", () => {
    expect(visibleBlocker({ kind: "no_key", model: "google:locked" }, undefined)?.kind).toBe("no_key");
    expect(visibleBlocker({ kind: "no_prompt" }, undefined)).toBeNull();
    expect(
      visibleBlocker({ kind: "no_prompt" }, runtime({ state: "blocked", blocker: { kind: "no_prompt" } }))
        ?.kind,
    ).toBe("no_prompt");
  });
});

describe("connections", () => {
  const doc = chain();

  test("types must fit, and the toast names both sides", () => {
    const out = checkConnection(
      doc,
      { source: "p", sourceHandle: "text", target: "g", targetHandle: "input_images" },
      registry,
    );
    expect(out).toEqual({ ok: false, reason: "Text can't go into an image input on Generate." });
  });

  test("loops are refused", () => {
    const out = checkConnection(
      doc,
      { source: "v", sourceHandle: "images", target: "g", targetHandle: "input_images" },
      registry,
    );
    expect(out).toEqual({ ok: false, reason: "That would create a loop." });
  });

  test("a second edge into a single input replaces the first", () => {
    const withUpload = apply(doc, {
      op: "addNode",
      node: node("u", "image.upload", { assetIds: [ULID(1)] }),
    });
    const out = checkConnection(
      withUpload,
      { source: "u", sourceHandle: "images", target: "v", targetHandle: "image" },
      registry,
    );
    expect(out).toMatchObject({ ok: true, kind: "data", flow: "ok" });
    expect(out.ok && out.replaces).toBeTruthy();
  });

  test("hidden ports take nothing, and arrows only go between arrow handles", () => {
    expect(
      checkConnection(
        doc,
        { source: "p", sourceHandle: "text", target: "g", targetHandle: "preset" },
        registry,
      ).ok,
    ).toBe(false);
    expect(
      checkConnection(
        doc,
        { source: "p", sourceHandle: "arrow-source-right", target: "g", targetHandle: "arrow-target-left" },
        registry,
      ),
    ).toEqual({ ok: true, kind: "annotation", flow: "ok" });
    expect(
      checkConnection(
        doc,
        { source: "p", sourceHandle: "arrow-source-right", target: "g", targetHandle: "prompt" },
        registry,
      ).ok,
    ).toBe(false);
  });
});

describe("run preview", () => {
  const cost = (min: number, max = min) => ({
    currency: "USD",
    min,
    max,
    confidence: min === max ? ("exact" as const) : ("estimated" as const),
    basis: "",
    pricedAt: "2026-09-23",
  });
  const unknown = { ...cost(0), confidence: "unknown" as const };

  test("rows add up to the total as shown, unknown rows are named and left out", () => {
    const preview = buildPreview({
      jobs: 8,
      nodes: [
        { nodeId: "hero", jobs: 4, estimate: cost(0.536), skipped: false, blocked: null },
        { nodeId: "retouch", jobs: 3, estimate: cost(0.155, 0.284), skipped: false, blocked: null },
        { nodeId: "backdrop", jobs: 0, estimate: cost(0), skipped: true, blocked: null },
        { nodeId: "props", jobs: 0, estimate: cost(0), skipped: true, blocked: null },
        { nodeId: "lifestyle", jobs: 1, estimate: unknown, skipped: false, blocked: null },
      ],
    });
    expect(preview.running).toBe(3);
    expect(preview.images).toBe(8);
    expect(preview.rows.map((r) => r.kind)).toEqual(["run", "run", "up_to_date", "unknown"]);
    expect(preview.unknown).toEqual(["lifestyle"]);
    const rows = preview.rows.flatMap((r) => (r.kind === "run" ? [r.estimate] : []));
    expect(rows.map((r) => [r.min, r.max])).toEqual([
      [0.54, 0.54],
      [0.16, 0.28],
    ]);
    // Rows as shown: $0.54 + $0.16–0.28 = $0.70–0.82, cent for cent.
    expect(preview.total.min).toBeCloseTo(0.7, 9);
    expect(preview.total.max).toBeCloseTo(0.82, 9);
  });

  test("everything up to date is free, and only unknowns is unknown", () => {
    expect(
      buildPreview({
        jobs: 0,
        nodes: [{ nodeId: "a", jobs: 0, estimate: cost(0), skipped: true, blocked: null }],
      }).total,
    ).toMatchObject({ min: 0, max: 0, confidence: "exact" });
    expect(
      buildPreview({
        jobs: 1,
        nodes: [{ nodeId: "a", jobs: 1, estimate: unknown, skipped: false, blocked: null }],
      }).total.confidence,
    ).toBe("unknown");
  });
});

describe("reusing results (§0.11, §7.7)", () => {
  /** Generate made 4 images, and Variations ran on exactly those. */
  async function ranOnce() {
    let doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(
      doc,
      { op: "setResult", id: "g", result: done(fingerprints.g!, 4) },
      { op: "setResult", id: "v", result: done(fingerprints.v!, 16, 10, ids(4)) },
    );
    return { doc, fingerprints };
  }

  test("new images upstream under the same settings make what reads them run again", async () => {
    let { doc, fingerprints } = await ranOnce();
    // ⌥-click on Generate: same settings, new images.
    doc = apply(doc, { op: "setResult", id: "g", result: done(fingerprints.g!, 4, 40) });
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "all", nodeIds: [] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.upToDate).toEqual(["g"]);
    const variations = out.items.find((i) => i.item.nodeId === "v")!.item;
    // Never offered for reuse, so the server can't skip it either.
    expect(variations.cached).toBeNull();
    const analysis = analyzeGraph(doc, registry, ctx, fingerprints);
    expect(analysis.nodes.v).toMatchObject({ upToDate: false, inputsChanged: true });
    expect(analysis.nodes.g).toMatchObject({ upToDate: true, inputsChanged: false });
    expect(
      deriveDisplay({
        result: doc.results.v!,
        runtime: undefined,
        fingerprint: fingerprints.v,
        blocker: null,
        fanOut: 1,
        inputsChanged: true,
      }),
    ).toMatchObject({ state: "stale", chip: "inputs_changed" });
  });

  test("an earlier node that runs in this pass means nothing below it is reused", async () => {
    let { doc, fingerprints } = await ranOnce();
    doc = apply(doc, {
      op: "setResult",
      id: "g",
      result: { ...done(fingerprints.g!, 2), state: "failed", error: { code: "unknown" } },
    });
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "all", nodeIds: [] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.upToDate).toEqual([]);
    expect(out.items.map((i) => i.item.cached)).toEqual([null, null]);
  });

  test("⌥ with Run from here runs the pressed node and everything below it", async () => {
    const { doc, fingerprints } = await ranOnce();
    const out = compileRun({
      doc,
      registry,
      ctx,
      fingerprints,
      request: { scope: "downstream", nodeIds: ["g"], bypassCache: true },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.upToDate).toEqual([]);
    expect(out.items.map((i) => i.item.bypassCache)).toEqual([true, true]);
  });

  test("a single node whose earlier node ran again asks to run that one first", async () => {
    let doc = docOf(
      [
        node("p", "prompt", { text: "Harbor" }),
        node("a", "image.generate", { prompt: "a" }),
        node("b", "image.variations", { count: 2 }),
        node("c", "image.variations", { count: 2 }),
      ],
      [
        edge("p", "text", "a", "prompt"),
        edge("a", "images", "b", "image"),
        edge("b", "images", "c", "image"),
      ],
    );
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(
      doc,
      { op: "setResult", id: "a", result: done(fingerprints.a!, 1, 60) },
      { op: "setResult", id: "b", result: done(fingerprints.b!, 2, 70, ids(1)) },
      { op: "setResult", id: "c", result: done(fingerprints.c!, 4, 80, ids(2, 70)) },
    );
    const ask = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "node", nodeIds: ["c"] } });
    expect(ask).toEqual({ kind: "needs_upstream", nodeIds: ["b"] });
  });

  test("a result short of images, or with images gone from the library, isn't reused", async () => {
    let doc = docOf([node("g", "image.generate", { prompt: "a", batch: 4 })]);
    const fingerprints = await fingerprintsOf(doc);
    doc = apply(doc, { op: "setResult", id: "g", result: done(fingerprints.g!, 2) });
    const missing = { ...ctx, missing: new Set([ULID(1)]) };
    const out = compileRun({
      doc,
      registry,
      ctx: missing,
      fingerprints,
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.upToDate).toEqual([]);
    expect(out.jobs).toBe(4);
  });
});

describe("runs already going", () => {
  test("nodes queued or running, and what reads from them, stay out of a new run", async () => {
    const doc = docOf(
      [
        node("p", "prompt", { text: "Lighthouse" }),
        node("g", "image.generate", { prompt: "a" }),
        node("v", "image.variations", { count: 2 }),
        node("free", "image.generate", { prompt: "b" }),
      ],
      [edge("p", "text", "g", "prompt"), edge("g", "images", "v", "image")],
    );
    const fingerprints = await fingerprintsOf(doc);
    const busy = new Set(["g"]);
    const all = compileRun({
      doc,
      registry,
      ctx,
      fingerprints,
      busy,
      request: { scope: "all", nodeIds: [] },
    });
    if (all.kind !== "plan") throw new Error(all.kind);
    expect(all.items.map((i) => i.item.nodeId)).toEqual(["free"]);
    expect(
      compileRun({ doc, registry, ctx, fingerprints, busy, request: { scope: "node", nodeIds: ["g"] } }),
    ).toEqual({ kind: "busy", upstream: false });
    expect(
      compileRun({ doc, registry, ctx, fingerprints, busy, request: { scope: "node", nodeIds: ["v"] } }),
    ).toEqual({ kind: "busy", upstream: true });
    // Run all's price covers only what it would send.
    const analysis = analyzeGraph(doc, registry, ctx, fingerprints, undefined, busy);
    expect(analysis.pending).toBe(1);
    expect(analysis.nodes.v?.held).toBe(true);
    expect(analysis.nodes.free?.held).toBe(false);
  });
});

describe("blockers", () => {
  test("a node's own key problem shows before an earlier node's, and it keeps its price", async () => {
    const doc = docOf(
      [
        node("g", "image.generate", { model: "google:locked", prompt: "a" }),
        node("v", "image.variations", { model: "google:locked", count: 2 }),
      ],
      [edge("g", "images", "v", "image")],
    );
    const fingerprints = await fingerprintsOf(doc);
    const analysis = analyzeGraph(doc, registry, ctx, fingerprints);
    expect(analysis.nodes.v?.blocker).toEqual({ kind: "no_key", model: "google:locked" });
    // The faded pill still says what a run would cost (design Kce7o).
    expect(analysis.nodes.g?.estimate?.max).toBeGreaterThan(0);
    expect(analysis.pending).toBe(0);
  });

  test("a fan-out bigger than a run can make is stopped on the node", async () => {
    const uploads = Array.from({ length: 300 }, (_, i) => ULID(100 + i));
    const doc = docOf(
      [node("u", "image.upload", { assetIds: uploads }), node("v", "image.variations", { count: 4 })],
      [edge("u", "images", "v", "image")],
    );
    const analysis = analyzeGraph(doc, registry, ctx, await fingerprintsOf(doc));
    expect(analysis.nodes.v?.blocker).toEqual({ kind: "too_many_jobs", max: 1000 });
  });

  test("Run all counts every image it would make, so the cap is known before anything is sent", async () => {
    // Assets (8) → V1 (8 takes: 64) → V2 and V3 (8 takes each of 64: 512 each). No node alone is too
    // big, together they're 1088.
    const assets = Array.from({ length: 8 }, (_, i) => ULID(200 + i));
    const doc = docOf(
      [
        node("a", "image.asset", { assetIds: assets }),
        node("v1", "image.variations", { count: 8 }),
        node("v2", "image.variations", { count: 8 }),
        node("v3", "image.variations", { count: 8 }),
      ],
      [
        edge("a", "images", "v1", "image"),
        edge("v1", "images", "v2", "image"),
        edge("v1", "images", "v3", "image"),
      ],
    );
    const fingerprints = await fingerprintsOf(doc);
    const analysis = analyzeGraph(doc, registry, ctx, fingerprints);
    expect(Object.values(analysis.nodes).every((n) => n.blocker === null)).toBe(true);
    expect(analysis.jobs).toBe(1088);
    const out = compileRun({ doc, registry, ctx, fingerprints, request: { scope: "all", nodeIds: [] } });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.jobs).toBe(1088);
  });

  test("images that aren't in the library stay out of runs", async () => {
    const doc = docOf(
      [
        node("u", "image.upload", { assetIds: [ULID(1), ULID(2)] }),
        node("g", "image.generate", { prompt: "a" }),
      ],
      [edge("u", "images", "g", "input_images")],
    );
    const out = compileRun({
      doc,
      registry,
      ctx: { ...ctx, missing: new Set([ULID(1)]) },
      fingerprints: await fingerprintsOf(doc),
      request: { scope: "all", nodeIds: [] },
    });
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items[0]!.item.inputs[0]!.values).toEqual([{ kind: "asset", assetId: ULID(2) }]);
  });
});

describe("following runs", () => {
  const RUN = "01K6BQ8000000000000000RUN1";
  const CANVAS = "01K6BQ8000000000000000CNVS";
  const nodeState = (
    nodeId: string,
    state: RunNodeState["state"],
    fingerprint: string,
    assetIds: string[] = [],
  ) => ({
    nodeId,
    state,
    fingerprint,
    jobSetIds: [],
    done: assetIds.length,
    total: assetIds.length,
    assetIds,
    outputs: assetIds.map((assetId) => ({ assetId })),
    inputs: [],
    costUsd: null,
    error: null,
    blocked: null,
    startedAt: null,
    finishedAt: null,
  });
  const runOf = (nodes: RunNodeState[], runId = RUN, status = "running"): RunState => ({
    runId,
    canvasId: CANVAS,
    scope: "all",
    status: status as RunState["status"],
    createdAt: "2026-09-24T10:00:00.000Z",
    finishedAt: null,
    nodes,
  });

  async function setup() {
    useEngineStore.getState().reset();
    const doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    const document = {
      ...emptyDocument(CANVAS, "Test"),
      nodes: doc.order.map((id) => ({ ...doc.nodes[id]!, params: { ...doc.params[id] }, result: null })),
      edges: doc.edgeOrder.map((id) => doc.edges[id]!),
    };
    const store = createCanvasStore({
      id: CANVAS,
      name: "Test",
      graph: document,
      graphVersion: 1,
      updatedAt: document.updatedAt,
    });
    store.getState().actions.setFingerprints(fingerprints);
    const follower = createFollower({ store, registry, context: () => ctx });
    return { store, follower, fingerprints };
  }

  test("finished nodes write their results, one undo entry per run", async () => {
    const { store, follower, fingerprints } = await setup();
    follower.applyRun(
      runOf([
        nodeState("g", "done", fingerprints.g!, [ULID(1), ULID(2)]),
        nodeState("v", "running", fingerprints.v!),
      ]),
    );
    expect(store.getState().doc.results.g?.assetIds).toEqual([ULID(1), ULID(2)]);
    expect(store.getState().runtime.g?.state).toBe("done");
    expect(store.getState().runtime.v?.state).toBe("running");
    follower.applyRun(
      runOf(
        [
          nodeState("g", "done", fingerprints.g!, [ULID(1), ULID(2)]),
          nodeState("v", "done", fingerprints.v!, [ULID(3)]),
        ],
        RUN,
        "succeeded",
      ),
    );
    expect(store.getState().doc.results.v?.assetIds).toEqual([ULID(3)]);
    expect(store.getState().history.past).toHaveLength(1);
    // Undo takes the results off the nodes; the images stay in the library.
    store.getState().actions.undo();
    expect(store.getState().doc.results.g).toBeNull();
  });

  test("a new run starts its own clock, even when its first frame beats the run response", async () => {
    const { store, follower, fingerprints } = await setup();
    const old = "2026-09-24T09:00:00.000Z";
    store.getState().actions.setRuntime({
      g: { runId: "01K6BQ8000000000000000RUN0", state: "done", startedAt: old, progress: 1, position: 2 },
    });
    follower.applyRun(runOf([nodeState("g", "running", fingerprints.g!)]));
    const runtime = store.getState().runtime.g!;
    expect(runtime.startedAt).not.toBe(old);
    expect(runtime.progress).toBeNull();
    expect(runtime.position).toBeNull();
  });

  test("skipped nodes keep their result and say so", async () => {
    const { store, follower, fingerprints } = await setup();
    follower.applyRun(runOf([nodeState("g", "cached", fingerprints.g!, [ULID(1)])], RUN, "succeeded"));
    expect(store.getState().doc.results.g).toBeNull();
    expect(store.getState().runtime.g).toMatchObject({ state: "cached", skipped: true });
  });

  test("a result for settings that changed since is kept, and marked", async () => {
    const { store, follower, fingerprints } = await setup();
    store.getState().actions.apply([{ op: "setParams", id: "g", patch: { prompt: "changed" } }]);
    const now = await fingerprintsOf(store.getState().doc);
    store.getState().actions.setFingerprints(now);
    follower.applyRun(runOf([nodeState("g", "done", fingerprints.g!, [ULID(1)])], RUN, "succeeded"));
    const state = store.getState();
    expect(state.doc.results.g?.fingerprint).toBe(fingerprints.g!);
    expect(state.runtime.g?.late).toBe(true);
    expect(
      deriveDisplay({
        result: state.doc.results.g!,
        runtime: state.runtime.g,
        fingerprint: now.g,
        blocker: null,
        fanOut: 1,
      }),
    ).toMatchObject({ state: "stale", chip: "older_settings" });
  });
});

describe("following runs, the rest", () => {
  const RUN = "01K6BQ8000000000000000RUN2";
  const CANVAS = "01K6BQ8000000000000000CNVS";
  const state = (
    nodeId: string,
    s: RunNodeState["state"],
    fingerprint: string,
    extra: Partial<RunNodeState> = {},
  ): RunNodeState => ({
    nodeId,
    state: s,
    fingerprint,
    jobSetIds: [],
    done: 0,
    total: 0,
    assetIds: [],
    outputs: [],
    inputs: [],
    costUsd: null,
    error: null,
    blocked: null,
    startedAt: null,
    finishedAt: null,
    ...extra,
  });
  const runOf = (nodes: RunNodeState[], finishedAt: string | null = null): RunState => ({
    runId: RUN,
    canvasId: CANVAS,
    scope: "all",
    status: finishedAt ? "succeeded" : "running",
    createdAt: "2026-09-24T10:00:00.000Z",
    finishedAt,
    nodes,
  });

  async function setup() {
    useEngineStore.getState().reset();
    const doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    const document = {
      ...emptyDocument(CANVAS, "Test"),
      nodes: doc.order.map((id) => ({ ...doc.nodes[id]!, params: { ...doc.params[id] }, result: null })),
      edges: doc.edgeOrder.map((id) => doc.edges[id]!),
    };
    const store = createCanvasStore({
      id: CANVAS,
      name: "Test",
      graph: document,
      graphVersion: 1,
      updatedAt: document.updatedAt,
    });
    store.getState().actions.setFingerprints(fingerprints);
    return { store, follower: createFollower({ store, registry, context: () => ctx }), fingerprints };
  }

  test("the clock and the place in line come from the run, so a reload carries on", async () => {
    const { store, follower, fingerprints } = await setup();
    const started = "2026-09-24T10:00:05.000Z";
    follower.applyRun(
      runOf([
        state("g", "running", fingerprints.g!, { startedAt: started }),
        state("v", "queued", fingerprints.v!),
      ]),
    );
    expect(store.getState().runtime.g?.startedAt).toBe(started);
    // Variations waits for Generate in the same run: it has no job in the company's queue yet.
    expect(store.getState().runtime.v?.position).toBeNull();
  });

  test("a place in line comes from the company's queue once the node's job set is there", async () => {
    const { store, follower, fingerprints } = await setup();
    follower.applyRun(runOf([state("g", "queued", fingerprints.g!, { jobSetIds: [ULID(5)] })]));
    expect(store.getState().runtime.g?.position).toBeNull();
    follower.applyEvent({
      event: "job.queued",
      data: { jobSetId: ULID(5), jobId: ULID(6), idx: 0, position: 3 },
    });
    expect(store.getState().runtime.g?.position).toBe(3);
    // The next frame of the run keeps it.
    follower.applyRun(runOf([state("g", "queued", fingerprints.g!, { jobSetIds: [ULID(5)] })]));
    expect(store.getState().runtime.g?.position).toBe(3);
  });

  test("every tab writes the same result, down to its time, the images it read, and late marks", async () => {
    const { store, follower, fingerprints } = await setup();
    store.getState().actions.apply([{ op: "setParams", id: "g", patch: { prompt: "changed" } }]);
    store.getState().actions.setFingerprints(await fingerprintsOf(store.getState().doc));
    const at = "2026-09-24T10:01:00.000Z";
    follower.applyRun(
      runOf(
        [state("g", "done", fingerprints.g!, { assetIds: [ULID(1)], inputs: [ULID(9)], finishedAt: at })],
        "2026-09-24T10:02:00.000Z",
      ),
    );
    expect(store.getState().doc.results.g).toMatchObject({ ranAt: at, inputs: [ULID(9)], late: true });
  });

  test("a node canceled before it started keeps the result it had", async () => {
    const { store, follower, fingerprints } = await setup();
    store.getState().actions.apply([{ op: "setResult", id: "v", result: done(fingerprints.v!, 2) }]);
    follower.applyRun(runOf([state("v", "canceled", fingerprints.v!)], "2026-09-24T10:02:00.000Z"));
    expect(store.getState().doc.results.v?.state).toBe("done");
  });

  test("a node canceled with its job set made but nothing finished keeps the result it had", async () => {
    const { store, follower, fingerprints } = await setup();
    const before = done(fingerprints.v!, 2);
    store.getState().actions.apply([{ op: "setResult", id: "v", result: before }]);
    follower.applyRun(
      runOf([state("v", "canceled", fingerprints.v!, { jobSetIds: [ULID(7)] })], "2026-09-24T10:02:00.000Z"),
    );
    expect(store.getState().doc.results.v).toEqual(before);
  });

  test("a failure that made nothing keeps the images it had, beside the error", async () => {
    const { store, follower, fingerprints } = await setup();
    const before = done(fingerprints.v!, 2, 0, [ULID(20)]);
    store.getState().actions.apply([{ op: "setResult", id: "v", result: before }]);
    const error = { code: "provider_error" as const, reason: "The company had a problem." };
    follower.applyRun(
      runOf(
        [state("v", "failed", fingerprints.v!, { jobSetIds: [ULID(7)], error })],
        "2026-09-24T10:02:00.000Z",
      ),
    );
    expect(store.getState().doc.results.v).toMatchObject({
      state: "failed",
      error,
      assetIds: before.assetIds,
      inputs: [ULID(20)],
      jobSetIds: [ULID(7)],
    });
  });

  test("an earlier node that has its images again clears the band an older run left below it", async () => {
    const { store, follower, fingerprints } = await setup();
    follower.applyRun(
      runOf(
        [
          state("g", "failed", fingerprints.g!, { error: { code: "provider_error" } }),
          state("v", "blocked", fingerprints.v!, { blocked: "upstream_failed" }),
        ],
        "2026-09-24T10:01:00.000Z",
      ),
    );
    expect(visibleBlocker(null, store.getState().runtime.v)).toMatchObject({ kind: "upstream_failed" });
    // Try again on Generate alone: a newer run that doesn't include Variations.
    follower.applyRun({
      ...runOf([state("g", "done", fingerprints.g!, { assetIds: [ULID(1)] })], "2026-09-24T10:03:00.000Z"),
      runId: "01K6BQ8000000000000000RUN3",
      scope: "node",
      createdAt: "2026-09-24T10:02:00.000Z",
    });
    expect(store.getState().runtime.v?.state).toBe("idle");
    expect(visibleBlocker(null, store.getState().runtime.v)).toBeNull();
  });

  test("a result landing leaves redo alone", async () => {
    const { store, follower, fingerprints } = await setup();
    const { actions } = store.getState();
    actions.apply([{ op: "setParams", id: "p", patch: { text: "A lighthouse at night" } }]);
    actions.undo();
    follower.applyRun(
      runOf([state("g", "done", fingerprints.g!, { assetIds: [ULID(1)] })], "2026-09-24T10:02:00.000Z"),
    );
    expect(store.getState().history.future).toHaveLength(1);
    store.getState().actions.redo();
    expect(store.getState().doc.params.p?.text).toBe("A lighthouse at night");
  });

  test("Reload during a run keeps the running nodes' state", async () => {
    const { store } = await setup();
    store.getState().actions.setRuntime({ g: { runId: RUN, state: "running" } });
    const detail = {
      id: CANVAS,
      name: "Test",
      graph: store.getState().actions.snapshot().document,
      graphVersion: 2,
      updatedAt: "2026-09-24T10:03:00.000Z",
    };
    store.getState().actions.loadDetail(detail);
    expect(store.getState().runtime.g?.state).toBe("running");
    // …so it still can't be deleted while its jobs are out.
    expect(store.getState().actions.deleteNodes(["g"])).toMatchObject({ ok: false, reason: "running" });
  });
});

describe("run controller", () => {
  const RUN = "01K6BQ8000000000000000RUN9";
  const CANVAS_ID = "01K6BQ8000000000000000CNVS";

  async function setup(guard: number | null, spent: number) {
    useEngineStore.getState().reset();
    const doc = chain();
    const fingerprints = await fingerprintsOf(doc);
    const document = {
      ...emptyDocument(CANVAS_ID, "Test"),
      nodes: doc.order.map((id) => ({ ...doc.nodes[id]!, params: { ...doc.params[id] }, result: null })),
      edges: doc.edgeOrder.map((id) => doc.edges[id]!),
    };
    const store = createCanvasStore({
      id: CANVAS_ID,
      name: "Test",
      graph: document,
      graphVersion: 1,
      updatedAt: document.updatedAt,
    });
    const posts: CanvasRunBody[] = [];
    const estimate = { ...freeEstimate(), min: 0.5, max: 0.5 };
    const controller = createRunController({
      store,
      registry,
      context: () => ctx,
      fingerprints: async () => fingerprints,
      spendGuard: () => guard,
      spentThisMonth: async () => spent,
      api: {
        post: async (_id, body) => {
          posts.push(body);
          return {
            runId: body.dryRun ? null : RUN,
            jobSets: [],
            skipped: [],
            estimate,
            jobs: 4,
            nodes: body.plan.map((i) => ({
              nodeId: i.nodeId,
              jobs: 4,
              estimate,
              skipped: false,
              blocked: null,
            })),
          };
        },
        cancelRun: async () => ({}),
        cancelNode: async () => ({}),
      },
    });
    return { controller, posts };
  }

  test("under the monthly limit, a single node just runs", async () => {
    const { controller, posts } = await setup(10, 1);
    await controller.run({ scope: "node", nodeIds: ["g"] });
    expect(posts.map((p) => !!p.dryRun)).toEqual([false]);
  });

  test("once this month's spend and the run reach the limit, even a single node asks first", async () => {
    const { controller, posts } = await setup(10, 9.8);
    const running = controller.run({ scope: "node", nodeIds: ["g"] });
    // The preview opens once the dry run is back; answering no sends nothing.
    for (let i = 0; i < 20 && !useEngineStore.getState().dialog; i++) await Bun.sleep(1);
    expect(useEngineStore.getState().dialog?.kind).toBe("preview");
    useEngineStore.getState().answer(false);
    await running;
    expect(posts.map((p) => !!p.dryRun)).toEqual([true]);
  });
});
