import {
  ASPECT_RATIOS,
  type AssetListItem,
  ERROR_PRIMARY_ACTION,
  type ErrorCode,
  errorCopy,
  formatDate,
  formatDateTime,
  type Job,
  type JobSet,
  type MessageKey,
  type ModelListItem,
  RESOLUTION_TIER_PX,
  RESOLUTION_TIERS,
  t,
} from "@openfield/core";
import { nearestRatio } from "@openfield/providers/manifest";
import {
  Button,
  IconButton,
  KeyValueList,
  KeyValueRow,
  ModelCaption,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  TileCancelPill,
  TileStatusPill,
} from "@openfield/ui";
import {
  ArrowUpRight,
  CircleAlert,
  HardDrive,
  KeyRound,
  type LucideIcon,
  RefreshCcw,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuthedImage } from "../api/hooks/images";
import { useCancelJob, useRecreateJobSet, useRetryJobSet } from "../api/hooks/job-sets";
import { useProviders } from "../api/hooks/keys";
import { ApiError, errorMessage } from "../api/raw";
import { useDismissed, useLive } from "../lib/live";
import { notify, notifyError } from "../lib/notify";
import { logoFor, providerOfKey } from "../lib/provider";
import { useReuse } from "./composer/use-reuse";
import { endedWithoutImage, jobTileState } from "./feed-items";

// Feed / Tile / {Idle, Generating, Queued, Failed}. Radius 0: the image is the tile (§2.4).

interface TileBox {
  style: CSSProperties;
}

const box = "relative shrink-0 overflow-hidden";

function thumbPath(asset: AssetListItem, rung: number): string {
  const url = new URL(asset.thumbUrl || `/files/thumb/${asset.id}`, window.location.origin);
  url.searchParams.set("h", String(rung));
  if (window.devicePixelRatio > 1) url.searchParams.set("dpr", "2");
  else url.searchParams.delete("dpr");
  return `${url.pathname}${url.search}`;
}

export function AssetTile({
  asset,
  rung,
  model,
  style,
}: TileBox & { asset: AssetListItem; rung: number; model?: string }) {
  const image = useAuthedImage(thumbPath(asset, rung));
  const label = t("feed.tile.label", {
    prompt: asset.prompt.trim() ? truncate(asset.prompt, 80) : t("feed.tile.noPrompt"),
    model: model ?? asset.modelId ?? "",
    date: formatDate(asset.createdAt),
  });
  return (
    <li aria-label={label} className={`${box} bg-elevated`} style={style}>
      {image.status === "ready" ? (
        <img src={image.src} alt="" className="size-full object-cover" decoding="async" draggable={false} />
      ) : null}
    </li>
  );
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** "3:4" and "1K" from the pixel size the server reserved, matched against the model's own ratios. */
function shapeOf(job: Job, model: ModelListItem | undefined) {
  const size = model?.capabilities.size;
  const aspect = nearestRatio(job.width, job.height, size?.mode === "aspect" ? size.ratios : ASPECT_RATIOS);
  const long = Math.max(job.width, job.height);
  const tier = RESOLUTION_TIERS.reduce((best, tier) =>
    Math.abs(RESOLUTION_TIER_PX[tier] - long) < Math.abs(RESOLUTION_TIER_PX[best] - long) ? tier : best,
  );
  return { aspect: aspect ?? "1:1", resolution: tier };
}

/** Seconds since a run started, ticking only while it's on screen. */
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

interface JobTileProps extends TileBox {
  jobSet: JobSet;
  job: Job;
  /** Every job in the run. */
  jobs: readonly Job[];
  model: ModelListItem | undefined;
}

export function JobTile(props: JobTileProps) {
  const position = useLive((s) => s.positions[props.job.id]);
  const state = jobTileState(props.job, position);
  if (state === "failed") return <FailedTile {...props} />;
  return <WorkingTile {...props} queued={state === "queued"} position={position} />;
}

function WorkingTile({
  jobSet,
  job,
  model,
  style,
  queued,
  position,
}: JobTileProps & { queued: boolean; position?: number }) {
  const cancel = useCancelJob();
  const elapsed = useElapsed(job.startedAt ?? jobSet.createdAt, !queued);
  const logo = logoFor(model?.providerId ?? providerOfKey(jobSet.model));
  const shape = shapeOf(job, model);
  const name = model?.displayName ?? jobSet.model;
  const summary = t("feed.tile.summary", { model: name, aspect: shape.aspect, resolution: shape.resolution });

  // The tile turns into a canceled one as soon as the cancel lands, so no mutate() callbacks here.
  const onCancel = () =>
    void cancel.mutateAsync(job.id).then(
      () => notify(t("toast.canceled")),
      (error: unknown) => notifyError(errorMessage(error)),
    );

  return (
    <li aria-busy="true" aria-label={summary} className={`${box} bg-elevated`} style={style}>
      {queued ? (
        <TileStatusPill status="queued" className="absolute top-12 left-12">
          {position ? t("feed.tile.inLine", { position }) : t("feed.tile.queued")}
        </TileStatusPill>
      ) : (
        <TileStatusPill status="generating" className="absolute top-12 left-12">
          {t("feed.tile.generating")}
        </TileStatusPill>
      )}
      <TileCancelPill className="absolute top-12 right-12" onClick={onCancel} disabled={cancel.isPending}>
        {t("feed.tile.cancel")}
      </TileCancelPill>
      <div className={`absolute left-12 flex flex-col gap-4 ${queued ? "bottom-21" : "bottom-25"}`}>
        {logo ? (
          <ModelCaption provider={logo} name={<span className="text-text-tertiary">{summary}</span>} />
        ) : (
          <span className="text-micro text-text-tertiary">{summary}</span>
        )}
        <span className="text-micro text-text-secondary">
          {queued
            ? t("feed.tile.images", { count: jobSet.batchSize })
            : t("feed.tile.progress", { index: job.idx + 1, total: jobSet.batchSize })}
          {!queued && elapsed >= 10 ? (
            <span className="text-mono-11 text-text-tertiary">{` ${clock(elapsed)}`}</span>
          ) : null}
        </span>
        {!queued && elapsed >= 45 ? (
          <span className="text-micro text-text-secondary">{t("feed.tile.stillWorking")}</span>
        ) : null}
      </div>
      {queued ? null : (
        <ProgressBar
          value={job.progress ?? undefined}
          label={t("feed.tile.generating")}
          className="absolute inset-x-0 bottom-0"
        />
      )}
    </li>
  );
}

type Fix = { label: string; icon: LucideIcon; run: () => void; pending?: boolean };

function FailedTile({ jobSet, job, jobs, style }: JobTileProps) {
  const navigate = useNavigate();
  const retry = useRetryJobSet();
  const recreate = useRecreateJobSet();
  const dismiss = useDismissed((s) => s.dismiss);
  const reuse = useReuse();
  const providers = useProviders();

  const code: ErrorCode = job.status === "canceled" ? "canceled" : (job.errorCode ?? "unknown");
  const copy = errorCopy(code);
  const reason = job.status === "interrupted" ? t("feed.tile.interrupted") : (job.errorReason ?? copy.reason);
  const action = job.status === "interrupted" ? "try-again" : ERROR_PRIMARY_ACTION[code];
  // Try again and Recreate act on the whole run, so every tile the run left behind goes with it.
  // Promises rather than mutate() callbacks: the new run reflows the feed and can unmount this tile
  // before the answer arrives, and mutate() drops its callbacks when that happens.
  const clearRun = () => dismiss(endedWithoutImage(jobs).map((j) => j.id));

  const tryAgain: Fix = {
    label: t("actions.tryAgain"),
    icon: RefreshCw,
    pending: retry.isPending,
    run: () =>
      void retry.mutateAsync(jobSet.id).then(clearRun, (error: unknown) =>
        // Already tried again, from another tile or tab: its new tiles are in the feed.
        error instanceof ApiError && error.status === 409 ? clearRun() : notifyError(errorMessage(error)),
      ),
  };
  const consoleUrl = providers.data?.find((p) => p.id === providerOfKey(jobSet.model))?.meta.consoleUrl;

  const primary: Fix | null = (() => {
    switch (action) {
      case "open-settings":
        return { label: copy.action, icon: Settings, run: () => navigate("/settings/api-keys") };
      case "change-key":
        return { label: copy.action, icon: KeyRound, run: () => navigate("/settings/api-keys") };
      case "open-billing":
        return consoleUrl
          ? {
              label: copy.action,
              icon: ArrowUpRight,
              run: () => window.open(consoleUrl, "_blank", "noopener"),
            }
          : tryAgain;
      case "free-up-space":
        return { label: copy.action, icon: HardDrive, run: () => navigate("/settings/storage") };
      case "recreate":
        return {
          label: copy.action,
          icon: RefreshCw,
          pending: recreate.isPending,
          run: () =>
            void recreate
              .mutateAsync(jobSet.id)
              .then(clearRun, (error: unknown) => notifyError(errorMessage(error))),
        };
      case "try-again":
        return tryAgain;
      default:
        // Reuse and Details lead instead: the same request would only fail the same way.
        return null;
    }
  })();
  const accent = primary ? null : action === "details" ? "details" : "reuse";

  return (
    <li
      aria-label={reason}
      className={`${box} flex flex-col items-center justify-center bg-danger-soft inset-ring inset-ring-danger-line`}
      style={style}
    >
      <div className="flex w-300 max-w-[calc(100%-24px)] flex-col items-center gap-12">
        <CircleAlert size={20} aria-hidden className="shrink-0 text-danger" />
        <p className="w-full text-center text-small leading-[1.45] text-text-primary">{reason}</p>
        {/* One row, as wide as its buttons: a long label never pushes Details onto a second line. */}
        <div className="flex w-max shrink-0 items-center gap-6">
          {primary ? (
            <Button
              variant="ghost-accent"
              size="s"
              icon={primary.icon}
              loading={primary.pending}
              onClick={primary.run}
            >
              {primary.label}
            </Button>
          ) : null}
          <Button
            variant={accent === "reuse" ? "ghost-accent" : "ghost"}
            size="s"
            icon={RefreshCcw}
            onClick={() => reuse({ prompt: jobSet.prompt, model: jobSet.model })}
          >
            {t("actions.reuse")}
          </Button>
          <FailureDetails job={job} accent={accent === "details"} />
        </div>
      </div>
      <IconButton
        icon={X}
        label={t("actions.dismiss")}
        className="absolute top-8 right-8"
        onClick={() => dismiss([job.id])}
      />
    </li>
  );
}

/** What to try next for failures whose tile offers no fix of its own. */
const HINTS: Partial<Record<ErrorCode, MessageKey>> = {
  invalid_request: "feed.tile.details.hints.settings",
  payload_too_large: "feed.tile.details.hints.tooLarge",
  provider_unavailable: "feed.tile.details.hints.company",
  provider_error: "feed.tile.details.hints.company",
  unknown: "feed.tile.details.hints.unknown",
};

/**
 * When it happened and what to try. Only our own words: the error code and the company's message
 * are for the error log, never the tile (§0.15).
 */
function FailureDetails({ job, accent }: { job: Job; accent: boolean }) {
  const when = job.finishedAt ?? job.startedAt;
  const hint =
    job.status === "interrupted"
      ? "feed.tile.details.hints.interrupted"
      : job.errorCode
        ? HINTS[job.errorCode]
        : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={accent ? "ghost-accent" : "ghost"} size="s">
          {t("actions.details")}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="flex w-320 flex-col gap-10 p-16">
        <p className="text-body-strong text-text-primary">{t("feed.tile.details.title")}</p>
        <p className="text-small leading-[1.45] text-text-secondary">
          {hint ? t(hint) : t("feed.tile.details.noMessage")}
        </p>
        {when ? (
          <KeyValueList>
            <KeyValueRow label={t("feed.tile.details.when")} value={formatDateTime(when)} />
          </KeyValueList>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
