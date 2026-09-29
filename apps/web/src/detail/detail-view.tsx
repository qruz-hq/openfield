import "./detail.css";
import {
  type Asset,
  type AssetDetailResponse,
  type AssetListItem,
  type LibraryQuery,
  type ModelListItem,
  t,
} from "@openfield/core";
import { type EstimateRequest, estimate } from "@openfield/providers/manifest";
import {
  Button,
  IconButton,
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  Spinner,
} from "@openfield/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Maximize, Minimize, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { useAuthedImage } from "../api/hooks/images";
import { useRecreateJobSet } from "../api/hooks/job-sets";
import {
  useAssetDetail,
  useAssetNeighbours,
  usePurgeAssets,
  useRestoreAssets,
  useSetFavourite,
  useTrashAssets,
} from "../api/hooks/library";
import { modelsQuery } from "../api/hooks/models";
import { useSettings } from "../api/hooks/settings";
import { ApiError, errorMessage } from "../api/raw";
import { tightCost } from "../lib/cost";
import { notify, notifyError } from "../lib/notify";
import { asksForPrice } from "../lib/remote-price";
import {
  copyImage,
  downloadOriginal,
  focusPromptSoon,
  focusVideoPromptSoon,
  reuseSettings,
  reuseVideoSettings,
} from "./actions";
import { type DetailActions, DetailPanel, type RunSpeedInfo } from "./detail-panel";
import {
  BACKDROP_RUNG,
  type FrozenSettings,
  frozenSettings,
  inTrashCaption,
  relativeTime,
  thumbAt,
} from "./format";
import { Media, type MediaHandle } from "./media";
import {
  afterLeaving,
  type Nav,
  navFor,
  type PendingStep,
  resolvePending,
  type Step,
  stepNext,
  stepPrevious,
} from "./stepping";
import { closeDetailView, findDetailTarget, registerDetailCloser, useDetail } from "./use-detail";
import { VideoMedia, type VideoMediaHandle } from "./video-media";

// The detail view (§4.0, design x7y6U): the image large on its blurred copy, the Info panel on the
// right, and Previous and Next through the list it was opened from. It's a modal dialog over the
// whole window, so focus stays inside until it closes, and it follows ?asset=<id>.

export interface DetailViewProps {
  /** The list's loaded images, in the order it shows them. */
  items: readonly AssetListItem[];
  /**
   * What the list shows, for the arrows when the open image isn't in a loaded page (a reload with
   * ?asset=). The Image feed passes { view: "all" }.
   */
  query: LibraryQuery;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** The list's first page hasn't arrived yet. */
  loading?: boolean;
}

/**
 * Mount one per list, beside it. Cards open it with useDetail().open(id) and carry
 * detailTarget(id) on the element that opens it, so closing hands focus back there.
 */
export function DetailView(props: DetailViewProps) {
  const { assetId, show, close } = useDetail();
  return (
    <Modal open={assetId !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {assetId ? <DetailContent {...props} id={assetId} show={show} close={close} /> : null}
    </Modal>
  );
}

const UNDO_MS = 8000;
/** The panel's column: 352 wide, 8 from the window's edge (design x7y6U). */
const PANEL_GUTTER = 360;
/** How far the blurred copy reaches past the media area (1320×1060 at −120,−80). */
const BACKDROP_BLEED_X = 120;
const BACKDROP_BLEED_Y = 80;

type Confirm = "delete" | "purge";

interface ContentProps extends DetailViewProps {
  id: string;
  show: (id: string | null) => void;
  close: () => void;
}

/** The list's own copy of the image, or the one the details carry. */
function listItemOf(asset: Asset): AssetListItem {
  const { deletedAt, ...rest } = asset;
  return deletedAt ? { ...rest, deletedAt } : rest;
}

/** One line for the header: the prompt's first line, else the model's name (§4.0). */
function titleOf(prompt: string, modelName: string | undefined): string {
  const line = prompt.trim().split("\n")[0]?.trim();
  return line || modelName || t("assets.detail.label");
}

function DetailContent({
  id,
  items,
  query,
  hasMore,
  loadingMore,
  onLoadMore,
  loading = false,
  show,
  close,
}: ContentProps) {
  const navigate = useNavigate();
  const content = useRef<HTMLDivElement>(null);
  const mediaBox = useRef<HTMLDivElement>(null);
  const media = useRef<MediaHandle>(null);
  const videoMedia = useRef<VideoMediaHandle>(null);
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, setPending] = useState<PendingStep | null>(null);

  const detail = useAssetDetail(id);
  const models = useQuery({ ...modelsQuery("all"), select: (data) => data.models });
  const settings = useSettings();
  const setFavourite = useSetFavourite();
  const trashAssets = useTrashAssets();
  const restoreAssets = useRestoreAssets();
  const purgeAssets = usePurgeAssets();
  const recreateJobSet = useRecreateJobSet();

  // Images met outside the list (the server's neighbours, a reference) and the list's own copies,
  // so the view keeps showing an image while it leaves the list.
  const seen = useRef(new Map<string, AssetListItem>());
  const listIndex = items.findIndex((item) => item.id === id);
  if (listIndex >= 0) seen.current.set(id, items[listIndex]!);

  // Where it was the last time the list held it, to step on from there if it leaves.
  const [anchor, setAnchor] = useState<{ id: string; index: number } | null>(null);
  if (listIndex >= 0 && (anchor?.id !== id || anchor.index !== listIndex))
    setAnchor({ id, index: listIndex });
  const lastIndex = anchor?.id === id ? anchor.index : -1;

  const outsideList = listIndex < 0 && lastIndex < 0;
  const neighbours = useAssetNeighbours(id, query, { enabled: outsideList && !loading });
  useEffect(() => {
    for (const item of [neighbours.data?.previous, neighbours.data?.next]) {
      if (item) seen.current.set(item.id, item);
    }
  }, [neighbours.data]);

  const nav: Nav = navFor(items, id, hasMore, lastIndex, outsideList ? (neighbours.data ?? null) : null);
  const item =
    items[listIndex] ?? seen.current.get(id) ?? (detail.data ? listItemOf(detail.data.asset) : undefined);

  // Stepping keeps the card in view behind the overlay, so closing lands where the person is.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    findDetailTarget(id)?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [id]);

  useEffect(() => {
    registerDetailCloser(close);
    return () => registerDetailCloser(null);
  }, [close]);

  // A link to an image that's gone (deleted for good) closes rather than showing nothing.
  const gone = detail.error instanceof ApiError && detail.error.status === 404 && !item;
  useEffect(() => {
    if (!gone) return;
    notifyError(t("assets.detail.loadFailed"));
    close();
  }, [gone, close]);

  // A step waiting on the list: the next page, or the removal of the image being left.
  const loadAsked = useRef(false);
  const sawLoading = useRef(false);
  if (pending && loadingMore) sawLoading.current = true;
  useEffect(() => {
    if (!pending) return;
    const outcome = resolvePending(items, pending, hasMore, loadingMore);
    switch (outcome.kind) {
      case "show":
        setPending(null);
        show(outcome.id);
        return;
      case "close":
        setPending(null);
        close();
        return;
      case "stay":
        setPending(null);
        return;
      case "load":
        // Asked once; if the page came back without it (it failed), stop waiting.
        if (!loadAsked.current) {
          loadAsked.current = true;
          onLoadMore();
        } else if (sawLoading.current) setPending(null);
        return;
      case "wait":
        return;
    }
  }, [pending, items, hasMore, loadingMore, onLoadMore, show, close]);

  const startPending = (step: PendingStep) => {
    loadAsked.current = false;
    sawLoading.current = false;
    setPending(step);
  };

  const go = (step: Step | ReturnType<typeof afterLeaving>) => {
    if (step.kind === "show") {
      setPending(null);
      show(step.id);
    } else if (step.kind === "pending") startPending(step.step);
    else if (step.kind === "close") close();
  };

  const nudge = (direction: -1 | 1) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    mediaBox.current?.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${direction * 8}px)` },
        { transform: "translateX(0)" },
      ],
      { duration: 120, easing: "ease-out" },
    );
  };
  const previous = () => {
    const step = stepPrevious(nav);
    if (step.kind === "none") nudge(-1);
    else go(step);
  };
  const next = () => {
    const step = stepNext(nav, id);
    if (step.kind === "none") nudge(1);
    else go(step);
  };

  if (!item) {
    return (
      <Shell contentRef={content} onEscape={() => false}>
        <div className="absolute inset-0 flex items-center justify-center">
          {detail.isError && !gone ? (
            <div className="flex flex-col items-center gap-8">
              <span className="text-small text-text-secondary">{t("assets.detail.loadFailed")}</span>
              <Button variant="ghost" size="s" onClick={() => void detail.refetch()}>
                {t("actions.tryAgain")}
              </Button>
            </div>
          ) : (
            <Spinner size={18} label={t("app.loading")} className="text-text-tertiary" />
          )}
        </div>
        <ModalClose asChild>
          <IconButton
            variant="round"
            size={30}
            icon={X}
            label={t("assets.detail.close")}
            className="absolute top-20 right-20"
          />
        </ModalClose>
      </Shell>
    );
  }

  const isVideo = item.modality === "video";
  const data: AssetDetailResponse | undefined = detail.data?.asset.id === id ? detail.data : undefined;
  const frozen: FrozenSettings = frozenSettings(data?.asset.params ?? data?.params);
  const jobSet = data?.jobSet ?? null;
  const allModels = models.data;
  const model: ModelListItem | undefined =
    item.providerId && item.modelId
      ? allModels?.find((m) => m.providerId === item.providerId && m.modelId === item.modelId)
      : undefined;
  const prompt = jobSet?.promptOriginal ?? data?.asset.prompt ?? item.prompt;
  const title = titleOf(prompt, model?.displayName ?? item.modelId ?? undefined);
  const deletedAt = item.deletedAt ?? data?.asset.deletedAt ?? null;
  const trashed = query.view === "trash" || deletedAt !== null;
  const caption = trashed && deletedAt ? inTrashCaption(deletedAt) : relativeTime(item.createdAt);
  const favourite = data?.isFavourite ?? item.isFavourite;
  const canReplay = item.jobSetId !== null;
  const speed: RunSpeedInfo | null = jobSet
    ? { speed: frozen.speed ?? jobSet.speed, requested: frozen.speedRequested }
    : null;

  // Recreate replays the whole run at its frozen speed, so that's what the estimate prices (§0.13).
  let recreatePrice: string | undefined;
  if (model && jobSet) {
    const request: EstimateRequest = {
      batch: jobSet.batchSize,
      op: jobSet.op,
      speed: speed?.speed ?? jobSet.speed,
    };
    if (frozen.resolution) request.resolution = frozen.resolution;
    if (frozen.quality) request.quality = frozen.quality;
    if (frozen.size) request.size = frozen.size;
    if (frozen.prompt !== undefined) request.prompt = frozen.prompt;
    if (frozen.video) request.video = frozen.video;
    // A model its company prices per request replays at the price its run was sent at, as the
    // server prices the replay.
    recreatePrice = asksForPrice(model)
      ? jobSet.costEstimateUsd === null
        ? undefined
        : tightCost({
            ...estimate(model, request),
            confidence: "estimated",
            min: jobSet.costEstimateUsd,
            max: jobSet.costEstimateUsd,
          })
      : tightCost(estimate(model, request));
  }
  const recreateInexact = !model?.capabilities.seed.supported || data?.asset.seed === null;
  // The Details panel's Cost row: a video's own row (§0.16). An image's panel doesn't have one yet.
  const knownCost = jobSet?.costActualUsd ?? jobSet?.costEstimateUsd ?? null;
  const detailCost =
    !isVideo || knownCost === null
      ? undefined
      : tightCost({
          currency: "usd",
          min: knownCost,
          max: knownCost,
          confidence: jobSet?.costActualUsd !== null ? "exact" : "estimated",
          basis: "",
          pricedAt: "",
        });

  // Through the registered closer: Recreate's Show can be clicked after this view has moved on.
  const workspacePath = isVideo ? "/video" : "/image";
  const toWorkspace = () => {
    closeDetailView();
    if (!window.location.pathname.startsWith(workspacePath)) navigate(workspacePath);
  };

  const leave = () => go(afterLeaving(nav, id));

  const runDelete = () => {
    const ids = [id];
    leave();
    // mutateAsync, not mutate callbacks: the view can close before the answer, and those drop.
    trashAssets.mutateAsync({ ids }).then(
      ({ changed }) =>
        notify(t("feed.delete.done", { count: changed.length }), {
          duration: UNDO_MS,
          action: { label: t("actions.undo"), onClick: () => restoreAssets.mutate({ ids: changed }) },
        }),
      () => setPending(null),
    );
  };

  const runPurge = () => {
    const ids = [id];
    leave();
    purgeAssets.mutateAsync({ ids }).then(
      ({ changed }) =>
        notify(t("assets.toast.deletedForGood", { count: changed.length }), { tone: "success" }),
      () => setPending(null),
    );
  };

  const actions: DetailActions = {
    recreatePrice,
    recreateInexact,
    canReplay,
    recreating: recreateJobSet.isPending && recreateJobSet.variables === item.jobSetId,
    favourite,
    restoring: restoreAssets.isPending && (restoreAssets.variables?.ids.includes(id) ?? false),
    onRecreate: () => {
      if (!item.jobSetId) return;
      recreateJobSet.mutateAsync(item.jobSetId).then(
        (set) =>
          notify(
            t(isVideo ? "assets.toast.recreatingVideo" : "assets.toast.recreating", {
              count: set.jobs.length,
            }),
            {
              action: { label: t("actions.show"), onClick: toWorkspace },
            },
          ),
        (error: unknown) => notifyError(errorMessage(error)),
      );
    },
    onReuse: () => {
      if (!canReplay) return;
      if (isVideo) reuseVideoSettings({ ...frozen, prompt });
      else reuseSettings({ ...frozen, prompt });
      toWorkspace();
      if (isVideo) focusVideoPromptSoon();
      else focusPromptSoon();
    },
    // Videos can't go on the clipboard the way an image can; the button stays off for them.
    onCopyImage: isVideo
      ? undefined
      : () =>
          void copyImage(item).then(
            () => notify(t("toast.copied"), { tone: "success" }),
            () => notifyError(t("assets.detail.copyFailed")),
          ),
    onDownload: () => void downloadOriginal(item).catch((error: unknown) => notifyError(errorMessage(error))),
    onFavourite: () => setFavourite.mutate({ ids: [id], on: !favourite }),
    onDelete: () => setConfirm("delete"),
    onRestore: () => {
      const ids = [id];
      leave();
      restoreAssets.mutateAsync({ ids }).then(
        ({ changed }) => notify(t("assets.toast.restored", { count: changed.length }), { tone: "success" }),
        () => setPending(null),
      );
    },
    onDeleteForGood: () => setConfirm("purge"),
  };

  // The keys that exist because the view does (§4.0). Keys typed into a field, a menu or the
  // picker belong to them; those live outside this element or are editable.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || !content.current?.contains(target)) return;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let handled = true;
    switch (key) {
      case "ArrowLeft":
        previous();
        break;
      case "ArrowRight":
        next();
        break;
      case "f":
        if (event.shiftKey) setExpanded((e) => !e);
        else if (!trashed) actions.onFavourite();
        break;
      case "d":
        actions.onDownload();
        break;
      case "r":
        if (!trashed && canReplay) actions.onRecreate();
        break;
      case "Delete":
      case "Backspace":
        setConfirm(trashed ? "purge" : "delete");
        break;
      case "+":
      case "=":
        media.current?.zoomIn();
        break;
      case "-":
      case "_":
        media.current?.zoomOut();
        break;
      case "0":
        media.current?.fit();
        break;
      case " ":
        if (isVideo) videoMedia.current?.togglePlay();
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <Shell
      contentRef={content}
      isVideo={isVideo}
      onKeyDown={onKeyDown}
      // Esc leaves the expanded image first, then the view (§4.5).
      onEscape={() => {
        if (!expanded) return false;
        setExpanded(false);
        return true;
      }}
      returnFocusTo={id}
    >
      <Backdrop item={item} expanded={expanded} />
      {/* The media area: the window left of the panel, or all of it when expanded. */}
      <div className="absolute inset-y-0 left-0" style={{ right: expanded ? 0 : PANEL_GUTTER }}>
        <div ref={mediaBox} className="absolute inset-0">
          {isVideo ? (
            <VideoMedia key={item.id} ref={videoMedia} item={item} expanded={expanded} label={title} />
          ) : (
            <Media
              key={item.id}
              ref={media}
              item={item}
              expanded={expanded}
              label={title}
              onZoomedChange={setZoomed}
            />
          )}
        </div>
        {!expanded && nav.previous ? (
          <IconButton
            variant="overlay"
            size={38}
            icon={ChevronLeft}
            label={isVideo ? t("assets.detail.previousVideo") : t("assets.detail.previous")}
            onClick={previous}
            className="absolute top-1/2 left-16 -translate-y-1/2"
          />
        ) : null}
        {!expanded && (nav.next || nav.nextUnloaded) ? (
          <IconButton
            variant="overlay"
            size={38}
            icon={ChevronRight}
            label={isVideo ? t("assets.detail.nextVideo") : t("assets.detail.next")}
            onClick={next}
            className="absolute top-1/2 right-16 -translate-y-1/2"
          />
        ) : null}
        {/* Detail / Media chrome (design Rsrfa): Zoom (images only) and Expand. */}
        <div className="absolute right-38 bottom-20 flex items-center gap-6">
          {isVideo ? null : (
            <IconButton
              variant="overlay"
              size={32}
              icon={zoomed ? ZoomOut : ZoomIn}
              label={zoomed ? t("assets.detail.zoomReset") : t("assets.detail.zoomIn")}
              onClick={() => media.current?.toggle()}
            />
          )}
          <IconButton
            variant="overlay"
            size={32}
            icon={expanded ? Minimize : Maximize}
            label={expanded ? t("assets.detail.showDetails") : t("assets.detail.expand")}
            onClick={() => setExpanded((e) => !e)}
          />
        </div>
      </div>
      <DetailPanel
        id={id}
        asset={data?.asset ?? item}
        title={title}
        caption={caption}
        prompt={prompt}
        references={data?.references}
        folders={data?.folders}
        speed={speed}
        models={allModels}
        video={frozen.video}
        cost={detailCost}
        trashed={trashed}
        loadFailed={detail.isError && !data}
        onRetry={() => void detail.refetch()}
        onOpenReference={(ref) => {
          seen.current.set(ref.id, listItemOf(ref));
          setPending(null);
          show(ref.id);
        }}
        actions={actions}
        hidden={expanded}
      />
      {expanded ? (
        // The one way out that stays on screen while the image fills the window.
        <ModalClose asChild>
          <IconButton
            variant="overlay"
            size={38}
            icon={X}
            label={t("assets.detail.close")}
            className="absolute top-16 right-16"
          />
        </ModalClose>
      ) : null}
      <ConfirmDialog
        kind={confirm}
        retention={settings.data?.trashRetentionDays ?? null}
        onClose={() => setConfirm(null)}
        onConfirm={(kind) => {
          setConfirm(null);
          if (kind === "delete") runDelete();
          else runPurge();
        }}
      />
    </Shell>
  );
}

/**
 * The dialog itself: Modal / Shell stretched over the whole window, its title row kept only for
 * screen readers. A click outside never closes it: a toast's Undo is outside, and panning a zoomed
 * image must never lose it (§4.0).
 */
function Shell({
  contentRef,
  isVideo = false,
  onKeyDown,
  onEscape,
  returnFocusTo,
  children,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  /** Unknown while the item is still loading; the generic title covers that. */
  isVideo?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** True when Esc was used up inside (leaving the expanded image). */
  onEscape: () => boolean;
  /** The image whose card takes focus on close. */
  returnFocusTo?: string;
  children: ReactNode;
}) {
  return (
    <ModalContent
      ref={contentRef}
      title={
        <span className="sr-only">{isVideo ? t("assets.detail.labelVideo") : t("assets.detail.label")}</span>
      }
      headerClassName="pointer-events-none absolute"
      aria-describedby={undefined}
      onKeyDown={onKeyDown}
      onOpenAutoFocus={(event) => {
        // The view itself takes focus, so the arrow keys work at once.
        event.preventDefault();
        contentRef.current?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={(event) => {
        const card = returnFocusTo ? findDetailTarget(returnFocusTo) : null;
        if (!card) return;
        event.preventDefault();
        card.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={(event) => {
        if (onEscape()) event.preventDefault();
      }}
      onInteractOutside={(event) => event.preventDefault()}
      className="inset-0 h-dvh max-h-none w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none bg-surface p-0 shadow-none inset-ring-0 data-[state=open]:animate-none"
    >
      {children}
    </ModalContent>
  );
}

/** The image's 360 rung past the media area's edges, blurred 40 at 22% over the surface. */
function Backdrop({ item, expanded }: { item: AssetListItem; expanded: boolean }) {
  const image = useAuthedImage(thumbAt(item, { h: BACKDROP_RUNG }));
  if (image.status !== "ready") return null;
  const areaWidth = expanded ? "100%" : `(100% - ${PANEL_GUTTER}px)`;
  return (
    <img
      src={image.src}
      alt=""
      aria-hidden
      draggable={false}
      className="pointer-events-none absolute max-w-none object-cover opacity-22 blur-[40px]"
      style={{
        left: -BACKDROP_BLEED_X,
        top: -BACKDROP_BLEED_Y,
        width: `calc(${areaWidth} + ${BACKDROP_BLEED_X * 2}px)`,
        height: `calc(100% + ${BACKDROP_BLEED_Y * 2}px)`,
      }}
    />
  );
}

/** Delete (to the Trash) and Delete for good, asked on the library's Modal / Shell. */
function ConfirmDialog({
  kind,
  retention,
  onClose,
  onConfirm,
}: {
  kind: Confirm | null;
  retention: number | null;
  onClose: () => void;
  onConfirm: (kind: Confirm) => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  // The last one stays on screen while the dialog animates out.
  const [shown, setShown] = useState<Confirm | null>(null);
  if (kind && kind !== shown) setShown(kind);
  const current = kind ?? shown;
  const copy =
    current === "purge"
      ? {
          title: t("assets.dialogs.deleteForGood.title", { count: 1 }),
          body: t("assets.dialogs.deleteForGood.body", { count: 1 }),
          confirm: t("assets.dialogs.deleteForGood.confirm"),
        }
      : {
          title: t("feed.delete.title", { count: 1 }),
          body:
            retention === null
              ? t("feed.delete.body", { count: 1 })
              : t("feed.delete.bodyDays", { count: 1, days: retention }),
          confirm: t("feed.delete.confirm"),
        };

  const onOpenChange = useCallback((open: boolean) => (open ? undefined : onClose()), [onClose]);

  return (
    <Modal open={kind !== null} onOpenChange={onOpenChange}>
      {current ? (
        <ModalContent
          alert
          title={copy.title}
          closeLabel={t("actions.close")}
          // A destructive confirm starts on the safe choice.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <ModalDescription>{copy.body}</ModalDescription>
          <ModalFooter>
            <ModalClose asChild>
              <Button ref={cancel} variant="secondary" size="m">
                {t("actions.cancel")}
              </Button>
            </ModalClose>
            <Button variant="danger" size="m" onClick={() => onConfirm(current)}>
              {copy.confirm}
            </Button>
          </ModalFooter>
        </ModalContent>
      ) : null}
    </Modal>
  );
}
