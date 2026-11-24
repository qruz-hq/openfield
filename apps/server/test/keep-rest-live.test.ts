import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeKeepRest, decideKeepRest, KEEP_REST_SENSITIVITY } from "@openfield/core";
import sharp from "sharp";

// Keep the rest against real models' results (§0.9), replayed from the live checks recorded beside
// each provider's fixtures (<provider>/__fixtures__/keep-rest, README there). Scaled to 256 px, so
// this pins the defaults' behaviour on real drift, not the exact numbers measured at full size.

const PROVIDERS = join(import.meta.dir, "../../../packages/providers/src");
const EDGE = 256;
const FULL = 1024;

interface Recorded {
  model: string;
  kind: "mask" | "marks";
  area: { mask?: Box; box?: Box };
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const pairs = ["openai", "google", "byteplus"].flatMap((provider) => {
  const dir = join(PROVIDERS, provider, "__fixtures__", "keep-rest");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ dir, label: f.replace(/\.json$/, "") }));
});

const rgb = async (file: string) => new Uint8Array(await sharp(file).removeAlpha().raw().toBuffer());

/** The area at the fixture's size: 0 (change) inside the box, 255 elsewhere. */
function areaOf(box: Box): Uint8Array {
  const s = EDGE / FULL;
  const alpha = new Uint8Array(EDGE * EDGE).fill(255);
  for (let y = Math.round(box.y * s); y < Math.round((box.y + box.h) * s); y++)
    alpha.fill(0, y * EDGE + Math.round(box.x * s), y * EDGE + Math.round((box.x + box.w) * s));
  return alpha;
}

/** Share of the picture at least `margin` px from the box that takes the model. */
function farKept(weights: Uint8Array, box: Box, margin: number): number {
  const s = EDGE / FULL;
  let far = 0;
  let kept = 0;
  for (let y = 0; y < EDGE; y++)
    for (let x = 0; x < EDGE; x++) {
      const near =
        x >= box.x * s - margin &&
        x < (box.x + box.w) * s + margin &&
        y >= box.y * s - margin &&
        y < (box.y + box.h) * s + margin;
      if (near) continue;
      far++;
      if (weights[y * EDGE + x]! > 0) kept++;
    }
  return kept / far;
}

describe("Keep the rest on real models' results", () => {
  test("there are recorded pairs from each company", () => {
    expect(new Set(pairs.map((p) => p.dir)).size).toBe(3);
    expect(pairs.length).toBeGreaterThanOrEqual(6);
  });

  for (const { dir, label } of pairs) {
    test(`${label}: lines up, and at the default keeps only what the model added`, async () => {
      const recorded = JSON.parse(readFileSync(join(dir, `${label}.json`), "utf8")) as Recorded;
      const box = (recorded.area.mask ?? recorded.area.box)!;
      const area = areaOf(box);
      const base = {
        data: await rgb(join(dir, "base.png")),
        width: EDGE,
        height: EDGE,
        channels: 3 as const,
      };
      const result = {
        data: await rgb(join(dir, `${label}.result.png`)),
        width: EDGE,
        height: EDGE,
        channels: 3 as const,
      };
      const analysis = analyzeKeepRest(base, result, area);
      expect(analysis.fallback).toBeUndefined();
      expect(analysis.lineUp.confidence).toBeGreaterThan(0.8);

      const decided = decideKeepRest(analysis, area, {
        expandPx: 1,
        featherPx: 2,
        sensitivity: KEEP_REST_SENSITIVITY.default,
      });
      expect(decided.fallback).toBeUndefined();
      // The apple and its shadow: more than a speck, much less than the picture. Gemini's first run
      // also redrew the whole tabletop under it, lighter: a big clear change, kept (see the README).
      expect(decided.changed).toBeGreaterThan(0.01);
      expect(decided.changed).toBeLessThan(label === "gemini-1" ? 0.45 : 0.12);
      // Gemini edits the whole image, so its changes can lie beside the mask: they're kept.
      const away = farKept(decided.weights, box, 10);
      if (label === "gemini-1") expect(away).toBeGreaterThan(0.15);
      else if (label === "gemini-2") expect(away).toBeGreaterThan(0.02);
      else expect(away).toBeLessThan(0.005);
    });
  }
});
