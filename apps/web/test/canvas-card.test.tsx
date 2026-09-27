// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EngineContext } from "@openfield/canvas/engine/types";
import { idleRuntime } from "@openfield/canvas/engine/types";
import {
  type CardMediaView,
  cardBox,
  cardLayout,
  restBox,
  restKey,
} from "@openfield/canvas/nodes/generate/card-size";
import { GENERATE_PORTS, generateSpec } from "@openfield/canvas/nodes/generate/spec";
import { createNodeRegistry } from "@openfield/canvas/nodes/registry";
import type { ModelListItem } from "@openfield/core";
import type { CanvasEdge, CanvasNode } from "@openfield/core/canvas";
import { Position } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createEdgeCache, createNodeCache, type FlowNodeInputs } from "../src/canvas/editor/flow/adapter";
import { edgeTypes } from "../src/canvas/editor/flow/edges";
import {
  clockAt,
  linkActivity,
  PULSE,
  pulseEase,
  pulseEnds,
  pulseHead,
  pulseLength,
} from "../src/canvas/editor/flow/pulse";
import { type PulseParts, startPulse } from "../src/canvas/editor/flow/pulse-clock";
import { createBoxFollower, followBoxes } from "../src/canvas/engine/boxes";
import {
  cardMedia,
  generateBox,
  generateRest,
  rememberImageSize,
  showImage,
} from "../src/canvas/nodes/generate/card-media";
import { cardView } from "../src/canvas/nodes/generate/card-state";
import type { NodeDefinition } from "../src/canvas/nodes/registry";
import { companyWaitOf } from "../src/canvas/nodes/shell/company-wait";
import { railLayout } from "../src/canvas/nodes/shell/ports";
import {
  type CanvasStore,
  CanvasStoreProvider,
  createCanvasStore,
  emptyDocument,
  fromDocument,
} from "../src/canvas/store";
import type { LiveBatch } from "../src/lib/live";
import { banana, flare } from "./fixtures";

// The Generate card's size rule and states (design Y5jjx, SwytB) and which links pulse while a
// node generates (design YQPWR, motion spec IMRkA).

const CANVAS_ID = "01K6BQ8000000000000000CNVS";
const ULID = (n: number) => `01K6BQ80000000000000AS${String(n).padStart(4, "0")}`;
const models: ModelListItem[] = [banana, { ...flare, ready: true, key: "openai:flare" }];
const ctx: EngineContext = {
  models,
  model: (key) => models.find((m) => m.key === key),
  defaultModel: "google:banana",
};
const NO_MEDIA: CardMediaView = { dims: {}, shown: {} };

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: "image.generate",
  typeVersion: 1,
  position: { x: 0, y: 0 },
  parentId: null,
  collapsed: false,
  title: null,
  params: {},
  presetLocks: [],
  result: null,
  ...extra,
});

const edge = (id: string, source: string, target: string, extra: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id,
  source,
  sourceHandle: "images",
  target,
  targetHandle: "input_images",
  kind: "data",
  ...extra,
});

const box = (ratio: number) => {
  const { w, h, contain } = cardBox(ratio);
  return [Math.round(w * 100) / 100, Math.round(h * 100) / 100, contain];
};

/** Generate as the editor registers it: its spec plus the box that follows the image on show. */
const generateDefinition = {
  ...generateSpec,
  box: generateBox,
  rest: generateRest,
} as unknown as NodeDefinition;

describe("card size", () => {
  test("320 wide and 320 ÷ ratio tall, between 180 and 480, as the height rule lists", () => {
    expect(box(1)).toEqual([320, 320, false]);
    expect(box(4 / 5)).toEqual([320, 400, false]);
    // Exact, not Pencil's rounded 427.
    expect(cardBox(3 / 4).h).toBeCloseTo(426.667, 3);
    expect(box(2 / 3)).toEqual([320, 480, false]);
    expect(box(4 / 3)).toEqual([320, 240, false]);
    expect(box(3 / 2)).toEqual([320, 213.33, false]);
    expect(box(16 / 9)).toEqual([320, 180, false]);
  });

  test("past a limit the height stays and the width follows the ratio, from 240 to 480", () => {
    expect(box(9 / 16)).toEqual([270, 480, false]);
    expect(box(21 / 9)).toEqual([420, 180, false]);
    expect(box(1 / 2)).toEqual([240, 480, false]);
    expect(box(2)).toEqual([360, 180, false]);
  });

  test("only ratios beyond both limits show the whole image inside the card", () => {
    expect(box(1 / 4)).toEqual([240, 480, true]);
    expect(box(4)).toEqual([480, 180, true]);
    expect(box(1 / 8)).toEqual([240, 480, true]);
    expect(box(8)).toEqual([480, 180, true]);
    // Nonsense is square.
    expect(box(Number.NaN)).toEqual([320, 320, false]);
  });

  test("before an image: the chosen aspect ratio, the model's default, and Auto as a square", () => {
    const frame = { id: "g" };
    const at = (params: Record<string, unknown>) =>
      cardLayout({ frame, params, result: null, ctx, media: NO_MEDIA });
    expect(at({ model: "google:banana", size: { kind: "aspect", ratio: "16:9" } })).toMatchObject({
      w: 320,
      h: 180,
      exact: true,
      short: true,
      narrow: false,
    });
    // Banana's default is Auto: square until the first image arrives.
    expect(at({ model: "google:banana" })).toMatchObject({ w: 320, h: 320 });
    // A ratio the model lacks resolves to its default, as the inspector shows it.
    expect(at({ model: "openai:flare", size: { kind: "aspect", ratio: "16:9" } })).toMatchObject({ h: 320 });
    expect(at({ model: "openai:flare", size: { kind: "aspect", ratio: "2:3" } })).toMatchObject({ h: 480 });
    expect(at({ size: { kind: "pixels", width: 900, height: 1600 } })).toMatchObject({
      w: 270,
      h: 480,
      narrow: true,
    });
  });

  test("after a run: the shown image's shape, the saved box while its size loads, and the pager", () => {
    const images = [ULID(1), ULID(2)];
    const frame = { id: "g", size: { w: 320, h: 400 } };
    const params = { model: "google:banana", size: { kind: "aspect", ratio: "1:1" } };
    const result = { assetIds: images };
    // Not loaded yet: the saved box stands in, so a reopened canvas doesn't jump.
    const loading = cardLayout({ frame, params, result, ctx, media: NO_MEDIA });
    expect(loading).toMatchObject({ w: 320, h: 400, exact: false, index: 0, count: 2, assetId: images[0] });
    // Its size is known: the image wins over the chosen ratio.
    const dims = { [images[0]!]: { w: 1024, h: 576 }, [images[1]!]: { w: 768, h: 1024 } };
    expect(cardLayout({ frame, params, result, ctx, media: { dims, shown: {} } })).toMatchObject({
      w: 320,
      h: 180,
      exact: true,
    });
    // A thumbnail's rounded size draws the card, but isn't exact enough to save.
    const thumb = { [images[0]!]: { w: 457, h: 256, approx: true as const } };
    const drawn = cardLayout({ frame, params, result, ctx, media: { dims: thumb, shown: {} } });
    expect(drawn).toMatchObject({ h: 180, exact: false });
    expect(drawn.w).toBeCloseTo(321.33, 2);
    // The pager shows the second image, and the card takes its shape.
    const second = cardLayout({ frame, params, result, ctx, media: { dims, shown: { g: images[1]! } } });
    expect(second.index).toBe(1);
    expect(second.h).toBeCloseTo(426.667, 3);
    // A picked image that's gone falls back to the first.
    const gone = cardLayout({ frame, params, result, ctx, media: { dims, shown: { g: ULID(9) } } });
    expect(gone.index).toBe(0);
  });

  test("the node type's box follows its card, and React Flow gets it as the node's size", () => {
    const frame = { id: "g", type: "image.generate" as const, position: { x: 0, y: 0 }, parentId: null };
    const layout = generateBox({
      frame: { ...frame, collapsed: false, title: null, presetLocks: [], typeVersion: 1 },
      params: { model: "google:banana", size: { kind: "aspect", ratio: "4:5" } },
      result: null,
      ctx,
    });
    expect(layout).toEqual({ w: 320, h: 400 });
    expect(generateSpec.resizable).toBe(false);

    const doc = fromDocument({
      ...emptyDocument(CANVAS_ID, "Cards"),
      nodes: [node("g", { size: { w: 320, h: 400 } }), node("n", { type: "note", size: { w: 240, h: 240 } })],
    }).slice;
    const defs: Record<string, NodeDefinition> = {
      "image.generate": { type: "image.generate", size: { w: 320, h: 320 } } as unknown as NodeDefinition,
      note: { type: "note", size: { w: 240, h: 240 } } as unknown as NodeDefinition,
    };
    let boxed = { w: 320, h: 180 };
    const inputs = (extra: Partial<FlowNodeInputs> = {}): FlowNodeInputs => ({
      doc,
      selection: { nodeIds: [], edgeIds: [] },
      readOnly: false,
      tool: "select",
      measured: new Map(),
      findHit: null,
      definition: (type) => defs[type],
      boxOf: (f) => (f.type === "image.generate" ? boxed : undefined),
      ...extra,
    });
    const build = createNodeCache();
    const first = build(inputs());
    expect(first[0]).toMatchObject({ width: 320, height: 180, measured: { width: 320, height: 180 } });
    expect(first[1]).toMatchObject({ width: 240, height: 240 });
    // An aspect change is a new box: that node alone gets a new object.
    boxed = { w: 270, h: 480 };
    const second = build(inputs());
    expect(second[0]).not.toBe(first[0]!);
    expect(second[0]).toMatchObject({ width: 270, height: 480 });
    expect(second[1]).toBe(first[1]!);
    // Collapsed, it folds to the type's own width whatever its image.
    const collapsed = fromDocument({
      ...emptyDocument(CANVAS_ID, "Cards"),
      nodes: [node("g", { collapsed: true })],
    }).slice;
    const [folded] = createNodeCache()(inputs({ doc: collapsed }));
    expect(folded!.width).toBe(320);
    expect(folded!.height).toBeUndefined();
  });
});

describe("new cards", () => {
  const registry = createNodeRegistry([generateDefinition]);
  const at = { x: 0, y: 0 };

  test("a new Generate node starts at the shape its default aspect ratio asks for", () => {
    const portrait = registry.instantiate("image.generate", {
      position: at,
      ctx: { ...ctx, defaultAspect: "3:4" },
    });
    expect(portrait.params.size).toEqual({ kind: "aspect", ratio: "3:4" });
    expect(portrait.size!.w).toBe(320);
    expect(portrait.size!.h).toBeCloseTo(426.667, 3);
    expect(
      registry.instantiate("image.generate", { position: at, ctx: { ...ctx, defaultAspect: "16:9" } }).size,
    ).toEqual({ w: 320, h: 180 });
    // A ratio the model lacks falls back to the model's default (Auto), as the inspector shows it.
    expect(
      registry.instantiate("image.generate", { position: at, ctx: { ...ctx, defaultAspect: "9:16" } }).size,
    ).toEqual({ w: 320, h: 320 });
    // No default aspect: Auto, square until the first image.
    expect(registry.instantiate("image.generate", { position: at, ctx }).size).toEqual({ w: 320, h: 320 });
  });
});

describe("card states", () => {
  const view = (state: Parameters<typeof cardView>[0]["state"], images = false, extra = {}) =>
    cardView({ state, images, atCompany: false, partial: false, ...extra });

  test("at rest only states that need attention show a pill; up to date shows nothing", () => {
    expect(view("done", true)).toMatchObject({
      phase: "done",
      pillAtRest: false,
      media: "image",
      action: "run",
    });
    expect(view("stale", true)).toMatchObject({ phase: "changed", pillAtRest: true, media: "faded" });
    for (const state of ["queued", "running", "failed", "blocked", "canceled"] as const) {
      expect(view(state).pillAtRest).toBe(true);
    }
  });

  test("an empty card shows its prompt and Run without hover, and no pill yet", () => {
    expect(view("idle")).toMatchObject({
      phase: "empty",
      noPill: true,
      bottomAtRest: true,
      emptyGlyph: true,
      media: "placeholder",
      action: "run",
    });
  });

  test("Stop for anything running, Cancel for anything queued, nothing beside a message", () => {
    expect(view("running")).toMatchObject({
      phase: "generating",
      action: "stop",
      progress: true,
      emptyGlyph: true,
    });
    expect(view("running", true)).toMatchObject({ media: "dimmed", emptyGlyph: false });
    // A preview frame of the new image dims like the last image does (OPInN).
    expect(view("running", false, { partial: true })).toMatchObject({ media: "dimmed", emptyGlyph: false });
    expect(view("queued")).toMatchObject({ phase: "waiting", action: "cancel", progress: false });
    expect(view("running", false, { atCompany: true })).toMatchObject({
      phase: "atCompany",
      action: "cancel",
      progress: false,
    });
    for (const state of ["failed", "blocked", "canceled"] as const) {
      expect(view(state)).toMatchObject({ message: true, action: null, emptyGlyph: false });
    }
    expect(view("blocked").stripes).toBe(true);
  });

  test("after a result the last image stays at 50% behind the message", () => {
    expect(view("failed", true).media).toBe("dimmed");
    expect(view("canceled", true).media).toBe("dimmed");
    expect(view("failed").media).toBe("placeholder");
  });
});

describe("link pulse", () => {
  test("a link lights up while the node it feeds generates; queued and finished ones stay idle", () => {
    expect(linkActivity({ state: "running" }, false)).toBe("active");
    expect(linkActivity({ state: "queued" }, false)).toBe("idle");
    expect(linkActivity({ state: "running" }, true)).toBe("waiting");
    expect(linkActivity({ state: "queued" }, true)).toBe("waiting");
    for (const state of ["done", "failed", "canceled", "blocked", "idle"] as const) {
      expect(linkActivity({ state }, false)).toBe("idle");
    }
    expect(linkActivity(undefined, false)).toBe("idle");
  });

  test("every link into a generating node pulses; links out of it, and arrows, stay idle", () => {
    const store = createCanvasStore({
      id: CANVAS_ID,
      name: "Mug campaign",
      graphVersion: 1,
      updatedAt: "2026-09-24T09:00:00.000Z",
      graph: {
        ...emptyDocument(CANVAS_ID, "Mug campaign"),
        nodes: [
          node("prompt", { type: "prompt" }),
          node("ref", { type: "image.upload" }),
          node("gen"),
          node("vary", { type: "image.variations" }),
          node("later"),
          node("note", { type: "note" }),
        ],
        edges: [
          edge("prompt-gen", "prompt", "gen", { sourceHandle: "text", targetHandle: "prompt" }),
          edge("ref-gen", "ref", "gen"),
          edge("gen-vary", "gen", "vary", { targetHandle: "image" }),
          edge("vary-later", "vary", "later"),
          edge("note-gen", "note", "gen", {
            sourceHandle: "arrow-source-right",
            targetHandle: "arrow-target-left",
            kind: "annotation",
          }),
        ],
      },
    });
    const { actions } = store.getState();
    actions.setRuntime({
      gen: { ...idleRuntime(), state: "running" },
      vary: { ...idleRuntime(), state: "queued" },
    });
    // Rendering to a string reads a zustand store's initial state; this hands it the current one.
    const current: CanvasStore = { ...store, getInitialState: store.getState };
    // Each link as the canvas draws it: the adapter's edge type, then that type's component.
    const links = () => {
      const state = store.getState();
      const flows = createEdgeCache()({
        doc: state.doc,
        selection: state.selection,
        readOnly: false,
        portType: () => "image",
      });
      return Object.fromEntries(
        flows.map((flow) => {
          const Edge = edgeTypes[flow.type ?? ""];
          if (!Edge) throw new Error(`No edge type ${flow.type}`);
          const html = renderToStaticMarkup(
            <CanvasStoreProvider store={current}>
              <svg aria-hidden="true">
                <Edge
                  id={flow.id}
                  source={flow.source}
                  target={flow.target}
                  type={flow.type}
                  data={flow.data}
                  selected={false}
                  sourceX={0}
                  sourceY={0}
                  targetX={240}
                  targetY={80}
                  sourcePosition={Position.Right}
                  targetPosition={Position.Left}
                />
              </svg>
            </CanvasStoreProvider>,
          );
          if (html.includes("of-pulse-core")) return [flow.id, "pulse"];
          if (html.includes("of-arrow")) return [flow.id, "arrow"];
          return [flow.id, /data-link="(\w+)"/.exec(html)?.[1]];
        }),
      );
    };
    // Into the generating node: pulses. Out of it, into a node waiting in line: idle.
    expect(links()).toEqual({
      "prompt-gen": "pulse",
      "ref-gen": "pulse",
      "gen-vary": "idle",
      "vary-later": "idle",
      "note-gen": "arrow",
    });
    // Generate finishes, Variations starts: the pulse moves along with the work.
    actions.setRuntime({
      gen: { ...idleRuntime(), state: "done" },
      vary: { ...idleRuntime(), state: "running" },
    });
    expect(links()).toEqual({
      "prompt-gen": "idle",
      "ref-gen": "idle",
      "gen-vary": "pulse",
      "vary-later": "idle",
      "note-gen": "arrow",
    });
  });

  test("a Batch run or a Flex call waits at the company: lit, but no pulse", () => {
    const running = { state: "running" as const, jobSetIds: [ULID(1)] };
    const batch: LiveBatch = { providerId: "google", state: "submitting", stopping: false };
    const flex: EngineContext = {
      ...ctx,
      runSpeed: (model) => ({
        speed: model.key === "google:banana" ? "flex" : "standard",
        requested: "flex",
        fellBack: model.key !== "google:banana",
        name: "Flex",
        requestedName: "Flex",
      }),
    };
    expect(companyWaitOf(running, () => batch, banana, ctx)).toEqual({ speed: "batch", ...batch });
    expect(companyWaitOf(running, () => undefined, banana, flex)).toEqual({
      speed: "flex",
      providerId: "google",
    });
    // A model without Flex runs at Standard: it generates in the open, so its links pulse.
    expect(companyWaitOf(running, () => undefined, models[1], flex)).toBeNull();
    // Queued Flex work hasn't reached the company yet; finished work waits for nothing.
    expect(companyWaitOf({ ...running, state: "queued" }, () => undefined, banana, flex)).toBeNull();
    expect(companyWaitOf({ ...running, state: "done" }, () => batch, banana, flex)).toBeNull();
    expect(companyWaitOf(undefined, () => batch, banana, flex)).toBeNull();
  });

  test("72 px long, never more than 45% of a short link", () => {
    expect(pulseLength(500)).toBe(72);
    expect(pulseLength(86.5)).toBeCloseTo(38.925, 3);
  });

  test("the head follows the storyboard: leaving at 0.55 s, halfway at 0.80 s, arriving at 1.05 s", () => {
    // The recipe link (212×90): 236.5 long, a 72 px pulse.
    const total = 236.5;
    expect(pulseHead(550, total)).toBeCloseTo(72.9, 0);
    expect(pulseHead(800, total)).toBeCloseTo(154.25, 1);
    expect(pulseHead(1050, total)).toBeCloseTo(235.6, 0);
    expect(pulseHead(0, total)).toBe(0);
    // Its tail reaches the target as the travel ends, then 0.8 s of rest.
    expect(pulseHead(PULSE.travelMs - 0.001, total)).toBeCloseTo(total + 72, 1);
    expect(pulseHead(PULSE.travelMs, total)).toBeNull();
    expect(pulseHead(2399, total)).toBeNull();
  });

  test("coming out of a port, the pulse keeps its whole gradient: no fade in or out", () => {
    // A straight link along x, 236.5 long: the pulse is 72 px, so at head 40 its tail is still 32 px
    // under the source port. The ramp runs from -32 to 40, not squeezed into 0 to 40.
    const total = 236.5;
    const straight = (d: number) => ({ x: d, y: 0 });
    expect(pulseEnds(40, total, straight)).toEqual([
      { x: -32, y: 0 },
      { x: 40, y: 0 },
    ]);
    // At the port's edge (12 px out) the colour is 61% along the ramp, 76% of full: sliding out.
    const [tail, head] = pulseEnds(40, total, straight);
    expect((12 - tail.x) / (head.x - tail.x) / 0.8).toBeCloseTo(0.764, 3);
    // Sinking into the target, the head runs on past the end along the link's direction.
    expect(pulseEnds(260, total, straight)).toEqual([
      { x: 188, y: 0 },
      { x: 260, y: 0 },
    ]);
    // In the middle both ends are on the link itself.
    expect(pulseEnds(154, total, straight)).toEqual([
      { x: 82, y: 0 },
      { x: 154, y: 0 },
    ]);
    // A link leaving straight down keeps going down behind its start.
    const [below] = pulseEnds(10, 200, (d) => ({ x: 5, y: 100 + d }));
    expect(below).toEqual({ x: 5, y: 38 });
  });

  test("one 2.4 s clock for the whole canvas, eased in and out", () => {
    expect(clockAt(5000)).toEqual({ cycle: 2, phase: 200 });
    expect(pulseEase(0.5)).toBeCloseTo(0.5, 6);
    expect(pulseEase(0.25) + pulseEase(0.75)).toBeCloseTo(1, 6);
    expect(pulseEase(0.1)).toBeLessThan(0.1);
  });
});

describe("ports", () => {
  test("Generate keeps its style slot: Prompt 36 above the middle, images level with the output", () => {
    const offsets = (direction: "in" | "out") =>
      railLayout(GENERATE_PORTS, direction).map(({ port, offset }) => [port.id, offset]);
    // Design Y5jjx: In · Prompt at H/2-36, In · Images at H/2 (the style slot at H/2+36 stays empty).
    expect(offsets("in")).toEqual([
      ["prompt", -36],
      ["input_images", 0],
    ]);
    expect(offsets("out")).toEqual([["images", 0]]);
    // Ports without a kept slot still centre on the middle as a group.
    const two = railLayout(
      [
        { ...GENERATE_PORTS[0]!, id: "a" },
        { ...GENERATE_PORTS[0]!, id: "b" },
        { ...GENERATE_PORTS[2]!, id: "c", keepSlot: false },
      ],
      "in",
    );
    expect(two.map((p) => p.offset)).toEqual([-18, 18]);
  });
});

describe("saved size", () => {
  const registry = createNodeRegistry([generateDefinition]);
  const wide = { model: "google:banana", size: { kind: "aspect", ratio: "16:9" } };
  const docWith = (nodes: CanvasNode[]) =>
    fromDocument({ ...emptyDocument(CANVAS_ID, "Boxes"), nodes }).slice;
  afterEach(() => cardMedia.setState({ dims: {}, shown: {} }));

  test("rests on the first image, else on the settings that pick the shape", () => {
    expect(restKey(wide, null)).toBe(restKey(wide, { assetIds: [] }));
    expect(restKey(wide, { assetIds: [ULID(1), ULID(2)] })).toBe(`image:${ULID(1)}`);
    expect(restKey({ ...wide, prompt: "a new prompt" }, null)).toBe(restKey(wide, null));
    expect(restKey({ ...wide, size: { kind: "aspect", ratio: "1:1" } }, null)).not.toBe(restKey(wide, null));
    // Saved to the hundredth of a pixel; a thumbnail's size is never saved.
    const frame = node("g");
    expect(
      restBox({ frame, params: { size: { kind: "aspect", ratio: "3:4" } }, result: null, ctx }, NO_MEDIA),
    ).toEqual({ w: 320, h: 426.67 });
    const result = { assetIds: [ULID(1)] };
    const approx = { dims: { [ULID(1)]: { w: 457, h: 256, approx: true as const } }, shown: {} };
    expect(restBox({ frame, params: wide, result, ctx }, approx)).toBeNull();
    expect(restBox({ frame, params: wide, result, ctx }, NO_MEDIA)).toBeNull();
  });

  test("opening never writes; a change made here does, once the size is exact", () => {
    const follower = createBoxFollower(registry);
    // Saved before the image card: 320×400 for a 16:9 card. Opening it writes nothing.
    let doc = docWith([node("g", { size: { w: 320, h: 400 }, params: wide })]);
    follower.seed(doc);
    expect(follower.check(doc, ctx)).toEqual([]);
    // A new aspect ratio chosen here: the saved size follows.
    doc = docWith([
      node("g", { size: { w: 320, h: 400 }, params: { ...wide, size: { kind: "aspect", ratio: "1:1" } } }),
    ]);
    expect(follower.check(doc, ctx)).toEqual([{ op: "resizeNode", id: "g", size: { w: 320, h: 320 } }]);
    // A run's images land: nothing until the first image's exact size is known.
    const result = { ...doneResult(), assetIds: [ULID(1), ULID(2)] };
    doc = docWith([node("g", { size: { w: 320, h: 320 }, params: wide, result })]);
    expect(follower.check(doc, ctx)).toEqual([]);
    expect([...follower.waiting()]).toEqual(["g"]);
    // A thumbnail's rounded size doesn't count; the run's own size does.
    rememberImageSize(ULID(1), 457, 256, { approx: true });
    expect(follower.check(doc, ctx, follower.waiting())).toEqual([]);
    rememberImageSize(ULID(1), 1344, 768);
    expect(follower.check(doc, ctx, [...follower.waiting()])).toEqual([
      { op: "resizeNode", id: "g", size: { w: 320, h: 182.86 } },
    ]);
    expect(follower.waiting().size).toBe(0);
    // Paging to another image is only for looking.
    rememberImageSize(ULID(2), 768, 1024);
    showImage("g", ULID(2));
    expect(follower.check(doc, ctx)).toEqual([]);
    // Under a pixel off isn't worth a save.
    rememberImageSize(ULID(3), 1600, 900);
    doc = docWith([
      node("g", { size: { w: 320.4, h: 180 }, params: wide, result: { ...result, assetIds: [ULID(3)] } }),
    ]);
    expect(follower.check(doc, ctx)).toEqual([]);
  });

  test("in the editor: an edit writes without an undo step of its own; opening and reloads never do", () => {
    const detail = (nodes: CanvasNode[]) => ({
      id: CANVAS_ID,
      name: "Boxes",
      graphVersion: 1,
      updatedAt: "2026-09-24T09:00:00.000Z",
      graph: { ...emptyDocument(CANVAS_ID, "Boxes"), nodes },
    });
    const stale = [node("g", { size: { w: 320, h: 400 }, params: wide })];
    const store = createCanvasStore(detail(stale));
    const stop = followBoxes(
      store,
      registry,
      () => ctx,
      () => () => {},
    );
    const size = () => store.getState().doc.nodes.g?.size;
    expect(size()).toEqual({ w: 320, h: 400 });
    expect(store.getState().persist.status).toBe("saved");

    const { actions } = store.getState();
    actions.apply([{ op: "setParams", id: "g", patch: { size: { kind: "aspect", ratio: "1:1" } } }]);
    expect(size()).toEqual({ w: 320, h: 320 });
    expect(store.getState().history.past).toHaveLength(1);
    // Undo puts the ratio back, and the size follows it.
    actions.undo();
    expect(size()).toEqual({ w: 320, h: 180 });

    // A reload (Reload after a conflict, a restore) is an opening: nothing is written.
    actions.loadDetail(detail(stale));
    expect(size()).toEqual({ w: 320, h: 400 });
    expect(store.getState().persist.status).toBe("saved");
    stop();
  });
});

describe("pulse clock", () => {
  type Attrs = Map<string, string>;
  const element = (extra: object = {}) => {
    const attrs: Attrs = new Map();
    return Object.assign(
      {
        attrs,
        getAttribute: (n: string) => attrs.get(n) ?? null,
        setAttribute: (n: string, v: string) => attrs.set(n, v),
      },
      extra,
    );
  };
  const parts = () => {
    const line = element({ getTotalLength: () => 236.5, getPointAtLength: (d: number) => ({ x: d, y: 0 }) });
    const core = element();
    const glow = element();
    const gradient = element();
    return { line, core, glow, gradient, pulse: { line, core, glow, gradient } as unknown as PulseParts };
  };

  test("a new pulse waits for the next cycle; the loop stops once no pulse is left", () => {
    const frames: ((now: number) => void)[] = [];
    const canceled: number[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const before = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
    g.requestAnimationFrame = (fn: (now: number) => void) => frames.push(fn);
    g.cancelAnimationFrame = (id: number) => canceled.push(id);
    const now = spyOn(performance, "now");
    try {
      const cycle = PULSE.cycleMs;
      // 0.7 s into cycle 10: too late to start mid-path, so it waits for cycle 11.
      now.mockReturnValue(10 * cycle + 700);
      const late = parts();
      const handle = startPulse(late.pulse);
      expect(frames).toHaveLength(1);
      frames.shift()!(10 * cycle + 800);
      expect(late.core.attrs.get("visibility")).toBe("hidden");
      // Cycle 11 at 0.8 s: halfway, drawn with its gradient along the pulse.
      frames.shift()!(11 * cycle + 800);
      expect(late.core.attrs.get("visibility")).toBe("visible");
      expect(Number(late.gradient.attrs.get("x2"))).toBeCloseTo(154.25, 1);
      expect(Number(late.gradient.attrs.get("x1"))).toBeCloseTo(82.25, 1);
      // Just after a cycle starts counts as its start: a link that turns active then goes at once,
      // in step with the others.
      now.mockReturnValue(12 * cycle + 20);
      const prompt = parts();
      const second = startPulse(prompt.pulse);
      // One loop for both.
      expect(frames).toHaveLength(1);
      frames.shift()!(12 * cycle + 800);
      expect(prompt.core.attrs.get("visibility")).toBe("visible");
      expect(prompt.gradient.attrs.get("x2")).toBe(late.gradient.attrs.get("x2"));
      // Resting between pulses hides them.
      frames.shift()!(12 * cycle + 2000);
      expect(late.core.attrs.get("visibility")).toBe("hidden");
      // Stopping one keeps the loop for the other; stopping the last cancels the queued frame.
      handle.stop();
      expect(canceled).toEqual([]);
      expect(frames).toHaveLength(1);
      second.stop();
      expect(canceled).toHaveLength(1);
      // Even if that frame ran anyway, it would find nothing to move and ask for no more.
      frames.shift()!(13 * cycle);
      expect(frames).toHaveLength(0);
    } finally {
      now.mockRestore();
      g.requestAnimationFrame = before.raf;
      g.cancelAnimationFrame = before.caf;
    }
  });
});

function doneResult() {
  return {
    state: "done" as const,
    assetIds: [] as string[],
    jobSetId: null,
    jobSetIds: [],
    outputs: [],
    fingerprint: "sha256:a",
    costUsd: null,
    ranAt: null,
    error: null,
  };
}
