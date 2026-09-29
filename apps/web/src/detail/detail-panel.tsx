import {
  type Asset,
  type AssetListItem,
  assetThumbUrl,
  compareFolders,
  type Folder,
  formatDateTime,
  libraryHref,
  type ModelListItem,
  type SpeedId,
  t,
  type VideoRequest,
} from "@openfield/core";
import {
  Button,
  cn,
  IconButton,
  KeyValueList,
  KeyValueRow,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  MiniChip,
  ModalClose,
  ProviderLogo,
  SectionLabel,
  Surface,
  Tooltip,
} from "@openfield/ui";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Folder as FolderIcon,
  FolderInput,
  Heart,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuthedImage } from "../api/hooks/images";
import { useSpeedName } from "../api/hooks/provider-settings";
import { AddToFolderPopover } from "../assets/add-to-folder";
import { logoFor } from "../lib/provider";

// Detail / Panel / Assets and / Trash (design sb8P2, JSKpv): header, PROMPT, DETAILS, a spacer,
// then the footer at the bottom. No tabs until Edit and History ship (§4.0).

export interface DetailActions {
  /** Recreate's estimate, "~$0.04", when the price is known. */
  recreatePrice?: string | undefined;
  /** The model can't repeat an image exactly, so Recreate's tooltip says results change. */
  recreateInexact: boolean;
  /** Recreate and Reuse need the run that made it; uploads have none. */
  canReplay: boolean;
  recreating: boolean;
  favourite: boolean;
  restoring: boolean;
  onRecreate: () => void;
  onReuse: () => void;
  /** Left out for a video: it can't go on the clipboard the way an image can. */
  onCopyImage?: () => void;
  onDownload: () => void;
  onFavourite: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteForGood: () => void;
}

/** The Speed row's inputs: the speed it ran at and the one the company's settings asked for. */
export interface RunSpeedInfo {
  speed: SpeedId;
  requested?: SpeedId | undefined;
}

interface DetailPanelProps {
  id: string;
  /** What the Details rows read. The list's copy until the details arrive. */
  asset: Pick<AssetListItem, "providerId" | "modelId" | "width" | "height" | "createdAt">;
  title: string;
  caption: string;
  /** The prompt as written. */
  prompt: string;
  /** Undefined until the details load. */
  references: readonly Asset[] | undefined;
  folders: readonly Folder[] | undefined;
  /** Null when it wasn't made by a run here, or the details haven't loaded. */
  speed: RunSpeedInfo | null;
  models: readonly ModelListItem[] | undefined;
  /** A video's own settings, for its Length row. Undefined for an image. */
  video?: VideoRequest | undefined;
  /** "$0.58", the run's cost, for a video's Cost row. */
  cost?: string | undefined;
  trashed: boolean;
  /** The details couldn't load; the header and prompt still show from the list. */
  loadFailed: boolean;
  onRetry: () => void;
  onOpenReference: (asset: Asset) => void;
  actions: DetailActions;
  /** Out of sight while the image is expanded, keeping its state for when it comes back. */
  hidden?: boolean;
}

export function DetailPanel({
  id,
  asset,
  title,
  caption,
  prompt,
  references,
  folders,
  speed,
  models,
  video,
  cost,
  trashed,
  loadFailed,
  onRetry,
  onOpenReference,
  actions,
  hidden = false,
}: DetailPanelProps) {
  return (
    <Surface variant="panel" hidden={hidden} className="absolute top-8 right-8 bottom-8">
      {/* Detail / Panel header */}
      <div className="flex w-full shrink-0 items-center justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="truncate text-body-strong text-text-primary">{title}</span>
          <span className="truncate text-caption text-text-tertiary">{caption}</span>
        </div>
        <ModalClose asChild>
          <IconButton variant="round" size={30} icon={X} label={t("assets.detail.close")} />
        </ModalClose>
      </div>
      {/* The blocks scroll when an open prompt is long, so the footer stays put. */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-12 overflow-y-auto">
        <PromptSection
          key={id}
          prompt={prompt}
          references={references ?? []}
          onOpenReference={onOpenReference}
        />
        <DetailsSection
          asset={asset}
          folders={folders}
          speed={speed}
          models={models}
          video={video}
          cost={cost}
        />
        {loadFailed ? (
          <div className="flex w-full items-center justify-between gap-8 px-12">
            <span className="text-small text-text-secondary">{t("assets.detail.loadFailed")}</span>
            <Button variant="ghost" size="s" onClick={onRetry}>
              {t("actions.tryAgain")}
            </Button>
          </div>
        ) : null}
      </div>
      {trashed ? <TrashActions actions={actions} /> : <LibraryActions id={id} actions={actions} />}
    </Surface>
  );
}

// PROMPT (design O0zG8)

const COPIED_MS = 1200;

function PromptSection({
  prompt,
  references,
  onOpenReference,
}: {
  prompt: string;
  references: readonly Asset[];
  onOpenReference: (asset: Asset) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  const hasPrompt = prompt.trim().length > 0;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // See all shows only when six lines don't hold the prompt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the prompt changes.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [prompt, open]);

  const copy = () =>
    void navigator.clipboard.writeText(prompt).then(
      () => setCopied(true),
      () => undefined,
    );

  return (
    <Surface variant="block" className="w-full shrink-0">
      <div className="flex w-full items-center justify-between">
        <SectionLabel>{t("assets.detail.prompt")}</SectionLabel>
        {hasPrompt ? (
          <MiniChip
            icon={Copy}
            label={copied ? t("assets.detail.copied") : t("assets.detail.copy")}
            onClick={copy}
          />
        ) : null}
      </div>
      {references.length ? (
        // One row, as in the design; more than fit scroll sideways (§4.3).
        <div className="flex w-full gap-6 overflow-x-auto">
          {references.map((ref, index) => (
            <ReferenceThumb
              key={ref.id}
              asset={ref}
              primary={index === 0}
              label={t("assets.detail.reference", { index: index + 1 })}
              onOpen={() => onOpenReference(ref)}
            />
          ))}
        </div>
      ) : null}
      <p
        ref={text}
        className={cn(
          "w-full whitespace-pre-wrap break-words text-small leading-[1.45]",
          hasPrompt ? "text-text-primary" : "text-text-tertiary",
          !open && "line-clamp-6",
        )}
      >
        {hasPrompt ? prompt : t("assets.detail.noPrompt")}
      </p>
      {clamped || open ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex w-fit cursor-pointer items-center gap-4 text-caption font-medium text-text-secondary hover:text-text-primary"
        >
          {open ? t("assets.detail.hide") : t("assets.detail.seeAll")}
          {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        </button>
      ) : null}
    </Surface>
  );
}

/** Detail / Reference thumb / Primary and / Default: 54px, radius 8, the first ringed in accent. */
function ReferenceThumb({
  asset,
  primary,
  label,
  onOpen,
}: {
  asset: Asset;
  primary: boolean;
  label: string;
  onOpen: () => void;
}) {
  const image = useAuthedImage(assetThumbUrl(asset.id, { h: 200 }));
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      className="relative size-54 shrink-0 cursor-pointer overflow-hidden rounded-8 bg-elevated-2"
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" draggable={false} className="size-full object-cover" />
      ) : null}
      {/* The stroke sits inside, over the image, as in the design. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-8 inset-ring",
          primary ? "inset-ring-2 inset-ring-accent" : "inset-ring-border",
        )}
      />
    </button>
  );
}

// DETAILS (design f4Nwvf)

function DetailsSection({
  asset,
  folders,
  speed,
  models,
  video,
  cost,
}: {
  asset: DetailPanelProps["asset"];
  folders: readonly Folder[] | undefined;
  speed: RunSpeedInfo | null;
  models: readonly ModelListItem[] | undefined;
  video?: VideoRequest | undefined;
  cost?: string | undefined;
}) {
  const speedName = useSpeedName();
  const providerId = asset.providerId;
  const model =
    providerId && asset.modelId
      ? models?.find((m) => m.providerId === providerId && m.modelId === asset.modelId)
      : undefined;
  const logo = logoFor(providerId ?? undefined);
  const modelName = model?.displayName ?? asset.modelId;

  let speedValue: string | null = null;
  if (speed && providerId && providerId !== "local") {
    const name = speedName(providerId, speed.speed);
    // It asked for a speed this model doesn't have, so it ran at Standard (§4.3), in the
    // composer's words.
    speedValue =
      speed.requested && speed.requested !== speed.speed
        ? t("speed.standardForModel", { speed: name })
        : name;
  }

  return (
    <Surface variant="block" className="w-full shrink-0">
      <SectionLabel>{t("assets.detail.details")}</SectionLabel>
      <KeyValueList>
        {modelName ? (
          <KeyValueRow
            label={t("assets.detail.model")}
            value={modelName}
            glyph={logo ? <ProviderLogo provider={logo} /> : undefined}
          />
        ) : null}
        {speedValue ? <KeyValueRow label={t("assets.detail.speed")} value={speedValue} /> : null}
        {video?.seconds !== undefined ? (
          <KeyValueRow
            label={t("assets.detail.length")}
            value={
              video.audio
                ? t("assets.detail.lengthWithSound", { seconds: video.seconds })
                : t("video.duration", { seconds: video.seconds })
            }
          />
        ) : null}
        <KeyValueRow
          label={t("assets.detail.size")}
          value={
            video?.resolution
              ? t("assets.detail.sizeValueVideo", {
                  width: asset.width,
                  height: asset.height,
                  resolution: video.resolution,
                })
              : t("assets.detail.sizeValue", { width: asset.width, height: asset.height })
          }
          mono
        />
        {cost ? <KeyValueRow label={t("assets.detail.cost")} value={cost} mono /> : null}
        <KeyValueRow label={t("assets.detail.created")} value={formatDateTime(asset.createdAt)} />
        {folders ? <FoldersRow folders={folders} /> : null}
      </KeyValueList>
    </Surface>
  );
}

const SHOWN_FOLDERS = 2;

/** A chip per folder, which opens it; past two, "+N" lists the rest; none reads "None" (§4.0). */
function FoldersRow({ folders }: { folders: readonly Folder[] }) {
  const navigate = useNavigate();
  const sorted = [...folders].sort(compareFolders);
  const shown = sorted.slice(0, SHOWN_FOLDERS);
  const rest = sorted.slice(SHOWN_FOLDERS);
  const openFolder = (id: string) => navigate(libraryHref({ view: "folder", folderId: id }));
  return (
    // Row / Key value, with the chips (value frame gap 4) in place of the text.
    <div className="flex w-full items-center justify-between gap-8">
      <dt className="shrink-0 text-small text-text-secondary">{t("assets.detail.folders")}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-4">
        {sorted.length === 0 ? (
          <span className="text-small text-text-primary">{t("assets.detail.noFolders")}</span>
        ) : null}
        {shown.map((folder) => (
          <FolderChip key={folder.id} name={folder.name} onClick={() => openFolder(folder.id)} />
        ))}
        {rest.length ? (
          <Menu>
            <MenuTrigger asChild>
              <MiniChip
                label={t("assets.detail.moreFolders", { count: rest.length })}
                aria-label={t("assets.detail.otherFolders")}
              />
            </MenuTrigger>
            <MenuContent align="end">
              {rest.map((folder) => (
                <MenuItem key={folder.id} icon={FolderIcon} onSelect={() => openFolder(folder.id)}>
                  {folder.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * Chip / Mini / Outline with the folder icon. Its own element rather than MiniChip, because a long
 * name has to shrink and end in an ellipsis to fit beside the key.
 */
function FolderChip({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={name}
      onClick={onClick}
      className="inline-flex min-w-0 cursor-pointer items-center gap-4 rounded-6 px-7 py-3 inset-ring inset-ring-border text-micro font-medium text-text-secondary transition-colors hover:text-text-primary"
    >
      <FolderIcon size={11} aria-hidden className="shrink-0" />
      <span className="truncate">{name}</span>
    </button>
  );
}

// Footers

/** Wraps a control in a tooltip when there's something to say. */
function Hint({ content, shortcut, children }: { content?: string; shortcut?: string; children: ReactNode }) {
  if (!content) return children;
  return (
    <Tooltip content={content} shortcut={shortcut}>
      {children}
    </Tooltip>
  );
}

/** Detail / Actions / Assets (design AtTwE). */
function LibraryActions({ id, actions }: { id: string; actions: DetailActions }) {
  const [filing, setFiling] = useState(false);
  const replayHint = actions.canReplay ? undefined : t("assets.detail.notMadeHere");
  const favouriteLabel = actions.favourite ? t("assets.detail.unfavorite") : t("assets.detail.favorite");
  return (
    <div className="flex w-full shrink-0 flex-col gap-8">
      <Hint content={replayHint ?? (actions.recreateInexact ? t("feed.tile.recreateInexact") : undefined)}>
        <Button
          icon={RefreshCw}
          price={actions.canReplay ? actions.recreatePrice : undefined}
          loading={actions.recreating}
          aria-disabled={!actions.canReplay || undefined}
          onClick={actions.canReplay ? actions.onRecreate : undefined}
          className={cn("w-full", !actions.canReplay && "cursor-default opacity-40")}
        >
          {t("assets.detail.recreate")}
        </Button>
      </Hint>
      <div className="flex w-full gap-8">
        <Hint content={replayHint}>
          <Button
            variant="secondary"
            size="l"
            icon={PencilLine}
            aria-disabled={!actions.canReplay || undefined}
            onClick={actions.canReplay ? actions.onReuse : undefined}
            className={cn("flex-1", !actions.canReplay && "cursor-default opacity-40")}
          >
            {t("assets.detail.reuse")}
          </Button>
        </Hint>
        {actions.onCopyImage ? (
          <Button variant="secondary" size="l" icon={Copy} onClick={actions.onCopyImage} className="flex-1">
            {t("assets.detail.copyImage")}
          </Button>
        ) : null}
      </div>
      <div className="flex w-full gap-8">
        <Button variant="secondary" size="l" icon={Download} onClick={actions.onDownload} className="flex-1">
          {t("assets.detail.download")}
        </Button>
        <Tooltip content={favouriteLabel} shortcut="F">
          <IconButton
            variant="secondary"
            size="44x40"
            icon={Heart}
            label={favouriteLabel}
            aria-pressed={actions.favourite}
            onClick={actions.onFavourite}
            // Filled accent when on (§4.0).
            className={cn(actions.favourite && "text-accent [&>svg]:fill-current")}
          />
        </Tooltip>
        {/* The library's picker, anchored to the button, on or off per folder for this image (§4.0). */}
        <AddToFolderPopover ids={[id]} open={filing} onOpenChange={setFiling} side="top" align="end">
          <IconButton
            variant="secondary"
            size="44x40"
            icon={FolderInput}
            label={t("assets.detail.addToFolder")}
          />
        </AddToFolderPopover>
        <IconButton
          variant="secondary"
          size="44x40"
          icon={Trash2}
          tone="danger"
          label={t("assets.detail.delete")}
          onClick={actions.onDelete}
        />
      </div>
    </div>
  );
}

/** Detail / Actions / Trash (design jQQ6s): Restore and Delete for good. */
function TrashActions({ actions }: { actions: DetailActions }) {
  return (
    <div className="flex w-full shrink-0 gap-8">
      <Button icon={RotateCcw} loading={actions.restoring} onClick={actions.onRestore} className="flex-1">
        {t("assets.detail.restore")}
      </Button>
      <Button variant="danger-ghost" onClick={actions.onDeleteForGood} className="flex-1">
        {t("assets.detail.deleteForGood")}
      </Button>
    </div>
  );
}
