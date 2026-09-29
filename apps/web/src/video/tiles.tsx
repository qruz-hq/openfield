import {
  ASPECT_RATIOS,
  type AssetListItem,
  type ErrorCode,
  errorCopy,
  formatDate,
  type Job,
  type JobSet,
  type JobSetWithJobs,
  type ModelListItem,
  t,
} from "@openfield/core";
import { nearestRatio } from "@openfield/providers/manifest";
import { Button, IconButton, ModelCaption, TileCancelPill, TileStatusPill } from "@openfield/ui";
import {
  ArrowUpRight,
  CircleAlert,
  Download,
  FolderPlus,
  Heart,
  KeyRound,
  type LucideIcon,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuthedImage } from "../api/hooks/images";
import { useCancelJob, useRecreateJobSet, useRetryJobSet } from "../api/hooks/job-sets";
import { useProviders } from "../api/hooks/keys";
import { useSetFavourite } from "../api/hooks/library";
import { useAuthedVideo } from "../api/hooks/videos";
import { ApiError, errorMessage } from "../api/raw";
import { AddToFolderPopover } from "../assets/add-to-folder";
import { detailTarget, useIsLastViewed, useOpenDetail } from "../detail";
import { downloadOriginal } from "../detail/actions";
import { endedWithoutImage, failedAction, jobTileState, type WaitKind, waitKind } from "../image/feed-items";
import { type JobTileProps, WaitingTile } from "../image/tiles";
import { useDismissed, useLive } from "../lib/live";
import { notify, notifyError } from "../lib/notify";
import { companyName, logoFor, providerOfKey } from "../lib/provider";
import { useVideoReuse } from "./composer/use-reuse";

// Feed / Tile / Video / {Idle, Hover, Generating, Failed} (design ciWh7, W8cP0r): the poster at
// rest, the video itself only once hovered or focused. Waiting-at-provider is unreachable today
// (BytePlus has no Batch or Flex speed), so it borrows the image feed's tile unchanged.

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

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** Pill / Tile / Duration (design F1pmM0): overlay fill, 8px blur, bottom-right 10,10. */
function DurationPill({ seconds, total, playing }: { seconds: number; total?: number; playing: boolean }) {
  const Icon = playing ? Pause : Play;
  const label = total !== undefined ? `${clock(seconds)} / ${clock(total)}` : clock(seconds);
  return (
    <span className="pointer-events-none absolute right-10 bottom-10 inline-flex h-22 items-center gap-4 rounded-full bg-overlay px-8 inset-ring inset-ring-overlay-line backdrop-blur-chip">
      <Icon size={10} aria-hidden className="shrink-0 fill-current text-overlay-fg" />
      <span className="text-mono-11 text-overlay-fg">{label}</span>
    </span>
  );
}

export function VideoAssetTile({
  asset,
  rung,
  model,
  style,
}: TileBox & { asset: AssetListItem; rung: number; model?: string }) {
  const [hovered, setHovered] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState({ current: 0, total: (asset.durationMs ?? 0) / 1000 });
  const [filing, setFiling] = useState(false);
  const poster = useAuthedImage(thumbPath(asset, rung));
  const clip = useAuthedVideo(hovered ? asset.fileUrl : null);
  const openDetail = useOpenDetail();
  const lastViewed = useIsLastViewed(asset.id);
  const setFavourite = useSetFavourite();
  const recreate = useRecreateJobSet();
  const logo = logoFor(asset.providerId ?? undefined);
  const seconds = asset.durationMs ? asset.durationMs / 1000 : null;

  const label = t("feed.tile.label", {
    prompt: asset.prompt.trim() ? truncate(asset.prompt, 80) : t("feed.tile.noPrompt"),
    model: model ?? asset.modelId ?? "",
    date: formatDate(asset.createdAt),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the clock whenever the pointer leaves
  useEffect(() => {
    if (!hovered) setProgress({ current: 0, total: seconds ?? 0 });
  }, [hovered]);

  return (
    <li
      aria-label={label}
      data-job-set={asset.jobSetId ?? undefined}
      className={`${box} bg-elevated`}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false);
      }}
    >
      {poster.status === "ready" ? (
        <img
          src={poster.src}
          alt=""
          className="absolute inset-0 size-full object-cover"
          decoding="async"
          draggable={false}
        />
      ) : null}
      {hovered && clip.status === "ready" ? (
        <video
          src={clip.src}
          autoPlay
          loop
          muted={muted}
          playsInline
          className="absolute inset-0 size-full object-cover"
          onTimeUpdate={(event) =>
            setProgress({
              current: event.currentTarget.currentTime,
              total: event.currentTarget.duration || seconds || 0,
            })
          }
        />
      ) : null}
      {hovered ? <span aria-hidden className="pointer-events-none absolute inset-0 bg-scrim" /> : null}
      {lastViewed ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 inset-ring inset-ring-border-strong"
        />
      ) : null}
      {hovered ? (
        <>
          <IconButton
            variant="overlay"
            size={32}
            icon={muted ? VolumeX : Volume2}
            label={muted ? t("video.chips.sound.off") : t("video.chips.sound.on")}
            onClick={(event) => {
              event.stopPropagation();
              setMuted((m) => !m);
            }}
            className="absolute top-10 left-10"
          />
          <div className="absolute top-10 right-10 flex flex-col gap-4">
            <IconButton
              variant="overlay"
              size={38}
              icon={Heart}
              label={asset.isFavourite ? t("assets.card.unfavorite") : t("assets.card.favorite")}
              aria-pressed={asset.isFavourite}
              className={asset.isFavourite ? "text-accent [&>svg]:fill-current" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setFavourite.mutate({ ids: [asset.id], on: !asset.isFavourite });
              }}
            />
            <IconButton
              variant="overlay"
              size={38}
              icon={Download}
              label={t("assets.card.download")}
              onClick={(event) => {
                event.stopPropagation();
                void downloadOriginal(asset).catch((error: unknown) => notifyError(errorMessage(error)));
              }}
            />
            {asset.jobSetId ? (
              <IconButton
                variant="overlay"
                size={38}
                icon={RefreshCw}
                label={t("feed.tile.menu.recreate")}
                onClick={(event) => {
                  event.stopPropagation();
                  const jobSetId = asset.jobSetId!;
                  recreate.mutateAsync(jobSetId).then(
                    (set: JobSetWithJobs) => notify(t("assets.toast.recreating", { count: set.jobs.length })),
                    (error: unknown) => notifyError(errorMessage(error)),
                  );
                }}
              />
            ) : null}
            <AddToFolderPopover ids={[asset.id]} open={filing} onOpenChange={setFiling}>
              <IconButton
                variant="overlay"
                size={38}
                icon={FolderPlus}
                label={t("assets.detail.addToFolder")}
                onClick={(event) => event.stopPropagation()}
              />
            </AddToFolderPopover>
          </div>
          <div className="pointer-events-none absolute bottom-10 left-10 flex max-w-[calc(100%-96px)] items-center gap-6">
            {logo ? (
              <ModelCaption provider={logo} name={model ?? asset.modelId ?? ""} />
            ) : (
              <span className="truncate text-micro font-medium text-overlay-fg">
                {model ?? asset.modelId}
              </span>
            )}
          </div>
          <div className="absolute inset-x-0 bottom-0 h-3 bg-white/15">
            <div
              className="h-full bg-accent"
              style={{
                width:
                  progress.total > 0 ? `${Math.min(100, (progress.current / progress.total) * 100)}%` : "0%",
              }}
            />
          </div>
          <DurationPill
            seconds={progress.current}
            total={progress.total || undefined}
            playing={clip.status === "ready"}
          />
        </>
      ) : seconds !== null ? (
        <DurationPill seconds={seconds} playing={false} />
      ) : null}
      <button
        type="button"
        aria-label={label}
        {...detailTarget(asset.id)}
        onClick={() => openDetail(asset.id)}
        className="absolute inset-0 cursor-pointer focus-visible:-outline-offset-2"
      />
    </li>
  );
}

// Working / Failed tiles for a video run: the image feed's generic states (queued, failed) look
// the same for any modality, but the "generating" state has its own words ("Videos take a minute
// or two.") and no partial image, so it gets its own tile.

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function useElapsed(since: string | null, active: boolean): number {
  const now = useNow(active);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
}

/** "Seedance 2.0 Fast · 16:9", from the model's name and the job's reserved shape. */
function summaryOf(jobSet: JobSet, job: Job, model: ModelListItem | undefined): string {
  const name = model?.displayName ?? jobSet.model;
  const aspect = nearestRatio(job.width, job.height, ASPECT_RATIOS) ?? "1:1";
  return `${name} · ${aspect}`;
}

export function VideoJobTile(props: JobTileProps) {
  const position = useLive((s) => s.positions[props.job.id]);
  const retry = useLive((s) => s.retries[props.job.id]);
  const state = jobTileState(props.job, position, props.jobSet);
  if (state === "failed") return <VideoFailedTile {...props} />;
  const wait = waitKind(props.jobSet, props.job, retry, props.batch);
  if (wait)
    return <WaitingTile {...props} kind={wait as WaitKind} retryAt={retry?.at ?? props.job.nextAttemptAt} />;
  return <VideoWorkingTile {...props} queued={state === "queued"} position={position} />;
}

function VideoWorkingTile({
  jobSet,
  job,
  model,
  style,
  queued,
  position,
}: JobTileProps & { queued: boolean; position?: number }) {
  const cancel = useCancelJob();
  const elapsed = useElapsed(job.startedAt ?? jobSet.createdAt, !queued);
  const providerId = model?.providerId ?? providerOfKey(jobSet.model) ?? "";
  const logo = logoFor(providerId);
  const summary = summaryOf(jobSet, job, model);

  const onCancel = () =>
    void cancel.mutateAsync(job.id).then(
      () => notify(t("toast.canceled")),
      (error: unknown) => notifyError(errorMessage(error)),
    );

  return (
    <li
      aria-busy="true"
      aria-label={[summary, queued ? t("feed.tile.queued") : t("video.generating")].join(". ")}
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
      <div className="absolute bottom-21 left-12 flex flex-col gap-4">
        {logo ? (
          <ModelCaption provider={logo} name={<span className="text-text-tertiary">{summary}</span>} />
        ) : (
          <span className="text-micro text-text-tertiary">{summary}</span>
        )}
        <span className="text-micro text-text-secondary">
          {t("video.generating")}
          {!queued && elapsed >= 10 ? (
            <span className="text-mono-11 text-text-tertiary">{` ${clock(elapsed)}`}</span>
          ) : null}
        </span>
      </div>
      {queued ? null : (
        // Videos report no progress percentage; the indeterminate sweep says work is happening.
        <div className="absolute inset-x-0 bottom-0 h-2 bg-border">
          <div className="h-full w-1/3 bg-text-primary motion-safe:animate-progress-indeterminate" />
        </div>
      )}
    </li>
  );
}

type Fix = { label: string; icon: LucideIcon; run: () => void; pending?: boolean };

function VideoFailedTile({ jobSet, job, jobs, style }: JobTileProps) {
  const navigate = useNavigate();
  const retry = useRetryJobSet();
  const dismiss = useDismissed((s) => s.dismiss);
  const reuse = useVideoReuse();
  const providers = useProviders();

  const code: ErrorCode = job.status === "canceled" ? "canceled" : (job.errorCode ?? "unknown");
  const copy = errorCopy(code);
  const reason = job.status === "interrupted" ? t("feed.tile.interrupted") : (job.errorReason ?? copy.reason);
  const action = failedAction(job, code);
  const providerId = providerOfKey(jobSet.model) ?? "";
  const clearRun = () => dismiss(endedWithoutImage(jobs).map((j) => j.id));

  const tryAgain: Fix = {
    label: t("actions.tryAgain"),
    icon: RefreshCw,
    pending: retry.isPending,
    run: () =>
      void retry
        .mutateAsync(jobSet.id)
        .then(clearRun, (error: unknown) =>
          error instanceof ApiError && error.status === 409 ? clearRun() : notifyError(errorMessage(error)),
        ),
  };
  const consoleUrl = providers.data?.find((p) => p.id === providerId)?.meta.consoleUrl;

  const primary: Fix | null = (() => {
    switch (action) {
      case "open-settings":
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
      case "try-again":
        return tryAgain;
      default:
        return null;
    }
  })();

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
            variant="ghost"
            size="s"
            icon={RefreshCw}
            onClick={() => reuse({ prompt: jobSet.prompt, model: jobSet.model })}
          >
            {t("actions.reuse")}
          </Button>
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
