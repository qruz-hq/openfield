import { t } from "@openfield/core";
import { cn, IconButton } from "@openfield/ui";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useProviders } from "../../../api/hooks/keys";
import type { NodeDisplay } from "../../engine/types";
import { useCanvasActions, useReadOnly } from "../../store/context";
import { blockerCopy } from "./blocker-copy";
import { AssetImage } from "./thumb";

// Canvas / Node / Collapsed (design lXVSR): a 56-tall card with what the node is (its model, or a
// line of its text), up to three thumbnails and Expand. Collapsed state is saved (§7.5). A node that
// runs also says what state it's in, with the label's dot, since its band is folded away.

export interface CollapsedCardProps {
  id: string;
  name: string;
  meta: ReactNode;
  status?: ReactNode;
  thumbs: readonly string[];
}

/** The state line a collapsed runnable node shows in place of its band. Nothing when all is well. */
export function CollapsedStatus({ display }: { display: NodeDisplay }) {
  const providers = useProviders().data;
  const line = ((): { text: string; tone: "accent" | "danger" | "muted" } | null => {
    switch (display.state) {
      case "queued":
        return { text: t("canvas.nodes.state.waiting"), tone: "muted" };
      case "running":
        return { text: t("canvas.nodes.state.generating"), tone: "accent" };
      case "blocked":
        return display.blocker
          ? { text: blockerCopy(display.blocker, providers).message, tone: "muted" }
          : null;
      case "failed":
        return { text: t("canvas.nodes.collapsed.failed"), tone: "danger" };
      case "canceled":
        return { text: t("canvas.nodes.collapsed.canceled"), tone: "muted" };
      case "stale":
        return {
          text:
            display.chip === "older_settings"
              ? t("canvas.nodes.state.olderSettings")
              : t("canvas.nodes.state.inputsChanged"),
          tone: "accent",
        };
      default:
        return null;
    }
  })();
  if (!line) return null;
  return (
    <span className="flex min-w-0 items-center gap-6" title={line.text}>
      <span
        aria-hidden
        className={cn(
          "size-6 shrink-0 rounded-full",
          line.tone === "accent" ? "bg-accent" : line.tone === "danger" ? "bg-danger" : "bg-text-tertiary",
        )}
      />
      <span className="truncate text-micro text-text-secondary">{line.text}</span>
    </span>
  );
}

export function CollapsedCard({ id, name, meta, status, thumbs }: CollapsedCardProps) {
  const actions = useCanvasActions();
  const readOnly = useReadOnly();
  return (
    <div className="flex h-56 w-full items-center gap-10 px-20">
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <div className="flex min-w-0">{meta}</div>
        {status}
      </div>
      {thumbs.length ? (
        <div className="flex shrink-0 gap-4">
          {thumbs.slice(0, 3).map((assetId) => (
            <AssetImage key={assetId} assetId={assetId} height={32} className="size-32 rounded-6" />
          ))}
        </div>
      ) : null}
      <IconButton
        icon={Maximize2}
        size={24}
        label={t("canvas.nodes.collapsed.expand", { name })}
        disabled={readOnly}
        className="nodrag"
        onClick={() => actions.apply([{ op: "setCollapsed", id, collapsed: false }])}
      />
    </div>
  );
}
