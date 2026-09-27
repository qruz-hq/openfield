// biome-ignore-all lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardView } from "../src/canvas/nodes/generate/card-state";
import { parseColor } from "../src/canvas/nodes/generate/voxel/renderer";
import { VOXEL_SWARM_GLSL } from "../src/canvas/nodes/generate/voxel/shader";
import { seedOf } from "../src/canvas/nodes/generate/voxel/voxel-field";

// The generating card's voxel swarm (design wKzQJ, motion spec oQ27O).

describe("voxel swarm", () => {
  test("the app draws the design's own shader, unchanged", () => {
    const design = readFileSync(join(import.meta.dir, "../../../design/shaders/voxel-swarm.glsl"), "utf8");
    expect(VOXEL_SWARM_GLSL).toBe(design);
  });

  test("it runs while generating, idles while waiting, and a wait at the company keeps its note", () => {
    const view = (state: "running" | "queued", extra = {}) =>
      cardView({ state, images: false, atCompany: false, partial: false, voxels: true, ...extra });
    expect(view("running")).toMatchObject({ phase: "generating", voxels: "active", emptyGlyph: false });
    expect(view("running", { images: true })).toMatchObject({ media: "dimmed", voxels: "active" });
    expect(view("queued")).toMatchObject({ phase: "waiting", voxels: "idle", emptyGlyph: false });
    // The note ("Usually done within a few hours") stays over the idle swarm.
    expect(view("running", { atCompany: true })).toMatchObject({
      phase: "atCompany",
      voxels: "idle",
      emptyGlyph: true,
    });
    for (const state of ["done", "failed", "canceled", "blocked", "idle", "stale"] as const) {
      expect(
        cardView({ state, images: false, atCompany: false, partial: false, voxels: true }).voxels,
      ).toBeNull();
    }
  });

  test("without WebGL the card keeps its glyph and ratio", () => {
    const view = cardView({ state: "running", images: false, atCompany: false, partial: false });
    expect(view).toMatchObject({ voxels: null, emptyGlyph: true });
  });

  test("each run gets its own sky, the same one every time it's drawn", () => {
    expect(seedOf("run-1:node-a")).toBe(seedOf("run-1:node-a"));
    const seeds = new Set(Array.from({ length: 50 }, (_, i) => seedOf(`run-${i}:node-a`)));
    expect(seeds.size).toBeGreaterThan(45);
    for (const seed of seeds) expect(seed >= 0 && seed < 1000 && Number.isInteger(seed)).toBe(true);
  });

  test("theme colours are read as the browser resolves them", () => {
    expect(parseColor("rgb(233, 227, 216)", [0, 0, 0])).toEqual([233 / 255, 227 / 255, 216 / 255]);
    expect(parseColor("color(srgb 0.5 0.25 1)", [0, 0, 0])).toEqual([0.5, 0.25, 1]);
    expect(parseColor("", [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });
});
