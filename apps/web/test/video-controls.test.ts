// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { AspectRatio } from "@openfield/core";
import {
  carryVideoValues,
  estimateVideoRun,
  resolveFor,
  videoGenerateBody,
  videoGenerateState,
} from "../src/video/composer/video-values";
import { seedance } from "./fixtures";

// Pure video composer logic (mirrors test/controls.test.ts for images): what each chip shows,
// what a run sends, and when Generate is blocked.

describe("resolveFor", () => {
  test("fills every field with the model's defaults when nothing is chosen", () => {
    const resolved = resolveFor(seedance, {});
    expect(resolved.video).toEqual({ seconds: 5, resolution: "720p", audio: true });
    expect(resolved.aspect).toBe("16:9");
    expect(resolved.notes).toEqual([]);
  });

  test("keeps the person's choice when the model offers it", () => {
    const resolved = resolveFor(seedance, { seconds: 8, resolution: "480p", sound: false, aspect: "9:16" });
    expect(resolved.video).toMatchObject({ seconds: 8, resolution: "480p", audio: false });
    expect(resolved.aspect).toBe("9:16");
  });

  test("snaps a duration outside the model's list to the nearest one, ties going longer", () => {
    expect(resolveFor(seedance, { seconds: 20 }).video.seconds).toBe(15);
    expect(resolveFor(seedance, { seconds: 1 }).video.seconds).toBe(4);
  });

  test("a start frame forces its own shape only when the model says so; Seedance 2.0 Fast doesn't", () => {
    const withFrame = resolveFor(seedance, { aspect: "auto", startFrame: { assetId: "01K…" } });
    // autoAspect: "with_start_frame" and startFrameForcesAuto: false — auto is allowed as asked.
    expect(withFrame.aspect).toBe("auto");
  });

  test("auto with no start frame falls back to the model's default shape, with a note", () => {
    const resolved = resolveFor(seedance, { aspect: "auto" });
    expect(resolved.aspect).toBe("16:9");
    expect(resolved.notes.some((n) => n.field === "size")).toBe(true);
  });

  test("an end frame without a start frame is an error note, not silently dropped", () => {
    const resolved = resolveFor(seedance, { endFrame: { assetId: "01K…" } });
    expect(resolved.notes).toContainEqual({
      field: "video.endFrame",
      message: expect.any(String),
      level: "error",
    });
  });
});

describe("videoGenerateBody", () => {
  test("sends the resolved settings, batch 1 and a null seed", () => {
    const resolved = resolveFor(seedance, { seconds: 8, startFrame: { assetId: "01K…frame" } });
    const body = videoGenerateBody(seedance, resolved, " a kite climbs ", "01Kidempotent");
    expect(body).toMatchObject({
      idempotencyKey: "01Kidempotent",
      model: seedance.key,
      op: "generate",
      prompt: "a kite climbs",
      size: { kind: "aspect", ratio: "16:9" },
      batch: 1,
      seed: null,
      video: { seconds: 8, resolution: "720p", audio: true, startFrame: { assetId: "01K…frame" } },
    });
  });

  test("auto ratio sends size.kind auto", () => {
    const resolved = resolveFor(seedance, { aspect: "auto", startFrame: { assetId: "01K…frame" } });
    expect(videoGenerateBody(seedance, resolved, "x", "01K").size).toEqual({ kind: "auto" });
  });
});

describe("estimateVideoRun", () => {
  test("prices the exact shape for a chosen ratio", () => {
    const resolved = resolveFor(seedance, {});
    const cost = estimateVideoRun(seedance, resolved, "");
    expect(cost.confidence).toBe("estimated");
    expect(cost.min).toBeGreaterThan(0);
    expect(cost.min).toBe(cost.max);
  });
});

describe("videoGenerateState", () => {
  test("no model and nothing ready: first run", () => {
    expect(
      videoGenerateState({ model: undefined, anyReady: false, prompt: "", resolved: undefined }),
    ).toEqual({
      kind: "no-key",
    });
  });

  test("a model whose company has no key needs one", () => {
    const state = videoGenerateState({
      model: { ...seedance, ready: false },
      anyReady: true,
      prompt: "a kite",
      resolved: undefined,
    });
    expect(state.kind).toBe("needs-key");
  });

  test("empty prompt and no start frame blocks, with the estimate still shown", () => {
    const resolved = resolveFor(seedance, {});
    const state = videoGenerateState({ model: seedance, anyReady: true, prompt: "  ", resolved });
    if (state.kind !== "blocked") throw new Error("expected blocked");
    expect(state.estimate).toBeDefined();
  });

  test("a start frame alone is enough, even with no words", () => {
    const resolved = resolveFor(seedance, { startFrame: { assetId: "01K…" } });
    const state = videoGenerateState({ model: seedance, anyReady: true, prompt: "", resolved });
    expect(state.kind).toBe("ready");
  });

  test("an end frame without a start frame blocks with its own reason", () => {
    const resolved = resolveFor(seedance, { endFrame: { assetId: "01K…" } });
    const state = videoGenerateState({ model: seedance, anyReady: true, prompt: "a kite", resolved });
    expect(state.kind).toBe("blocked");
  });

  test("words and a ready model: ready to run", () => {
    const resolved = resolveFor(seedance, {});
    const state = videoGenerateState({ model: seedance, anyReady: true, prompt: "a kite climbs", resolved });
    expect(state.kind).toBe("ready");
  });
});

describe("carryVideoValues", () => {
  const fast = seedance;
  const narrower = {
    ...seedance,
    key: "byteplus:seedance-1-0-pro-fast" as const,
    capabilities: {
      ...seedance.capabilities,
      size: {
        mode: "aspect" as const,
        ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"] as AspectRatio[],
        default: "16:9" as const,
      },
      video: {
        ...seedance.capabilities.video!,
        resolutions: ["480p" as const],
        defaultResolution: "480p" as const,
        durations: [2, 3, 4, 5, 6],
        defaultDuration: 5,
        frames: { ...seedance.capabilities.video!.frames, end: false },
      },
    },
  };

  test("carries a resolution the new model still offers", () => {
    const out = carryVideoValues(fast, { resolution: "480p" });
    expect(out.values.resolution).toBe("480p");
    expect(out.adjusted).toEqual([]);
  });

  test("clamps a resolution the new model doesn't have to its nearest", () => {
    const out = carryVideoValues(narrower, { resolution: "720p" });
    expect(out.values.resolution).toBe("480p");
    expect(out.adjusted).toHaveLength(1);
  });

  test("clamps a duration outside the new model's range", () => {
    const out = carryVideoValues(narrower, { seconds: 12 });
    expect(out.values.seconds).toBe(6);
    expect(out.adjusted).toHaveLength(1);
  });

  test("drops sound when the new model can't make it, with no adjustment note", () => {
    const mute = {
      ...narrower,
      capabilities: {
        ...narrower.capabilities,
        video: { ...narrower.capabilities.video!, audio: { supported: false, default: false } },
      },
    };
    const out = carryVideoValues(mute, { sound: true });
    expect(out.values.sound).toBeUndefined();
    expect(out.adjusted).toEqual([]);
  });

  test("an aspect ratio the new model lacks clamps to the nearest one it has", () => {
    const out = carryVideoValues(narrower, { aspect: "21:9" });
    expect(out.values.aspect).toBeDefined();
    expect(out.values.aspect).not.toBe("21:9");
  });
});
