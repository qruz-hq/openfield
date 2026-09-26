import type { ModelListItem } from "@openfield/core";
import { type LiveBatch, useLive } from "../../../lib/live";
import { useCanvasEngineContext } from "../../engine/engine-store";
import { modelKeyOf } from "../../engine/inputs";
import type { EngineContext, NodeRuntime } from "../../engine/types";
import { useNodeParams, useNodeRuntime } from "../../store/context";
import { readModel } from "../params";

// A run that waits at its company instead of working in the open (§2.4): a Batch run, which can
// take hours, or a Flex call, which can take minutes. There's no progress to show, so the card
// says where it waits (design QZNse) and its links light up without a pulse (design IEo83).

export type CompanyWait =
  | { speed: "batch"; providerId: string; state: LiveBatch["state"]; stopping: boolean }
  | { speed: "flex"; providerId: string };

/**
 * Where a node's run waits, if it does: a Batch run the company holds, or a Flex call under way
 * (the node's model runs at Flex). Null for anything else.
 */
export function companyWaitOf(
  runtime: Pick<NodeRuntime, "state" | "jobSetIds"> | undefined,
  batchOf: (jobSetId: string) => LiveBatch | undefined,
  model: ModelListItem | undefined,
  ctx: Pick<EngineContext, "runSpeed">,
): CompanyWait | null {
  if (runtime?.state !== "queued" && runtime?.state !== "running") return null;
  for (const jobSetId of runtime.jobSetIds) {
    const batch = batchOf(jobSetId);
    if (batch) return { speed: "batch", ...batch };
  }
  if (runtime.state === "running" && model && ctx.runSpeed?.(model).speed === "flex")
    return { speed: "flex", providerId: model.providerId };
  return null;
}

export function useCompanyWait(id: string): CompanyWait | null {
  const runtime = useNodeRuntime(id);
  const ctx = useCanvasEngineContext();
  const key = readModel(useNodeParams(id)?.model);
  const jobSetIds = runtime?.jobSetIds;
  const batch = useLive((s) => jobSetIds?.map((jobSetId) => s.batches[jobSetId]).find(Boolean));
  const resolved = modelKeyOf(key, ctx);
  const model = resolved ? ctx.model(resolved) : undefined;
  return companyWaitOf(runtime, () => batch, model, ctx);
}
