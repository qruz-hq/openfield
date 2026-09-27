import { formatLocale, parseModelKey, t } from "@openfield/core";
import { qualityLabel } from "@openfield/providers/manifest";
import type { NodeRegistry } from "../nodes/registry";
import type { NodeFrame } from "../store/ops";
import type { EngineContext, RunPlanItem } from "./types";

// Words for nodes and runs: a node's name, a model's name and a run's "Nano Banana Pro · 2K × 4".

/** The node's own title, else its type's name. */
export function nodeTitle(frame: Pick<NodeFrame, "title" | "type">, registry: NodeRegistry): string {
  const title = frame.title?.trim();
  if (title) return title;
  const def = registry.get(frame.type);
  return def ? t(def.label) : frame.type;
}

/** The model's display name, or its id when this build doesn't know it. */
export function modelName(ctx: EngineContext, key: string): string {
  return ctx.model(key)?.displayName ?? (key.includes(":") ? parseModelKey(key).modelId : key);
}

export const listOf = (items: readonly string[]): string =>
  new Intl.ListFormat(formatLocale(), { style: "long", type: "conjunction" }).format(items);

/** "Nano Banana Pro · 2K × 4", or "Nano Banana Pro and GPT Image 2 × 2" when models differ. */
export function runDetail(item: RunPlanItem, jobs: number, ctx: EngineContext): string {
  const keys = [...new Set(item.calls.map((c) => c.model))];
  if (keys.length > 1) {
    return t("canvas.run.detailPlain", { model: listOf(keys.map((k) => modelName(ctx, k))), count: jobs });
  }
  const key = keys[0] ?? item.model;
  const call = item.calls[0];
  const model = ctx.model(key);
  const settings =
    call?.resolution ??
    (call?.quality && model ? qualityLabel(model.capabilities, call.quality) : call?.quality);
  const name = modelName(ctx, key);
  return settings
    ? t("canvas.run.detail", { model: name, settings, count: jobs })
    : t("canvas.run.detailPlain", { model: name, count: jobs });
}
