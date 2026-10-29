// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterEach, describe, expect, test } from "bun:test";
import { planFingerprints, resolveFingerprints } from "@openfield/canvas/engine/fingerprint";
import type { EngineContext } from "@openfield/canvas/engine/types";
import { maskFitsBase } from "@openfield/canvas/nodes/edit/spec";
import { createNodeRegistry } from "@openfield/canvas/nodes/registry";
import { DATA_SPECS } from "@openfield/canvas/nodes/specs";
import type { ModelListItem } from "@openfield/core";
import type { CanvasEdge, CanvasNode, CanvasNodeResult } from "@openfield/core/canvas";
import { analyzeGraph } from "../src/canvas/engine/analysis";
import { soleBase } from "../src/canvas/nodes/edit/base";
import { basesOf, editLayout, editRest, syncBases } from "../src/canvas/nodes/edit/card-media";
import { editCardView } from "../src/canvas/nodes/edit/card-state";
import { editableOutput, planEditFrom } from "../src/canvas/nodes/edit/edit-from";
import { cardMedia } from "../src/canvas/nodes/generate/card-media";
import { cardView } from "../src/canvas/nodes/generate/card-state";
import type { NodeDefinition } from "../src/canvas/nodes/registry";
import { blockerCopy } from "../src/canvas/nodes/shell/blocker-copy";
import { applyOps, type DocSlice, emptyDocument, fromDocument } from "../src/canvas/store";
import { banana, flareEdit } from "./fixtures";

// The canvas Edit node in the editor (designs nRuORN2ZyA, MZI3JqbHJr, UgTpM6ixP2): what the card
// and settings read of the image and mask coming in, how the card shows before it has made
// anything, its box, and the node menu's Edit, which wires a new Edit node to the image on show.

const registry = createNodeRegistry(
  DATA_SPECS.map((spec) => ({ ...spec, Component: () => null }) as unknown as NodeDefinition),
);
const models: ModelListItem[] = [banana, { ...flareEdit, ready: true }];
const ctx: EngineContext = {
  models,
  model: (key) => models.find((m) => m.key === key),
  defaultModel: "google:banana",
  defaultEditModel: flareEdit.key,
};

const ULID = (n: number) => `01K6BQ80000000000000AS${String(n).padStart(4, "0")}`;
const PHOTO = ULID(1);
const OTHER = ULID(2);
const MASK = ULID(3);

const node = (id: string, type: CanvasNode["type"], params: Record<string, unknown> = {}): CanvasNode => ({
  id,
  type,
  typeVersion: 1,
  position: { x: 0, y: 0 },
  size: type === "image.upload" ? { w: 280, h: 280 } : undefined,
  parentId: null,
  collapsed: false,
  title: null,
  params,
  presetLocks: [],
  result: null,
});

let edges = 0;
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): CanvasEdge => ({
  id: `e_${edges++}`,
  source,
  sourceHandle,
  target,
  targetHandle,
  kind: "data",
});

const docOf = (nodes: CanvasNode[], links: CanvasEdge[] = []): DocSlice =>
  fromDocument({ ...emptyDocument("01K6BQ8000000000000000CNVS", "Test"), nodes, edges: links }).slice;

const done = (assetIds: string[]): CanvasNodeResult => ({
  state: "done",
  assetIds,
  jobSetId: null,
  jobSetIds: [],
  outputs: [],
  fingerprint: "sha256:x",
  costUsd: null,
  ranAt: null,
  error: null,
});

const editParams = { model: flareEdit.key, prompt: "Make the berries pale" };

async function analysisOf(doc: DocSlice, id: string) {
  const fingerprints = await resolveFingerprints(planFingerprints(doc, registry, ctx), new Map());
  return analyzeGraph(doc, registry, ctx, fingerprints).nodes[id]!;
}

describe("what the Edit node reads", () => {
  test("the image coming in, and a mask on the Mask input", async () => {
    const doc = docOf(
      [
        node("u", "image.upload", { assetIds: [PHOTO] }),
        node("m", "image.upload", { assetIds: [OTHER] }),
        node("x", "image.edit", editParams),
      ],
      [edge("u", "images", "x", "image"), edge("m", "images", "x", "mask")],
    );
    const analysis = await analysisOf(doc, "x");
    expect(analysis.baseImages).toEqual([PHOTO]);
    expect(analysis.maskImages).toEqual([OTHER]);
    expect(analysis.maskLinked).toBe(true);
    expect(soleBase(analysis)).toBe(PHOTO);
  });

  test("a painted mask isn't a link, and no image means nothing to paint on", async () => {
    const painted = await analysisOf(
      docOf([node("x", "image.edit", { ...editParams, maskAssetId: OTHER, maskFor: PHOTO })]),
      "x",
    );
    expect(painted.maskLinked).toBe(false);
    expect(painted.maskImages).toEqual([]);
    expect(painted.baseImages).toEqual([]);
    expect(soleBase(painted)).toBeNull();
  });

  test("several images coming in, or none yet, leave no single image to paint on", () => {
    expect(soleBase({ baseImages: [PHOTO, OTHER] })).toBeNull();
    expect(soleBase({ baseImages: [] })).toBeNull();
    expect(soleBase({ baseImages: [PHOTO] })).toBe(PHOTO);
  });

  // The editor (Paint, the Mask card) and the engine (the blocker, a run) read one list, so they
  // agree on what a painted mask fits whatever the node upstream expects to make next.
  describe("the editor and the engine agree on the image a mask fits", () => {
    const chain = (batch: number, made: string[]) => {
      const doc = docOf(
        [
          node("g", "image.generate", { model: banana.key, prompt: "berries", batch }),
          node("x", "image.edit", { ...editParams, maskAssetId: MASK, maskFor: PHOTO }),
        ],
        [edge("g", "images", "x", "image")],
      );
      return applyOps(doc, [{ op: "setResult", id: "g", result: done(made) }]).doc;
    };
    const editorStale = (analysis: { baseImages: readonly string[]; baseLinked: boolean }) =>
      analysis.baseLinked && !maskFitsBase(PHOTO, analysis.baseImages);

    test("a batch lowered after a run of two: both say the mask doesn't fit the two it has", async () => {
      const analysis = await analysisOf(chain(1, [PHOTO, OTHER]), "x");
      expect(analysis.baseImages).toEqual([PHOTO, OTHER]);
      expect(soleBase(analysis)).toBeNull();
      expect(editorStale(analysis)).toBe(true);
      expect(analysis.blocker).toEqual({ kind: "mask_stale", several: true });
    });

    test("a batch raised after a run of one: both say it fits the one it has", async () => {
      const analysis = await analysisOf(chain(2, [PHOTO]), "x");
      expect(analysis.baseImages).toEqual([PHOTO]);
      expect(soleBase(analysis)).toBe(PHOTO);
      expect(editorStale(analysis)).toBe(false);
      expect(analysis.blocker).toBeNull();
    });

    test("the card offers Paint mask only where one image can take it", () => {
      expect(blockerCopy({ kind: "mask_stale" }, [])).toMatchObject({
        fix: "paint_mask",
        message: "The image changed. Paint the mask again.",
      });
      expect(blockerCopy({ kind: "mask_stale", several: true }, [])).toEqual({
        fix: null,
        action: null,
        message: "A painted mask fits one image. Connect one image, or connect a mask.",
      });
    });

    test("another image: both say it doesn't fit, and it can be painted again", async () => {
      const analysis = await analysisOf(chain(1, [OTHER]), "x");
      expect(soleBase(analysis)).toBe(OTHER);
      expect(editorStale(analysis)).toBe(true);
      expect(analysis.blocker).toEqual({ kind: "mask_stale" });
    });
  });
});

describe("the Edit card before it has made anything", () => {
  const idle = cardView({ state: "idle", images: true, atCompany: false, partial: false });

  test("the image coming in shows with Run at rest and no pill", () => {
    const view = editCardView(idle, { own: false, covered: false });
    expect(view).toMatchObject({ phase: "empty", noPill: true, media: "image", bottomAtRest: true });
  });

  test("its own images are shown as Generate shows them", () => {
    expect(editCardView(idle, { own: true, covered: false })).toEqual(idle);
  });

  test("waiting for a mask, the image is covered and the bars wait for hover", () => {
    const blocked = cardView({ state: "blocked", images: true, atCompany: false, partial: false });
    expect(editCardView(blocked, { own: false, covered: true })).toMatchObject({
      phase: "empty",
      noPill: true,
      media: "image",
      message: false,
      stripes: false,
      bottomAtRest: false,
    });
  });
});

describe("the Edit card's box", () => {
  afterEach(() => cardMedia.setState({ dims: {}, shown: {}, bases: {} }));
  const frame = { id: "x" };

  test("square with nothing, then the shape of the image coming in, then of its own", () => {
    const media = {
      dims: { [PHOTO]: { w: 768, h: 1024 }, [OTHER]: { w: 1024, h: 768 } },
      shown: {},
      bases: {},
    };
    expect(editLayout(frame, null, media)).toMatchObject({ w: 320, h: 320, assetId: null });
    const withBase = { ...media, bases: { x: PHOTO } };
    expect(editLayout(frame, null, withBase)).toMatchObject({ w: 320, h: 320 / 0.75, assetId: PHOTO });
    expect(editLayout(frame, { assetIds: [OTHER] }, withBase)).toMatchObject({
      w: 320,
      h: 240,
      assetId: OTHER,
    });
  });

  test("every Edit card's incoming image comes from the analysis, drawn or not", async () => {
    let doc = docOf(
      [
        node("u", "image.upload", { assetIds: [PHOTO] }),
        node("x", "image.edit", editParams),
        node("y", "image.edit", editParams),
        node("z", "image.edit", editParams),
      ],
      [edge("u", "images", "x", "image"), edge("u", "images", "y", "image")],
    );
    doc = applyOps(doc, [{ op: "setResult", id: "y", result: done([OTHER]) }]).doc;
    const fingerprints = await resolveFingerprints(planFingerprints(doc, registry, ctx), new Map());
    const analysis = analyzeGraph(doc, registry, ctx, fingerprints);
    // y shows what it made, z has nothing coming in, and the upload isn't an Edit node.
    expect(basesOf(doc, analysis)).toEqual({ x: PHOTO });
    cardMedia.setState({ bases: { x: OTHER, gone: PHOTO } });
    syncBases(doc, analysis);
    expect(cardMedia.getState().bases).toEqual({ x: PHOTO });
  });

  test("its saved size follows only its own first image", () => {
    const input = { params: {}, result: null };
    expect(editRest.key(input)).toBe("input");
    expect(editRest.key({ ...input, result: done([OTHER]) })).toBe(`image:${OTHER}`);
  });
});

describe("Edit from the node menu", () => {
  const sizes = { [PHOTO]: { w: 768, h: 1024 }, [OTHER]: { w: 1024, h: 1024 } };

  test("an image node gets an Edit node beside it, its image wired in, as one change", () => {
    let doc = docOf([
      { ...node("g", "image.generate", { model: banana.key }), position: { x: 100, y: 230 } },
    ]);
    doc = applyOps(doc, [{ op: "setResult", id: "g", result: done([PHOTO]) }]).doc;
    expect(editableOutput(doc, registry, "g")).toBe("images");
    const plan = planEditFrom({ doc, registry, ctx, sourceId: "g", sizes, upToDate: true })!;
    const added = plan.ops.flatMap((op) => (op.op === "addNode" ? [op.node] : []));
    expect(added.map((n) => n.type)).toEqual(["image.edit"]);
    const edit = added[0]!;
    expect(edit.id).toBe(plan.editId);
    // 140 to the right of the 320-wide source, tops aligned off the grid (design blc5dYrGqG), at
    // the image's shape.
    expect(edit.position).toEqual({ x: 100 + 320 + 140, y: 230 });
    expect(edit.size).toEqual({ w: 320, h: 320 / 0.75 });
    expect(plan.ops.filter((op) => op.op === "addEdge").map((op) => op.op === "addEdge" && op.edge)).toEqual([
      expect.objectContaining({
        source: "g",
        sourceHandle: "images",
        target: plan.editId,
        targetHandle: "image",
      }),
    ]);
    // Applies cleanly.
    expect(() => applyOps(doc, plan.ops)).not.toThrow();
  });

  test("a node showing several images hands on only the one on show, held by an Assets node", () => {
    let doc = docOf([node("g", "image.generate", { model: banana.key, batch: 2 })]);
    doc = applyOps(doc, [{ op: "setResult", id: "g", result: done([PHOTO, OTHER]) }]).doc;
    const plan = planEditFrom({ doc, registry, ctx, sourceId: "g", shown: OTHER, sizes })!;
    const added = plan.ops.flatMap((op) => (op.op === "addNode" ? [op.node] : []));
    expect(added.map((n) => n.type)).toEqual(["image.asset", "image.edit"]);
    const [pin, edit] = added;
    expect(pin!.params).toEqual({ assetIds: [OTHER] });
    expect(edit!.position.x).toBeGreaterThan(pin!.position.x);
    const after = applyOps(doc, plan.ops).doc;
    expect(Object.values(after.edges).map((e) => [e.source, e.target, e.targetHandle])).toEqual([
      [pin!.id, edit!.id, "image"],
    ]);
  });

  test("an image the source's next run would replace is held by an Assets node, so the mask keeps fitting", () => {
    let doc = docOf([node("g", "image.generate", { model: banana.key })]);
    doc = applyOps(doc, [{ op: "setResult", id: "g", result: done([PHOTO]) }]).doc;
    for (const upToDate of [false, undefined]) {
      const plan = planEditFrom({
        doc,
        registry,
        ctx,
        sourceId: "g",
        sizes,
        ...(upToDate === false && { upToDate }),
      })!;
      const added = plan.ops.flatMap((op) => (op.op === "addNode" ? [op.node] : []));
      expect(added.map((n) => n.type)).toEqual(["image.asset", "image.edit"]);
      expect(added[0]!.params).toEqual({ assetIds: [PHOTO] });
    }
    // A locked one keeps its images whatever its settings say.
    const locked = applyOps(doc, [{ op: "setLocked", id: "g", locked: true }]).doc;
    const plan = planEditFrom({ doc: locked, registry, ctx, sourceId: "g", sizes })!;
    expect(plan.ops.flatMap((op) => (op.op === "addNode" ? [op.node.type] : []))).toEqual(["image.edit"]);
  });

  test("Upload and Assets nodes edit what they hold; nodes without an image have no Edit", () => {
    const doc = docOf([
      node("u", "image.upload", { assetIds: [PHOTO] }),
      node("e", "image.upload", { assetIds: [] }),
      node("p", "prompt", { text: "words" }),
    ]);
    expect(editableOutput(doc, registry, "u")).toBe("images");
    expect(editableOutput(doc, registry, "e")).toBeNull();
    expect(editableOutput(doc, registry, "p")).toBeNull();
    expect(planEditFrom({ doc, registry, ctx, sourceId: "p", sizes })).toBeNull();
  });

  test("in a locked frame the new node goes outside it", () => {
    const frame = { ...node("f", "frame"), size: { w: 800, h: 600 }, locked: true };
    const source = { ...node("u", "image.upload", { assetIds: [PHOTO] }), parentId: "f" };
    const doc = docOf([frame, source]);
    const plan = planEditFrom({ doc, registry, ctx, sourceId: "u", sizes })!;
    const edit = plan.ops.flatMap((op) => (op.op === "addNode" ? [op.node] : []))[0]!;
    expect(edit.parentId).toBeNull();
  });
});
