import type { Capabilities } from "@openfield/core";

// How many layers a split asks for at most. Only some models let the person choose (layers.choose);
// on the rest every split may make up to layers.maxLayers and nothing is sent. The estimate, the
// request, a canvas node and both Layers panels read it here, so they always agree.

type LayerRules = Pick<NonNullable<Capabilities["layers"]>, "maxLayers" | "choose">;

/** The most layers asked for, held to the model's range, or undefined when the model takes none. */
export function chosenLayers(rules: LayerRules | undefined, asked: number | undefined): number | undefined {
  const choose = rules?.choose;
  if (!rules || !choose) return undefined;
  if (asked === undefined || !Number.isFinite(asked)) return choose.default;
  return Math.min(rules.maxLayers, Math.max(choose.min, Math.round(asked)));
}

/** The most layers a split can make: the number chosen, else the model's own limit. */
export function mostLayers(rules: LayerRules | undefined, asked: number | undefined): number | undefined {
  return chosenLayers(rules, asked) ?? rules?.maxLayers;
}
