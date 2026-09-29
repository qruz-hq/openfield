import {
  ASPECT_RATIOS,
  type AssetListItem,
  type BatchSummary,
  type CancelResponse,
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
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalTrigger,
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
  Eye,
  HardDrive,
  KeyRound,
  type LucideIcon,
  RefreshCcw,
  RefreshCw,
  RotateCcw,
  Settings,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuthedImage } from "../api/hooks/images";
import {
  isActiveJob,
  patchBatch,
  useCancelJob,
  useCancelJobSet,
  useRecreateJobSet,
  useRetryJobSet,
} from "../api/hooks/job-sets";
import { useProviders } from "../api/hooks/keys";
import { useSpeedName } from "../api/hooks/provider-settings";
import { ApiError, errorMessage } from "../api/raw";
import { detailTarget, useIsLastViewed, useOpenDetail } from "../detail";
import { useDismissed, useLive } from "../lib/live";
import { notify, notifyError } from "../lib/notify";
import { companyName, logoFor, providerOfKey } from "../lib/provider";
import { useReuse } from "./composer/use-reuse";
import {
  endedWithoutImage,
  failedAction,
  jobTileState,
  type RestartNote,
  restartNote,
  type WaitKind,
  waitKind,
} from "./feed-items";

// Feed / Tile / {Idle, Generating, Queued, Waiting at provider, Failed}. Radius 0: the image is the
// tile (§2.4).

export interface TileBox {
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
  rerun = false,
  style,
}: TileBox & { asset: AssetListItem; rung: number; model?: string; rerun?: boolean }) {
  const image = useAuthedImage(thumbPath(asset, rung));
  const openDetail = useOpenDetail();
  const lastViewed = useIsLastViewed(asset.id);
  const label = t("feed.tile.label", {
    prompt: asset.prompt.trim() ? truncate(asset.prompt, 80) : t("feed.tile.noPrompt"),
    model: model ?? asset.modelId ?? "",
    date: formatDate(asset.createdAt),
  });
  // The pill is too short to warn about billing, so the name carries it for a screen reader.
  const name = rerun ? `${label}. ${t("feed.tile.rerunLabel")}` : label;
  return (
    <li
      aria-label={name}
      data-job-set={asset.jobSetId ?? undefined}
      className={`${box} bg-elevated`}
      style={style}
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" className="size-full object-cover" decoding="async" draggable={false} />
      ) : null}
      {/* Feed / Tile / Last viewed (design UnAoB): a 1px inner stroke and the eye badge. */}
      {lastViewed ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 inset-ring inset-ring-border-strong"
        />
      ) : null}
      {lastViewed || rerun ? (
        // One row at 10,10: the eye badge, then the note 8 after it (design MKHsL).
        <span
          aria-hidden
          className="pointer-events-none absolute top-10 left-10 flex max-w-[calc(100%-20px)] items-center gap-8"
        >
          {lastViewed ? <LastViewedBadge /> : null}
          {rerun ? <RerunNote /> : null}
        </span>
      ) : null}
      {/* A plain click opens the detail view (§4.0); it takes focus back when that closes. */}
      <button
        type="button"
        aria-label={name}
        {...detailTarget(asset.id)}
        onClick={() => openDetail(asset.id)}
        className="absolute inset-0 cursor-pointer focus-visible:-outline-offset-2"
      />
    </li>
  );
}

/** The Last viewed badge (design HEOEH): 24 round, the eye on the overlay fill. */
function LastViewedBadge() {
  return (
    <span className="flex size-24 shrink-0 items-center justify-center rounded-full bg-overlay inset-ring inset-ring-overlay-line backdrop-blur-chip">
      <Eye size={14} className="text-overlay-fg" />
    </span>
  );
}

/**
 * Pill / Tile note / Ran again (design MKHsL): the Last viewed badge's treatment, dark in both
 * themes because it sits on the image. It belongs to the idle tile: hover and selection put the
 * checkbox in this corner (§2.4). The tile has neither state yet: when they come, hide the badge
 * row on hover and selection.
 */
function RerunNote() {
  return (
    <span className="inline-flex h-24 min-w-0 items-center gap-6 rounded-full bg-overlay px-10 inset-ring inset-ring-overlay-line backdrop-blur-chip">
      <RotateCcw size={12} className="shrink-0 text-overlay-fg-muted" />
      <span className="min-w-0 truncate text-caption font-medium text-overlay-fg">
        {t("feed.tile.rerunNote")}
      </span>
    </span>
  );
}

/** The meta lines a restart puts under the model line, in place of the tile's usual ones. */
function restartLines(note: RestartNote | null): string[] {
  if (note === "rerun") return [t("feed.tile.rerunning"), t("feed.tile.chargedTwice")];
  return note === "resumed" ? [t("feed.tile.resumed")] : [];
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

/** The clock, ticking once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Seconds since a run started, ticking only while it's on screen. */
function useElapsed(since: string | null, active: boolean): number {
  const now = useNow(active);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
}

/** "Nano Banana Pro · 3:4 · 2K", with the speed after it, by its company's name, when it isn't Standard. */
function summaryOf(jobSet: JobSet, job: Job, model: ModelListItem | undefined, speed: string): string {
  const shape = shapeOf(job, model);
  const vars = {
    model: model?.displayName ?? jobSet.model,
    aspect: shape.aspect,
    resolution: shape.resolution,
  };
  return jobSet.speed === "standard"
    ? t("feed.tile.summary", vars)
    : t("feed.tile.summaryWithSpeed", { ...vars, speed });
}

/** "2 min" or "40s" until a waiting job goes again. */
function waitLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 60
    ? t("speed.wait.minutes", { count: Math.ceil(seconds / 60) })
    : t("speed.wait.seconds", { count: seconds });
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export interface JobTileProps extends TileBox {
  jobSet: JobSet;
  job: Job;
  /** Every job in the run. */
  jobs: readonly Job[];
  /** A Batch run's provider batch, once it has one. */
  batch?: BatchSummary | undefined;
  model: ModelListItem | undefined;
}

export function JobTile(props: JobTileProps) {
  const position = useLive((s) => s.positions[props.job.id]);
  const retry = useLive((s) => s.retries[props.job.id]);
  const state = jobTileState(props.job, position, props.jobSet);
  if (state === "failed") return <FailedTile {...props} />;
  const wait = waitKind(props.jobSet, props.job, retry, props.batch);
  if (wait) return <WaitingTile {...props} kind={wait} retryAt={retry?.at ?? props.job.nextAttemptAt} />;
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
  const speedName = useSpeedName();
  const elapsed = useElapsed(job.startedAt ?? jobSet.createdAt, !queued);
  const providerId = model?.providerId ?? providerOfKey(jobSet.model) ?? "";
  const logo = logoFor(providerId);
  const summary = summaryOf(jobSet, job, model, speedName(providerId, jobSet.speed));
  const restart = restartLines(restartNote(job));

  // The tile turns into a canceled one as soon as the cancel lands, so no mutate() callbacks here.
  const onCancel = () =>
    void cancel.mutateAsync(job.id).then(
      () => notify(t("toast.canceled")),
      (error: unknown) => notifyError(errorMessage(error)),
    );

  return (
    <li
      aria-busy="true"
      aria-label={[summary, ...restart].join(". ")}
      data-job-set={jobSet.id}
      className={`${box} bg-elevated`}
      style={style}
    >
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
        {restart.length ? (
          // What happened takes the count line's place (design CZsGt, OfTQn).
          restart.map((line) => (
            <span key={line} className="text-micro text-text-secondary">
              {line}
            </span>
          ))
        ) : (
          <>
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
          </>
        )}
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

/**
 * Feed / Tile / Waiting at provider (design RWSvj) and its Flex variant (LGwLk): a still fill and no
 * progress bar, because there's no progress to show. A Batch run's images stop together, so its
 * Cancel asks first, and the tiles say they're stopping until the company has (§2.4).
 */
/** Exported so the Video feed can reuse it too: BytePlus has no Batch or Flex speed today, but a
 * future video company might. */
export function WaitingTile({
  jobSet,
  job,
  jobs,
  batch: summary,
  model,
  style,
  kind,
  retryAt,
}: JobTileProps & { kind: WaitKind; retryAt: string | null | undefined }) {
  const providers = useProviders();
  const speedName = useSpeedName();
  const cancelJob = useCancelJob();
  const cancelRun = useCancelJobSet();
  const [confirm, setConfirm] = useState(false);
  const keepWaiting = useRef<HTMLButtonElement>(null);
  const now = useNow(kind === "flex-busy");
  const providerId = model?.providerId ?? providerOfKey(jobSet.model) ?? "";
  const company = companyName(providers.data, providerId);
  const logo = logoFor(providerId);
  const speed = speedName(providerId, jobSet.speed);
  const summaryLine = summaryOf(jobSet, job, model, speed);
  const batch = kind === "batch" || kind === "batch-sending";
  const stopping = batch && summary?.stopping === true;
  // A Batch run that came back after a restart looks the same as before it (§2.4).
  const restart = batch ? [] : restartLines(restartNote(job));

  const status = stopping
    ? t("speed.tile.stopping", { company })
    : kind === "batch-sending"
      ? t("speed.tile.sending", { company })
      : kind === "batch"
        ? t("speed.tile.waiting", { company })
        : t("speed.tile.waitingFor", { company });
  // Without the company's name, for a tile too narrow to fit it beside Cancel.
  const shortStatus = t(
    stopping
      ? "speed.tile.short.stopping"
      : kind === "batch-sending"
        ? "speed.tile.short.sending"
        : "speed.tile.short.waiting",
  );
  // Nothing to promise while the run is being sent or stopped.
  const hint =
    kind === "flex-busy" && retryAt
      ? t("speed.tile.busy", { speed, wait: waitLabel(Date.parse(retryAt) - now) })
      : kind === "batch"
        ? stopping
          ? null
          : t("speed.tile.fewHours")
        : kind === "batch-sending"
          ? null
          : t("speed.tile.fewMinutes");

  const failed = (error: unknown) => notifyError(errorMessage(error));
  const onCancelJob = () =>
    void cancelJob.mutateAsync(job.id).then(() => notify(t("toast.canceled")), failed);
  // Sent images end when the company stops: say so, rather than that they're canceled already.
  const onCanceledRun = (res: CancelResponse) => {
    if (!res.stopping?.length) return notify(t("toast.canceled"));
    if (summary) patchBatch(jobSet.id, { ...summary, stopping: true });
    notify(t("speed.cancel.stopping", { company }));
  };
  const cancelBatch = () => {
    setConfirm(false);
    void cancelRun.mutateAsync(jobSet.id).then(onCanceledRun, failed);
  };

  // Off while stopping, but still focusable, so focus has somewhere to land as the dialog closes.
  const off = stopping || cancelRun.isPending;
  const pill = (
    <TileCancelPill
      onClick={(event) => {
        if (off) return event.preventDefault();
        if (!batch) onCancelJob();
      }}
      disabled={cancelJob.isPending}
      aria-disabled={off || undefined}
    >
      {t("feed.tile.cancel")}
    </TileCancelPill>
  );

  return (
    <li
      aria-busy="true"
      // A wait can last hours, so moving through the feed says what it's waiting on, not only what it is.
      aria-label={[status, summaryLine, ...restart, hint].filter(Boolean).join(". ")}
      data-job-set={jobSet.id}
      className={`${box} @container bg-elevated`}
      style={style}
    >
      {/* One row, so a status too long for a narrow tile ends in an ellipsis before it reaches Cancel. */}
      <div className="absolute inset-x-12 top-12 flex items-center justify-between gap-8">
        <TileStatusPill status="waiting" className="min-w-0 shrink">
          <span className="@max-[260px]:hidden">{status}</span>
          <span className="hidden @max-[260px]:inline">{shortStatus}</span>
        </TileStatusPill>
        {batch ? (
          <Modal open={confirm} onOpenChange={setConfirm}>
            <ModalTrigger asChild>{pill}</ModalTrigger>
            <ModalContent
              alert
              title={t("speed.cancel.title", { speed })}
              closeLabel={t("actions.close")}
              // The safe choice first: Enter keeps the run going.
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                keepWaiting.current?.focus();
              }}
            >
              <ModalDescription>
                {t("speed.cancel.body", { count: jobs.filter(isActiveJob).length || jobSet.batchSize })}
              </ModalDescription>
              <ModalFooter>
                <ModalClose asChild>
                  <Button ref={keepWaiting} variant="secondary">
                    {t("speed.cancel.keep")}
                  </Button>
                </ModalClose>
                <Button variant="danger" onClick={cancelBatch}>
                  {t("speed.cancel.confirm")}
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>
        ) : (
          pill
        )}
      </div>
      <div className="absolute bottom-21 left-12 flex max-w-[calc(100%-24px)] flex-col gap-4">
        {logo ? (
          <ModelCaption provider={logo} name={<span className="text-text-tertiary">{summaryLine}</span>} />
        ) : (
          <span className="text-micro text-text-tertiary">{summaryLine}</span>
        )}
        {restart.map((line) => (
          <span key={line} className="truncate text-micro text-text-secondary">
            {line}
          </span>
        ))}
        {hint ? <span className="truncate text-micro text-text-secondary">{hint}</span> : null}
      </div>
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
  const action = failedAction(job, code);
  const providerId = providerOfKey(jobSet.model) ?? "";
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
  const consoleUrl = providers.data?.find((p) => p.id === providerId)?.meta.consoleUrl;

  const primary: Fix | null = (() => {
    switch (action) {
      case "open-settings":
        // The job's own action points at the company's settings (a speed it won't take); the
        // code's usual one at its key.
        return job.errorAction === "open-settings"
          ? {
              label: t("providerSettings.openFor", { company: companyName(providers.data, providerId) }),
              icon: Settings,
              run: () => navigate("/settings/api-keys", { state: { providerSettings: providerId } }),
            }
          : { label: copy.action, icon: Settings, run: () => navigate("/settings/api-keys") };
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
      data-job-set={jobSet.id}
      className={`${box} @container flex flex-col items-center justify-center bg-danger-soft inset-ring inset-ring-danger-line`}
      style={style}
    >
      <div className="flex w-300 max-w-[calc(100%-24px)] flex-col items-center gap-12">
        <CircleAlert size={20} aria-hidden className="shrink-0 text-danger" />
        <p className="w-full text-center text-small leading-[1.45] text-text-primary">{reason}</p>
        {/* One row, as wide as its buttons: a long label never pushes Details onto a second line while
            the tile has room. On a narrow tile the buttons wrap rather than run off its edges. */}
        <div className="flex w-max max-w-[calc(100cqw-24px)] shrink-0 flex-wrap items-center justify-center gap-6">
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
  // It may have been billed for the call the restart cut off too (§0.4).
  const text = [hint ? t(hint) : null, job.rerunAt ? t("feed.tile.details.hints.rerun") : null]
    .filter(Boolean)
    .join(" ");
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
          {text || t("feed.tile.details.noMessage")}
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
