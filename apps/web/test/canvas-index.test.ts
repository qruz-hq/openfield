// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeAll, describe, expect, test } from "bun:test";
import { type CanvasSummary, setFormatLocale } from "@openfield/core";
import { CANVAS_SCHEMA, type CanvasDocument, type CanvasNode } from "@openfield/core/canvas";
import { editedLabel } from "../src/canvas/index/edited";
import { describeIssue, exportFileName, parseCanvasFile, remapDocument } from "../src/canvas/index/file";
import { roundedRectPath, sketchLayout } from "../src/canvas/index/sketch";
import { matchesQuery, sortCanvases } from "../src/canvas/index/sort";
import { templateCopy } from "../src/canvas/index/templates";

beforeAll(() => setFormatLocale("en-US"));

const CANVAS_ID = "01K6BQ8000000000000000CNVS";
const AT = "2026-09-23T09:12:04.118Z";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: "prompt",
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

const doc = (nodes: CanvasNode[], edges: CanvasDocument["edges"] = []): CanvasDocument => ({
  schema: CANVAS_SCHEMA,
  id: CANVAS_ID,
  name: "Lighthouse series",
  createdAt: AT,
  updatedAt: AT,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  edges,
  comments: [],
  meta: {},
});

const summary = (id: string, extra: Partial<CanvasSummary> = {}): CanvasSummary => ({
  id,
  name: id,
  previewUrl: null,
  createdAt: AT,
  updatedAt: AT,
  nodeCount: 0,
  coverAssetId: null,
  graphVersion: 1,
  ...extra,
});

describe("edited label", () => {
  // Local noon, so calendar days don't depend on the machine's time zone.
  const now = new Date(2026, 8, 24, 12, 0, 0).getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;

  test("reads relative under a week (§7.3)", () => {
    expect(editedLabel(ago(20_000), now)).toBe("Edited a moment ago");
    expect(editedLabel(ago(10 * MIN), now)).toBe("Edited 10 min ago");
    expect(editedLabel(ago(60 * MIN), now)).toBe("Edited 1 hour ago");
    expect(editedLabel(ago(2 * 60 * MIN), now)).toBe("Edited 2 hours ago");
    expect(editedLabel(new Date(2026, 8, 23, 9, 0).toISOString(), now)).toBe("Edited yesterday");
    expect(editedLabel(new Date(2026, 8, 21, 18, 0).toISOString(), now)).toBe("Edited 3 days ago");
  });

  test("shows the date from 7 days on", () => {
    expect(editedLabel(new Date(2026, 8, 12, 10, 0).toISOString(), now)).toBe("Edited Sep 12, 2026");
  });

  test("a clock slightly ahead of the server still reads as now", () => {
    expect(editedLabel(new Date(now + 5_000).toISOString(), now)).toBe("Edited a moment ago");
  });
});

describe("sort and search", () => {
  const list = [
    summary("b", {
      name: "Storyboard",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    }),
    summary("a", {
      name: "client A",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    }),
    summary("c", {
      name: "Élan",
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    }),
  ];

  test("last edited, name and created", () => {
    expect(sortCanvases(list, "lastEdited").map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(sortCanvases(list, "name").map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(sortCanvases(list, "created").map((c) => c.id)).toEqual(["a", "c", "b"]);
    const tie = [
      summary("old", { name: "Same" }),
      summary("new", { name: "same", updatedAt: "2026-09-24T00:00:00.000Z" }),
    ];
    expect(sortCanvases(tie, "name").map((c) => c.id)).toEqual(["new", "old"]);
  });

  test("search ignores case and accents", () => {
    expect(matchesQuery("Élan", "elan")).toBe(true);
    expect(matchesQuery("Client A moodboard", "MOOD")).toBe(true);
    expect(matchesQuery("Storyboard", "lighthouse")).toBe(false);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });
});

describe("canvas files", () => {
  const graph = doc(
    [
      node("n_frame", { type: "frame", size: { w: 640, h: 420 } }),
      node("n_prompt", { parentId: "n_frame", params: { text: "Lighthouse at dusk" } }),
      node("n_gen", {
        type: "image.generate",
        position: { x: 400, y: 0 },
        result: {
          state: "done",
          assetIds: ["01K6BQ8000000000000000ASET"],
          jobSetId: null,
          jobSetIds: [],
          outputs: [],
          fingerprint: "sha256:abc",
          costUsd: null,
          ranAt: AT,
          error: null,
        },
      }),
    ],
    [
      {
        id: "e_1",
        source: "n_prompt",
        sourceHandle: "text",
        target: "n_gen",
        targetHandle: "prompt",
        kind: "data",
      },
    ],
  );

  test("import gives every node and connection a new id and keeps the wiring", () => {
    const copy = parseCanvasFile(JSON.stringify(graph));
    const ids = copy.nodes.map((n) => n.id);
    expect(ids.some((id) => graph.nodes.some((n) => n.id === id))).toBe(false);
    const [frame, prompt, gen] = copy.nodes;
    expect(prompt!.parentId).toBe(frame!.id);
    expect(copy.edges[0]!.id).not.toBe("e_1");
    expect(copy.edges[0]!.source).toBe(prompt!.id);
    expect(copy.edges[0]!.target).toBe(gen!.id);
    // Results come along; the images are in this library if the file came from it.
    expect(gen!.result?.assetIds).toEqual(["01K6BQ8000000000000000ASET"]);
    expect(remapDocument(graph).nodes[0]!.id).not.toBe(remapDocument(graph).nodes[0]!.id);
  });

  test("names the problem in a broken file", () => {
    expect(() => parseCanvasFile("not json")).toThrow("This file isn't a canvas.");
    expect(() => parseCanvasFile(JSON.stringify({ hello: 1 }))).toThrow("This file isn't a canvas.");
    expect(() => parseCanvasFile(JSON.stringify({ ...graph, schema: "openfield.canvas/99" }))).toThrow(
      "This canvas needs a newer version of Openfield.",
    );
    const bad = { ...graph, nodes: [graph.nodes[0], { ...graph.nodes[2], params: { batch: 9 } }] };
    expect(() => parseCanvasFile(JSON.stringify(bad))).toThrow(
      "Node 2: The number of images must be between 1 and 4.",
    );
    expect(describeIssue({ path: ["edges", 0, "target"], message: "Gone." })).toBe("Connection 1: Gone.");
    // zod's own words stay out of it.
    const raw = {
      code: "invalid_type",
      path: ["nodes", 4, "position"],
      message: "Invalid input: expected number",
    };
    expect(describeIssue(raw)).toBe("Node 5 can't be read.");
    expect(describeIssue({ ...raw, path: ["viewport"] })).toBe("This file isn't a canvas.");
  });

  test("export names the file after the canvas", () => {
    expect(exportFileName("Lighthouse series")).toBe("Lighthouse series.ofcanvas.json");
    expect(exportFileName('A/B: "test"?')).toBe("A B test.ofcanvas.json");
    expect(exportFileName("  ")).toBe("Untitled.ofcanvas.json");
  });
});

describe("graph sketch", () => {
  const box = { width: 320, height: 180, padding: [20, 20, 20, 20] as const };

  test("a small graph is drawn at the design's quarter scale, centred", () => {
    // The design's "Untitled" card: Prompt then Generate, 100 apart (XUeNr).
    const layout = sketchLayout(
      [
        node("p", { position: { x: 0, y: 125 } }),
        node("g", { type: "image.generate", position: { x: 480, y: 0 } }),
      ],
      [{ source: "p", sourceHandle: "text", target: "g", targetHandle: "prompt", kind: "data" }],
      box,
    );
    expect(layout.scale).toBe(0.25);
    const rects = layout.shapes.filter((s) => s.kind === "rect");
    const prompt = rects[0]!;
    expect(prompt.w).toBe(74);
    expect(prompt.h).toBeCloseTo(37.75);
    // Generate shows two input ports now its style port is hidden, one output, and the prompt's two.
    expect(layout.shapes.filter((s) => s.kind === "port")).toHaveLength(5);
    const edge = layout.shapes.find((s) => s.kind === "edge");
    expect(edge?.kind === "edge" && edge.d.startsWith("M")).toBe(true);
  });

  test("a big graph shrinks to fit and drops the small parts", () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      node(`n${i}`, { type: "image.generate", position: { x: (i % 10) * 400, y: Math.floor(i / 10) * 480 } }),
    );
    const layout = sketchLayout(nodes, [], box);
    expect(layout.scale).toBeLessThan(0.1);
    expect(layout.shapes.some((s) => s.kind === "port" || s.kind === "mark")).toBe(false);
    for (const shape of layout.shapes) {
      if (shape.kind !== "rect") continue;
      expect(shape.x).toBeGreaterThanOrEqual(19.99);
      expect(shape.x + shape.w).toBeLessThanOrEqual(300.01);
    }
  });

  test("an empty canvas is only dots", () => {
    expect(sketchLayout([], [], box).shapes).toEqual([]);
  });

  test("rounded rects take a radius per corner", () => {
    expect(roundedRectPath(0, 0, 10, 10, 0)).toBe("M0 0H10V10H0V0Z");
    expect(roundedRectPath(0, 0, 10, 10, [2, 0, 0, 0])).toContain("A2 2 0 0 1 2 0");
  });
});

describe("templates", () => {
  test("bundled templates use the catalogue's words; saved ones their own name", () => {
    expect(templateCopy({ id: "storyboard", source: "bundled", name: "x" })).toEqual({
      name: "Storyboard",
      body: "Turn one idea into four panels.",
    });
    expect(templateCopy({ id: "mine", source: "user", name: "My flow" })).toEqual({
      name: "My flow",
      body: null,
    });
    expect(templateCopy({ id: "unknown", source: "bundled", name: "Later" })).toEqual({
      name: "Later",
      body: null,
    });
  });
});
