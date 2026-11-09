import { type ModelListItem, t } from "@openfield/core";
import { type Resolved, referenceInputsFor } from "@openfield/providers/manifest";

// A related set (Seedream Lite, 4.5 and 4.0): one call that makes up to the count, billed only for
// the images that come back. Pure, so the composer and its tests read it the same way.

export interface RelatedSetPlan {
  /** The model's switch for one (batch.groupOption), when it can make one. */
  option: string | undefined;
  on: boolean;
  /** What the run sends: the model's own switch, and only while it's on. */
  providerOptions: Record<string, unknown> | undefined;
  /** The most images the set can ask for beside the images sent in, when that's below the model's count. */
  max: number | undefined;
  /** Why the count stops early, for the line above the composer. */
  note: string | null;
}

export function relatedSetPlan(
  model: ModelListItem | undefined,
  options: Readonly<Record<string, unknown>> | undefined,
  references: readonly string[],
): RelatedSetPlan {
  const option = model?.capabilities.batch.groupOption;
  const on = !!option && options?.[option] === true;
  if (!model || !option || !on) return { option, on, providerOptions: undefined, max: undefined, note: null };
  // The images sent in count toward the set's own limit (references.maxInputsAndOutputs).
  const providerOptions = { [option]: true };
  const shared = model.capabilities.references.maxInputsAndOutputs;
  const room = shared && Math.max(1, shared - referenceInputsFor(model.capabilities, references).length);
  if (!shared || !room || room >= model.capabilities.batch.max)
    return { option, on, providerOptions, max: undefined, note: null };
  const note = t("composer.groupLimit", { model: model.displayName, max: shared });
  return { option, on, providerOptions, max: room, note };
}

/** The resolved values with the count held to what the set can ask for. */
export const withinSet = (resolved: Resolved, plan: RelatedSetPlan): Resolved =>
  plan.max !== undefined && resolved.batch > plan.max ? { ...resolved, batch: plan.max } : resolved;
