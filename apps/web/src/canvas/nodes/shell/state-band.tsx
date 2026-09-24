import { ERROR_PRIMARY_ACTION, type ErrorCode, errorCopy, t } from "@openfield/core";
import { Button, cn, ProgressBar, Spinner } from "@openfield/ui";
import { Check, CircleAlert, Clock3, Info, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useProviders } from "../../../api/hooks/keys";
import { providerOfKey } from "../../../lib/provider";
import type { NodeBlocker, NodeDisplay } from "../../engine/types";
import { useCanvasActions, useCanvasStoreApi, useNodeResult, useNodeRuntime } from "../../store/context";
import { blockerCopy } from "./blocker-copy";
import { focusNodeSoon } from "./focus";
import { useRunNode } from "./use-node";

// Canvas / State / * (design RkANM, SZYCt, rQEK8, EiZcq, hdJBU, w9r4d, lJ9Zj): one band across the
// bottom of a node's preview, and its action. Only runnable nodes have one.

/** Seconds since a run started, ticking while it's on screen. */
function useElapsed(since: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export interface StateBandProps {
  id: string;
  display: NodeDisplay;
  /** The node's model, for the failed band's billing link. */
  model: string | null;
}

export function StateBand({ id, display, model }: StateBandProps) {
  switch (display.state) {
    case "queued":
      return <WaitingBand id={id} />;
    case "running":
      return <GeneratingBand id={id} />;
    case "blocked":
      return display.blocker ? <BlockedBand id={id} blocker={display.blocker} /> : null;
    case "failed":
      return <FailedBand id={id} model={model} />;
    case "canceled":
      return <CanceledBand id={id} />;
    case "done":
      return display.chip === "up_to_date" ? <UpToDateChip /> : null;
    case "stale":
      return <ChangedBand id={id} late={display.chip === "older_settings"} />;
    default:
      return null;
  }
}

function useCancel(id: string) {
  const store = useCanvasStoreApi();
  return () => void store.getState().runController.cancelNode(id);
}

function WaitingBand({ id }: { id: string }) {
  const position = useNodeRuntime(id)?.position ?? null;
  const cancel = useCancel(id);
  return (
    <div className="flex w-full items-center gap-8 bg-accent-soft py-10 pr-8 pl-12">
      <Clock3 size={14} aria-hidden className="shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-1 items-center gap-6">
        <span className="text-small font-medium text-text-primary">{t("canvas.nodes.state.waiting")}</span>
        {position ? (
          <span className="truncate text-caption text-text-tertiary">
            {t("canvas.nodes.state.position", { position })}
          </span>
        ) : null}
      </div>
      <Button variant="ghost" size="s" className="nodrag" onClick={cancel}>
        {t("canvas.nodes.state.cancel")}
      </Button>
    </div>
  );
}

function GeneratingBand({ id }: { id: string }) {
  const runtime = useNodeRuntime(id);
  const elapsed = useElapsed(runtime?.startedAt ?? null, true);
  const cancel = useCancel(id);
  const share =
    runtime?.progress ??
    (runtime && runtime.total > 0 && runtime.done > 0 ? runtime.done / runtime.total : null);
  return (
    <div className="flex w-full flex-col gap-6 bg-elevated pt-6 pr-8 pb-10 pl-12">
      <div className="flex w-full items-center gap-8">
        <Spinner size={16} className="text-text-secondary" />
        <span className="text-small font-medium text-text-primary">{t("canvas.nodes.state.generating")}</span>
        <span className="text-mono-12 text-text-tertiary">{clock(elapsed)}</span>
        <span className="h-1 flex-1" />
        <Button variant="ghost" size="s" className="nodrag" onClick={cancel}>
          {t("canvas.nodes.state.cancel")}
        </Button>
      </div>
      <ProgressBar value={share ?? undefined} className="w-full" />
    </div>
  );
}

/** rQEK8: a blurred pill over the image, under the chips. */
function UpToDateChip() {
  return (
    <div className="flex w-full items-center gap-8 px-10 pb-10">
      <span className="flex items-center gap-6 rounded-full bg-overlay px-10 py-4 inset-ring inset-ring-border backdrop-blur-chip">
        <Check size={12} aria-hidden className="shrink-0 text-overlay-fg-muted" />
        <span className="text-caption font-medium text-overlay-fg">{t("canvas.nodes.state.upToDate")}</span>
      </span>
    </div>
  );
}

function ChangedBand({ id, late }: { id: string; late: boolean }) {
  const run = useRunNode(id);
  return (
    <div className="flex w-full items-center gap-8 bg-elevated py-6 pr-6 pl-12">
      <span aria-hidden className="size-6 shrink-0 rounded-full bg-accent" />
      <span className="min-w-0 flex-1 truncate text-small font-medium text-text-primary">
        {late ? t("canvas.nodes.state.olderSettings") : t("canvas.nodes.state.inputsChanged")}
      </span>
      <Button
        variant="ghost-accent"
        size="s"
        icon={RefreshCw}
        className="nodrag"
        onClick={(event) => {
          void run("node", { anchor: event.currentTarget });
          focusNodeSoon(id);
        }}
      >
        {t("canvas.nodes.state.runAgain")}
      </Button>
    </div>
  );
}

function FailedBand({ id, model }: { id: string; model: string | null }) {
  const result = useNodeResult(id);
  const runtime = useNodeRuntime(id);
  const run = useRunNode(id);
  const actions = useCanvasActions();
  const navigate = useNavigate();
  const providers = useProviders().data;
  const error = result?.error ?? runtime?.error ?? null;
  const code: ErrorCode = error?.code ?? "unknown";
  const copy = errorCopy(code);
  const refused = code === "content_refused" || code === "content_flagged_input";
  const message = refused ? t("canvas.nodes.state.refused") : (error?.reason ?? copy.reason);
  const consoleUrl = providers?.find((p) => p.id === providerOfKey(model ?? ""))?.meta.consoleUrl;
  const [expanded, setExpanded] = useState(false);

  const fix = ((): { label: string; run: () => void } => {
    const again = {
      label: t("actions.tryAgain"),
      run: () => {
        void run("node");
        focusNodeSoon(id);
      },
    };
    switch (ERROR_PRIMARY_ACTION[code]) {
      case "open-settings":
      case "change-key":
        return {
          label: copy.action,
          run: () => navigate("/settings/api-keys", { state: { focusKey: true } }),
        };
      case "open-billing":
        return consoleUrl
          ? { label: copy.action, run: () => window.open(consoleUrl, "_blank", "noopener") }
          : again;
      case "free-up-space":
        return { label: copy.action, run: () => navigate("/settings/storage") };
      case "reuse":
        // The same request would fail the same way: change it first.
        return refused
          ? { label: t("canvas.nodes.state.editPrompt"), run: () => actions.openInspector(id) }
          : { label: t("canvas.nodes.blocked.pickModel"), run: () => actions.openInspector(id) };
      default:
        return again;
    }
  })();

  return (
    <div className="flex w-full items-center gap-8 bg-danger-soft py-10 pr-8 pl-12 shadow-[inset_0_1px_0_var(--of-danger-line)]">
      <CircleAlert size={14} aria-hidden className="shrink-0 text-danger" />
      {/* Two lines, and the rest on a click; Copy error is in the node menu. */}
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? undefined : message}
        onClick={() => setExpanded((open) => !open)}
        className={cn(
          "nodrag min-w-0 flex-1 cursor-pointer text-left text-small leading-[1.45] text-text-primary",
          !expanded && "line-clamp-2",
        )}
      >
        {message}
      </button>
      <Button variant="secondary" size="s" className="nodrag" onClick={fix.run}>
        {fix.label}
      </Button>
    </div>
  );
}

function CanceledBand({ id }: { id: string }) {
  const run = useRunNode(id);
  return (
    <div className="flex w-full items-center gap-8 bg-elevated-2 py-10 pr-8 pl-12">
      <p className="min-w-0 flex-1 text-caption leading-[1.45] text-text-secondary">
        {t("canvas.nodes.state.canceled")}
      </p>
      <Button
        variant="ghost"
        size="s"
        className="nodrag"
        onClick={() => {
          void run("node");
          focusNodeSoon(id);
        }}
      >
        {t("canvas.nodes.state.run")}
      </Button>
    </div>
  );
}

function BlockedBand({ id, blocker }: { id: string; blocker: NodeBlocker }) {
  const providers = useProviders().data;
  const navigate = useNavigate();
  const actions = useCanvasActions();
  const copy = blockerCopy(blocker, providers);
  const Icon = blocker.kind === "no_key" || blocker.kind === "company_off" ? KeyRound : Info;
  const onFix = () => {
    if (copy.fix === "add_key") navigate("/settings/api-keys", { state: { focusKey: true } });
    else if (copy.fix === "open_settings") navigate("/settings/api-keys");
    else if (copy.fix === "pick_model") actions.openInspector(id);
  };
  return (
    <div className="of-blocked-stripes flex w-full items-center gap-8 bg-elevated-2 py-10 pr-8 pl-12">
      <Icon size={14} aria-hidden className="shrink-0 text-text-secondary" />
      <p className="min-w-0 flex-1 text-small leading-[1.35] font-medium text-text-primary">{copy.message}</p>
      {copy.action ? (
        <Button variant="secondary" size="s" className="nodrag" onClick={onFix}>
          {copy.action}
        </Button>
      ) : null}
    </div>
  );
}
