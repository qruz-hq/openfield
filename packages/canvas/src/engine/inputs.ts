import { type ModelKey, type ModelListItem, safeParseModelKey } from "@openfield/core";
import type { EngineContext, NodeBlocker, PortValue, ResolvedInputs } from "./types";
import { PROMPT_JOINER } from "./types";

// Small pure helpers every node engine shares: reading text and images off resolved inputs,
// and the model checks that turn into a blocker band.

/** Upstream text parts in edge order, then the node's own text: trimmed, empties dropped. */
export function joinPrompt(parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(PROMPT_JOINER);
}

export function textOf(inputs: ResolvedInputs, port: string): string[] {
  return (inputs[port] ?? []).flatMap((v) => (v.kind === "text" ? [v.text] : []));
}

export type ImageValue = Extract<PortValue, { kind: "asset" | "pending" }>;

export function imagesOf(inputs: ResolvedInputs, port: string): ImageValue[] {
  return (inputs[port] ?? []).filter((v): v is ImageValue => v.kind === "asset" || v.kind === "pending");
}

/** How many images the values stand for: one per asset, the expected count for work still to come. */
export const imageCount = (values: readonly ImageValue[]): number =>
  values.reduce((sum, v) => sum + (v.kind === "asset" ? 1 : Math.max(0, v.expected)), 0);

/** The run plan's form of an image value. */
export const planValue = (v: ImageValue) =>
  v.kind === "asset"
    ? { kind: "asset" as const, assetId: v.assetId }
    : { kind: "node" as const, nodeId: v.nodeId, port: v.port };

/** The model a node asks for, or the default when it names none. */
export const modelKeyOf = (key: ModelKey | undefined, ctx: EngineContext): ModelKey | null =>
  key ?? ctx.defaultModel;

/** Why this model can't run right now, or null when it can. */
export function modelBlocker(key: ModelKey | null, ctx: EngineContext): NodeBlocker | null {
  if (!key) return { kind: "model_unavailable", model: null };
  const model = ctx.model(key);
  if (!model) {
    const providerId = safeParseModelKey(key)?.providerId;
    if (providerId && ctx.companyOff?.(providerId)) return { kind: "company_off", model: key };
    return { kind: "model_unavailable", model: key };
  }
  if (!model.ready) return { kind: "no_key", model: key };
  return null;
}

/** Reference checks for images going into a model (§7.5): refused, or more than it takes. */
export function referenceBlocker(model: ModelListItem, count: number): NodeBlocker | null {
  if (count === 0) return null;
  const refs = model.capabilities.references;
  if (!refs.supported) return { kind: "references_unsupported", model: model.key };
  if (count > refs.max) return { kind: "too_many_references", model: model.key, max: refs.max };
  return null;
}

/** Blockers the person has to fix before anything can run, shown whether or not they pressed Run. */
export const STANDING_BLOCKERS: ReadonlySet<NodeBlocker["kind"]> = new Set([
  "no_key",
  "model_unavailable",
  "company_off",
  "references_unsupported",
  "too_many_references",
  "too_many_jobs",
  "loop",
]);

/**
 * Models that can do what a node needs (§7.8 "Pick another model"): take its reference images.
 * The node's own model stays listed so the picker can show it, fitting or not.
 */
export function modelsFitting(
  models: readonly ModelListItem[],
  needs: { references: number },
  current?: ModelKey | null,
): ModelListItem[] {
  if (needs.references === 0) return [...models];
  return models.filter((m) => {
    if (m.key === current) return true;
    const refs = m.capabilities.references;
    return refs.supported && refs.max >= needs.references;
  });
}
