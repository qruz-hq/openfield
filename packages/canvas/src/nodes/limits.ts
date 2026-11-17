import { BATCH_MAX, GENERATE_PROMPT_MAX, LAYERS_PROMPT_MAX, MASK_COMPOSITE_MAX_PX, t } from "@openfield/core";
import { PROMPT_MAX } from "./prompt/spec";
import { LIST_MAX, TAKES_MAX, TAKES_MIN } from "./variations/spec";

// The limits a node's settings live within, whoever sets them. The editor keeps to them as you
// type; an edit from an agent or the API that goes past one is refused with the limit named
// (apps/server canvases.ts), rather than cut short without a word or saved and then failing to run.

/** What each node type accepts, for agents to read (list_node_types) before they write. */
export const NODE_LIMITS = {
  prompt: { text: { maxChars: PROMPT_MAX } },
  "image.generate": { prompt: { maxChars: GENERATE_PROMPT_MAX }, batch: { min: 1, max: BATCH_MAX } },
  "image.edit": {
    prompt: { maxChars: GENERATE_PROMPT_MAX },
    batch: { min: 1, max: BATCH_MAX },
    featherPx: { min: 0, max: MASK_COMPOSITE_MAX_PX },
    expandPx: { min: 0, max: MASK_COMPOSITE_MAX_PX },
    // Sketch & point sends no references: every mark is on the image being edited.
    marks: { image: 1 },
  },
  "image.layers": { prompt: { maxChars: LAYERS_PROMPT_MAX } },
  "image.variations": {
    count: { min: TAKES_MIN, max: TAKES_MAX },
    prompts: { maxItems: LIST_MAX, maxChars: PROMPT_MAX },
    models: { maxItems: LIST_MAX },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const chars = (value: unknown) => (typeof value === "string" ? value.length : 0);

/** Why a node's settings are past a limit, in words to act on, or null when they fit. */
export function limitProblem(type: string, params: Readonly<Record<string, unknown>>): string | null {
  switch (type) {
    case "prompt": {
      const count = chars(params.text);
      return count > PROMPT_MAX ? t("canvas.edits.limits.promptText", { max: PROMPT_MAX, count }) : null;
    }
    case "image.generate": {
      const count = chars(params.prompt);
      if (count > GENERATE_PROMPT_MAX) {
        return t("canvas.edits.limits.generatePrompt", { max: GENERATE_PROMPT_MAX, count });
      }
      return null;
    }
    case "image.edit": {
      const count = chars(params.prompt);
      if (count > GENERATE_PROMPT_MAX) {
        return t("canvas.edits.limits.editPrompt", { max: GENERATE_PROMPT_MAX, count });
      }
      // Sketch & point sends no references (nodes/edit/spec.ts), so a mark on one would point at
      // nothing the model sees.
      const marks = Array.isArray(params.marks) ? params.marks : [];
      const off = marks.findIndex((m) => isRecord(m) && typeof m.image === "number" && m.image > 1);
      return off >= 0
        ? t("canvas.edits.limits.marksImage", {
            index: off + 1,
            image: String((marks[off] as { image: number }).image),
          })
        : null;
    }
    case "image.layers": {
      const count = chars(params.prompt);
      return count > LAYERS_PROMPT_MAX
        ? t("canvas.edits.limits.layersPrompt", { max: LAYERS_PROMPT_MAX, count })
        : null;
    }
    case "image.variations": {
      const { count, prompts, models } = params;
      if (count !== undefined && (typeof count !== "number" || count < TAKES_MIN || count > TAKES_MAX)) {
        return t("canvas.edits.limits.takes", { min: TAKES_MIN, max: TAKES_MAX, count: String(count) });
      }
      if (Array.isArray(prompts)) {
        const lines = prompts.filter((p) => typeof p === "string" && p.trim());
        if (lines.length > LIST_MAX) {
          return t("canvas.edits.limits.prompts", { max: LIST_MAX, count: lines.length });
        }
        const long = prompts.findIndex((p) => chars(p) > PROMPT_MAX);
        if (long >= 0) {
          return t("canvas.edits.limits.promptLine", {
            max: PROMPT_MAX,
            index: long + 1,
            count: chars(prompts[long]),
          });
        }
      }
      if (Array.isArray(models) && new Set(models).size > LIST_MAX) {
        return t("canvas.edits.limits.models", { max: LIST_MAX, count: new Set(models).size });
      }
      return null;
    }
    default:
      return null;
  }
}
