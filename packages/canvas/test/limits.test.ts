// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { CANVAS_CALL_LABEL_MAX, canvasRunPlanItemSchema } from "@openfield/core";
import { compileRun } from "../src/engine/compile";
import { limitProblem } from "../src/nodes/limits";
import { specRegistry } from "../src/nodes/specs";
import { captionOf } from "../src/nodes/variations/spec";
import { ctx, docOf, edge, node } from "./fixtures";

// Whoever sets a node's settings, an agent included, what they make has to be something that saves
// and runs: past a limit it's refused with the limit named, and a run plan's own limits (a caption's
// length) never turn away a node the editor accepts.

const FINGERPRINT = `sha256:${"0".repeat(64)}`;
const words = (length: number) =>
  "soft rim light on wet stone, ".repeat(Math.ceil(length / 29)).slice(0, length);

describe("node limits", () => {
  test("a Variations prompt line longer than a caption still runs, whole: only its caption is cut", () => {
    const line = words(277);
    const doc = docOf(
      [
        node("p", "prompt", { params: { text: "A perfume bottle" } }),
        node("v", "image.variations", {
          params: { strategy: "prompt-list", prompts: [line, "Morning light"] },
        }),
      ],
      [edge("e1", "p", "text", "v", "prompt")],
    );
    const outcome = compileRun({
      doc,
      registry: specRegistry,
      ctx,
      fingerprints: Object.fromEntries(doc.order.map((id) => [id, FINGERPRINT])),
      request: { scope: "selection", nodeIds: ["v"], bypassCache: true },
    });
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") return;
    const item = outcome.items[0]!.item;
    expect(canvasRunPlanItemSchema.safeParse(item).success).toBe(true);
    const call = item.calls[0]!;
    expect(call.label!.length).toBe(CANVAS_CALL_LABEL_MAX);
    expect(call.label).toEndWith("…");
    expect(call.prompt).toContain(line);
  });

  test("a caption up to the limit is left as it is", () => {
    expect(captionOf("Morning light")).toBe("Morning light");
    expect(captionOf(words(CANVAS_CALL_LABEL_MAX))).toBe(words(CANVAS_CALL_LABEL_MAX));
    expect(captionOf(words(CANVAS_CALL_LABEL_MAX + 1))).toHaveLength(CANVAS_CALL_LABEL_MAX);
  });

  test("settings past a limit are named, with the limit and what was sent", () => {
    expect(limitProblem("prompt", { text: words(4000) })).toBeNull();
    expect(limitProblem("prompt", { text: words(4001) })).toMatch(/at most 4,?000 characters.*4,?001/);
    expect(limitProblem("image.generate", { prompt: words(32_001) })).toMatch(/at most 32,?000 characters/);
    const nine = Array.from({ length: 9 }, (_, i) => `Take ${i + 1}`);
    expect(limitProblem("image.variations", { prompts: nine })).toContain("at most 8 prompts");
    // Blank rows while editing don't count.
    expect(limitProblem("image.variations", { prompts: [...nine.slice(0, 8), "", " "] })).toBeNull();
    expect(limitProblem("image.variations", { prompts: ["Morning light", words(4001)] })).toContain(
      "Prompt 2",
    );
    expect(limitProblem("image.variations", { count: 12 })).toContain("2 to 8");
    expect(limitProblem("image.variations", { count: 1 })).toContain("2 to 8");
    const models = Array.from({ length: 9 }, (_, i) => `google:model-${i}`);
    expect(limitProblem("image.variations", { models })).toContain("at most 8 models");
    expect(limitProblem("note", { text: words(10_000) })).toBeNull();
  });
});
