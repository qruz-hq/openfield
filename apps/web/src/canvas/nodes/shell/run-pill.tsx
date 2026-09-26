import { type CostEstimate, type ModelListItem, t } from "@openfield/core";
import { cn, Tooltip } from "@openfield/ui";
import { Play } from "lucide-react";
import { useProviders } from "../../../api/hooks/keys";
import { tightCost } from "../../../lib/cost";
import { altKeyName } from "../../editor/shortcuts";
import { useCanvasEngineContext, useEngineStore } from "../../engine/engine-store";
import type { NodeBlocker } from "../../engine/types";
import { useCanvas } from "../../store/context";
import { blockerCopy } from "./blocker-copy";
import { useNodeSpeed } from "./speed";
import { useRunNode } from "./use-node";

// Canvas / Node / Run pill (design T1Q3Pl): 32 tall, accent, play icon and the local estimate
// ("~$0.13") at the company's speed, then the speed itself when it isn't Standard ("· Batch",
// B3lLY). "Cost unknown" is words, so it's in Inter. Pressing it runs the node; ⌥-click runs it
// even when nothing changed (M4-16). The tooltip says more about the speed (§0.3).

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
  /** The models it runs, for the speed line in its tooltip. */
  models?: readonly (ModelListItem | undefined)[];
  /** Faded but still pressable: nothing to run yet (design V7GVg, "Add a prompt to run this"). */
  muted?: boolean;
  /** The node's own action: Enter on the node goes straight to it (use-shortcuts.ts). */
  primary?: boolean;
  className?: string;
}

export function RunPill({
  id,
  name,
  estimate,
  blocker,
  upToDate,
  seedless,
  models = [],
  muted = false,
  primary = false,
  className,
}: RunPillProps) {
  const run = useRunNode(id);
  const ready = useCanvas((s) => s.runController.ready && !s.ui.readOnly);
  const busy = useCanvas((s) => s.runtime[id]?.state === "queued" || s.runtime[id]?.state === "running");
  // Busy while a run is being put together, not while its confirmation waits for an answer.
  const starting = useEngineStore((s) => s.starting && !s.dialog);
  const providers = useProviders().data;
  const blocked = !!blocker;
  const price = estimate ? tightCost(estimate) : undefined;
  const disabled = !ready || busy || starting;
  const speed = useNodeSpeed(models);
  const ctx = useCanvasEngineContext();
  // The speed it runs at, when every model runs at the same one and it isn't Standard.
  const runs = models.flatMap((model) => (model && ctx.runSpeed ? [ctx.runSpeed(model)] : []));
  const suffix =
    runs.length && runs.every((r) => r.speed === runs[0]!.speed) && runs[0]!.speed !== "standard"
      ? t("speed.suffix", { speed: runs[0]!.name })
      : null;
  const why = blocker
    ? blockerCopy(blocker, providers).message
    : upToDate
      ? t("canvas.nodes.pill.upToDate", { alt: altKeyName() })
      : estimate?.confidence === "unknown"
        ? t("cost.unknown")
        : seedless
          ? t("canvas.nodes.pill.newEachRun")
          : null;
  const lines = [...(why ? [why] : []), ...(!blocker && speed ? speed.tips : [])];
  const tip = lines.length ? (
    <span className="flex flex-col gap-2">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  ) : null;

  const pill = (
    <button
      type="button"
      data-run-pill={id}
      data-node-primary={primary || undefined}
      aria-label={t("canvas.nodes.pill.run", { name })}
      aria-disabled={blocked || undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void run("node", { bypassCache: event.altKey, anchor: event.currentTarget });
      }}
      className={cn(
        "nodrag flex h-32 shrink-0 cursor-pointer items-center gap-6 rounded-full bg-accent pr-12 pl-10 text-accent-fg transition-colors not-disabled:hover:bg-accent-hover disabled:cursor-default",
        (blocked || disabled || muted) && "opacity-40",
        className,
      )}
    >
      <Play size={12} aria-hidden className="shrink-0" />
      {price ? (
        <span className="text-mono-12 font-medium">{price}</span>
      ) : (
        <span className="text-caption font-medium">
          {estimate?.confidence === "unknown" ? t("cost.unknown") : t("canvas.nodes.state.run")}
        </span>
      )}
      {suffix ? <span className="text-caption">{suffix}</span> : null}
    </button>
  );
  return tip ? <Tooltip content={tip}>{pill}</Tooltip> : pill;
}
