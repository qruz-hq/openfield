import { type CostEstimate, t } from "@openfield/core";
import { cn, Tooltip } from "@openfield/ui";
import { Play } from "lucide-react";
import { useProviders } from "../../../api/hooks/keys";
import { tightCost } from "../../../lib/cost";
import { altKeyName } from "../../editor/shortcuts";
import { useEngineStore } from "../../engine/engine-store";
import type { NodeBlocker } from "../../engine/types";
import { useCanvas } from "../../store/context";
import { blockerCopy } from "./blocker-copy";
import { useRunNode } from "./use-node";

// Canvas / Node / Run pill (design T1Q3Pl): 32 tall, accent, play icon and the local estimate
// ("~$0.13"). Pressing it runs the node; ⌥-click runs it even when nothing changed (M4-16).

export interface RunPillProps {
  id: string;
  name: string;
  estimate: CostEstimate | null;
  /** Why it can't run as it is (the band says so too). Fades the pill, like the design's blocked one. */
  blocker: NodeBlocker | null;
  /** Its images match its settings: a plain run would reuse them. */
  upToDate: boolean;
  /** The model has no seeds, so an unchanged node reuses its images (§0.11). */
  seedless: boolean;
}

export function RunPill({ id, name, estimate, blocker, upToDate, seedless }: RunPillProps) {
  const run = useRunNode(id);
  const ready = useCanvas((s) => s.runController.ready && !s.ui.readOnly);
  const busy = useCanvas((s) => s.runtime[id]?.state === "queued" || s.runtime[id]?.state === "running");
  // Busy while a run is being put together, not while its confirmation waits for an answer.
  const starting = useEngineStore((s) => s.starting && !s.dialog);
  const providers = useProviders().data;
  const blocked = !!blocker;
  const price = estimate ? tightCost(estimate) : undefined;
  const disabled = !ready || busy || starting;
  const tip = blocker
    ? blockerCopy(blocker, providers).message
    : upToDate
      ? t("canvas.nodes.pill.upToDate", { alt: altKeyName() })
      : estimate?.confidence === "unknown"
        ? t("cost.unknown")
        : seedless
          ? t("canvas.nodes.pill.newEachRun")
          : null;

  const pill = (
    <button
      type="button"
      data-run-pill={id}
      aria-label={t("canvas.nodes.pill.run", { name })}
      aria-disabled={blocked || undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void run("node", { bypassCache: event.altKey, anchor: event.currentTarget });
      }}
      className={cn(
        "nodrag flex h-32 shrink-0 cursor-pointer items-center gap-6 rounded-full bg-accent pr-12 pl-10 text-accent-fg transition-colors not-disabled:hover:bg-accent-hover disabled:cursor-default",
        (blocked || disabled) && "opacity-40",
      )}
    >
      <Play size={12} aria-hidden className="shrink-0" />
      {price ? (
        <span className="text-mono-12 font-medium">{price}</span>
      ) : (
        <span className="text-caption font-medium">{t("canvas.nodes.state.run")}</span>
      )}
    </button>
  );
  return tip ? <Tooltip content={tip}>{pill}</Tooltip> : pill;
}
