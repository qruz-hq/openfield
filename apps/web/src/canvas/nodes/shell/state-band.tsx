import { ERROR_PRIMARY_ACTION, type ErrorCode, errorCopy, t } from "@openfield/core";
import { Button, cn, ProgressBar, Spinner } from "@openfield/ui";
import { Check, CircleAlert, Clock3, Info, KeyRound, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useProviders } from "../../../api/hooks/keys";
import { companyName, providerOfKey } from "../../../lib/provider";
import type { NodeBlocker, NodeDisplay } from "../../engine/types";
import { useCanvasActions, useCanvasStoreApi, useNodeResult, useNodeRuntime } from "../../store/context";
import { blockerCopy, companyOf } from "./blocker-copy";
import { type CompanyWait, useCompanyWait } from "./company-wait";
import { focusNodeSoon } from "./focus";
import { useRunNode } from "./use-node";

// Canvas / State / * (design RkANM, SZYCt, rQEK8, EiZcq, hdJBU, w9r4d, lJ9Zj): one band across the
// bottom of a node's preview, and its action. Only runnable nodes have one. Same words as the
// Generate card: Stop for a run under way, Cancel for one waiting, Run again after a cancel.

/** Seconds since a run started, ticking while it's on screen. */
export function useElapsed(since: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
}

export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export interface StateBandProps {
  id: string;
  display: NodeDisplay;
  /** The node's model, for the failed band's billing link. */
  model: string | null;
  /** The node's name, for the Stop button's accessible name ("Stop Variations"). */
  name: string;
}

export function StateBand({ id, display, model, name }: StateBandProps) {
  switch (display.state) {
    case "queued":
    case "running":
      return <BusyBand id={id} name={name} running={display.state === "running"} />;
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

export function useCancel(id: string) {
  const store = useCanvasStoreApi();
  return () => void store.getState().runController.cancelNode(id);
}

function BusyBand({ id, name, running }: { id: string; name: string; running: boolean }) {
  const wait = useCompanyWait(id);
  if (wait) return <CompanyBand id={id} wait={wait} />;
  return running ? <GeneratingBand id={id} name={name} /> : <WaitingBand id={id} />;
}

/**
 * The Waiting band in the Image tab's Batch and Flex words: no timer or bar, as there's no progress
 * to show.
 */
function CompanyBand({ id, wait }: { id: string; wait: CompanyWait }) {
  const company = companyName(useProviders().data, wait.providerId);
  const cancel = useCancel(id);
  const batch = wait.speed === "batch" ? wait : null;
  const status = batch?.stopping
    ? t("speed.tile.stopping", { company })
    : batch?.state === "submitting"
      ? t("speed.tile.sending", { company })
      : batch
        ? t("speed.tile.waiting", { company })
        : t("speed.tile.waitingFor", { company });
  // Nothing to promise while the run is being sent or stopped.
  const hint = !batch
    ? t("speed.tile.fewMinutes")
    : batch.stopping || batch.state === "submitting"
      ? null
      : t("speed.tile.fewHours");
  return (
    <div className="flex w-full items-center gap-8 bg-accent-soft py-10 pr-8 pl-12">
      <Clock3 size={14} aria-hidden className="shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate text-small font-medium text-text-primary">{status}</span>
        {hint ? <span className="truncate text-caption text-text-tertiary">{hint}</span> : null}
      </div>
      {batch?.stopping ? null : (
        <Button variant="ghost" size="s" className="nodrag" onClick={cancel}>
          {t("canvas.nodes.state.cancel")}
        </Button>
      )}
    </div>
  );
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

function GeneratingBand({ id, name }: { id: string; name: string }) {
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
        <Button
          variant="ghost"
          size="s"
          aria-label={t("canvas.nodes.card.stopNamed", { name })}
          className="nodrag"
          onClick={cancel}
        >
          {t("canvas.nodes.card.stop")}
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
        icon={Play}
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

/** What went wrong with a failed node, and the one thing to do about it. */
export interface FailureFix {
  message: string;
  action: { label: string; kind: "try_again" | "edit_prompt" | "other"; run: () => void };
}

export function useFailureFix(id: string, model: string | null): FailureFix {
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

  const again = {
    label: t("actions.tryAgain"),
    kind: "try_again" as const,
    run: () => {
      void run("node");
      focusNodeSoon(id);
    },
  };
  const other = (label: string, go: () => void) => ({ label, kind: "other" as const, run: go });
  const action = ((): FailureFix["action"] => {
    switch (ERROR_PRIMARY_ACTION[code]) {
      case "open-settings":
      case "change-key":
        return other(copy.action, () => navigate("/settings/api-keys", { state: { focusKey: true } }));
      case "open-billing":
        return consoleUrl ? other(copy.action, () => window.open(consoleUrl, "_blank", "noopener")) : again;
      case "free-up-space":
        return other(copy.action, () => navigate("/settings/storage"));
      case "reuse":
        // The same request would fail the same way: change it first.
        return refused
          ? {
              label: t("canvas.nodes.state.editPrompt"),
              kind: "edit_prompt",
              run: () => actions.openInspector(id),
            }
          : other(t("canvas.nodes.blocked.pickModel"), () => actions.openInspector(id));
      default:
        return again;
    }
  })();
  return { message, action };
}

function FailedBand({ id, model }: { id: string; model: string | null }) {
  const { message, action: fix } = useFailureFix(id, model);
  const [expanded, setExpanded] = useState(false);

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
        {t("canvas.nodes.card.charged")}
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
        {t("canvas.nodes.state.runAgain")}
      </Button>
    </div>
  );
}

/** A blocker's fix: add a key, open Settings or pick another model, where one helps. */
export function useBlockerFix(id: string, blocker: NodeBlocker) {
  const providers = useProviders().data;
  const navigate = useNavigate();
  const actions = useCanvasActions();
  const copy = blockerCopy(blocker, providers);
  const onFix = () => {
    if (copy.fix === "add_key") navigate("/settings/api-keys", { state: { focusKey: true } });
    else if (copy.fix === "open_settings") navigate("/settings/api-keys");
    else if (copy.fix === "pick_model") actions.openInspector(id);
  };
  return { copy, onFix };
}

/** What a blocked node says: a missing key in the card's words ("No Google key yet."), else the blocker's own. */
export function useBlockedMessage(blocker: NodeBlocker): string {
  const providers = useProviders().data;
  return blocker.kind === "no_key"
    ? t("canvas.nodes.card.noKey", { company: companyOf(providers, blocker.model) })
    : blockerCopy(blocker, providers).message;
}

function BlockedBand({ id, blocker }: { id: string; blocker: NodeBlocker }) {
  const { copy, onFix } = useBlockerFix(id, blocker);
  const message = useBlockedMessage(blocker);
  // The key icon only for a missing key, like the card's pill.
  const Icon = blocker.kind === "no_key" ? KeyRound : Info;
  return (
    <div className="of-blocked-stripes flex w-full items-center gap-8 bg-elevated-2 py-10 pr-8 pl-12">
      <Icon size={14} aria-hidden className="shrink-0 text-text-secondary" />
      <p className="min-w-0 flex-1 text-small leading-[1.35] font-medium text-text-primary">{message}</p>
      {copy.action ? (
        <Button variant="secondary" size="s" className="nodrag" onClick={onFix}>
          {copy.action}
        </Button>
      ) : null}
    </div>
  );
}
