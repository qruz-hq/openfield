import { type ModelListItem, t } from "@openfield/core";
import { type Resolved, referenceInputsFor } from "@openfield/providers/manifest";

// A related set (Seedream Lite, 4.5 and 4.0): one call that makes up to the count, billed only for
// the images that come back. Pure, so the composer and its tests read it the same way.

export interface RelatedSetPlan {
  /** The model's switch for one (batch.groupOption), when it can make one. */
  option: string | undefined;
  /** Asked for and possible right now. */
  on: boolean;
  /** What the run sends: the model's own switch, and only while it's on. */
  providerOptions: Record<string, unknown> | undefined;
  /** The most images the set can ask for beside the images sent in, when that's below the model's count. */
  max: number | undefined;
  /** Why the count stops early, for the line above the composer. */
  note: string | null;
  /** Why the switch can't be turned on yet, shown under it in place of its hint. */
  blocked: string | null;
}

export function relatedSetPlan(
  model: ModelListItem | undefined,
  options: Readonly<Record<string, unknown>> | undefined,
  references: readonly string[],
  count: number,
): RelatedSetPlan {
  const option = model?.capabilities.batch.groupOption;
  const off = { option, on: false, providerOptions: undefined, max: undefined, note: null, blocked: null };
  if (!model || !option) return off;
  // The images sent in count toward the set's own limit (references.maxInputsAndOutputs).
  const shared = model.capabilities.references.maxInputsAndOutputs;
  const room = shared
    ? Math.max(0, shared - referenceInputsFor(model.capabilities, references).length)
    : undefined;
  // A set of one is just one image, so the switch waits for room for two and a count of two. It
  // keeps what was asked for, and comes back on once both are there.
  const blocked =
    room !== undefined && room < 2
      ? t("composer.chips.batch.relatedSetNoRoom")
      : count < 2
        ? t("composer.chips.batch.relatedSetNeedsTwo")
        : null;
  if (blocked || options?.[option] !== true) return { ...off, blocked };
  const providerOptions = { [option]: true };
  if (!shared || room === undefined || room >= model.capabilities.batch.max)
    return { option, on: true, providerOptions, max: undefined, note: null, blocked: null };
  const note = t("composer.groupLimit", { model: model.displayName, max: shared });
  return { option, on: true, providerOptions, max: room, note, blocked: null };
}

/** The resolved values with the count held to what the set can ask for. */
export const withinSet = (resolved: Resolved, plan: RelatedSetPlan): Resolved =>
  plan.max !== undefined && resolved.batch > plan.max ? { ...resolved, batch: plan.max } : resolved;
