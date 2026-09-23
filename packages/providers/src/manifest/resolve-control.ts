import {
  type Capabilities,
  CORE_CONTROL_IDS,
  type ControlId,
  type ControlState,
  type ResolvedControl,
  t,
} from "@openfield/core";

// §0.3: the one function that decides every control on every surface. No surface reads
// capabilities directly, so adding a model is a data change, never a UI change.

export interface ControlResolution extends ResolvedControl {
  state: ControlState;
  /** Options shown greyed out when the state is "partial". */
  unavailable?: string[];
  /** Upper bound for steppers and the reference strip. */
  max?: number;
  /** How prompt enhance runs: the model's own flag, or Openfield's local rewrite. */
  mode?: "native" | "openfield";
}

type Present = Omit<ControlResolution, "state">;

export function resolveControl(caps: Capabilities, id: ControlId): ControlResolution {
  const present = presence(caps, id);

  const unsupported = caps.unsupported?.[id];
  if (unsupported) return { ...present, state: "unsupported", reason: unsupported.reason };
  if (!present) {
    // The core set never disappears (§3.5). Seed, when not supported, explains itself.
    if (id === "seed") return { state: "unsupported", reason: t("errors.unsupported_param.reason") };
    return { state: "absent" };
  }
  if (caps.emulated?.includes(id)) return { ...present, state: "emulated" };
  const partial = caps.partial?.[id];
  if (partial)
    return { ...present, state: "partial", unavailable: partial.unavailable, reason: partial.reason };
  return { ...present, state: "supported" };
}

/** Controls whose absence is shown as a disabled chip rather than hidden (§0.3). */
export const isCoreControl = (id: ControlId): boolean => (CORE_CONTROL_IDS as readonly string[]).includes(id);

/**
 * The chip row in `controlOrder`: non-core controls that are unsupported or absent drop out,
 * core ones stay so the bar doesn't jump between models.
 */
export function visibleControls(caps: Capabilities): (ControlResolution & { id: ControlId })[] {
  return caps.controlOrder
    .map((id) => ({ id, ...resolveControl(caps, id) }))
    .filter((c) => c.state !== "absent" && (c.state !== "unsupported" || isCoreControl(c.id)));
}

/** What the capability offers when it exists at all, or null when the model doesn't declare it. */
function presence(caps: Capabilities, id: ControlId): Present | null {
  switch (id) {
    case "model":
      return {};
    case "aspect":
      return caps.size.mode === "aspect" ? { options: caps.size.ratios, default: caps.size.default } : null;
    case "size":
      if (caps.size.mode === "enum") return { options: caps.size.sizes, default: caps.size.default };
      if (caps.size.mode === "free") {
        const { minEdge, maxEdge, multipleOf } = caps.size;
        return { options: [{ minEdge, maxEdge, multipleOf }], default: caps.size.default };
      }
      return null;
    case "resolution":
      return caps.resolution ? { options: caps.resolution.tiers, default: caps.resolution.default } : null;
    case "quality":
      return caps.quality ? { options: caps.quality.levels, default: caps.quality.default } : null;
    case "batch":
      return {
        options: Array.from({ length: caps.batch.max }, (_, i) => i + 1),
        default: 1,
        max: caps.batch.max,
      };
    case "seed":
      return caps.seed.supported
        ? { default: null, ...(caps.seed.range && { options: caps.seed.range }) }
        : null;
    case "negativePrompt":
      return caps.negativePrompt || caps.emulated?.includes("negativePrompt") ? { default: "" } : null;
    case "promptEnhance":
      return caps.promptEnhance === "none" ? null : { default: false, mode: caps.promptEnhance };
    case "background":
      return caps.background ? { options: caps.background.values, default: caps.background.default } : null;
    case "references":
      return caps.references.supported ? { options: caps.references.roles, max: caps.references.max } : null;
    case "referenceStrength":
      return caps.references.supported && caps.references.strengthMode !== "none"
        ? { options: [0, 1], default: 1 }
        : null;
    case "outputFormat":
      // A single format has nothing to choose, so the chip stays hidden.
      return caps.output.formats.length > 1
        ? { options: caps.output.formats, default: caps.output.default }
        : null;
    case "moderation": {
      const moderation = caps.safety?.moderation;
      return moderation ? { options: moderation.values, default: moderation.default } : null;
    }
    case "advanced": {
      const fields = Object.keys(caps.extraSchema?.properties ?? {});
      return fields.length ? { options: fields } : null;
    }
    case "palette":
      // Palettes can always go in as prompt text; a reference-based mode is gated by `references`.
      return {};
  }
}
