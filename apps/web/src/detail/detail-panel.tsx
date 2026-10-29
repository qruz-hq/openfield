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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from "@openfield/ui";
import {
  Brush,
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
import { titleOf } from "./format";
import type { EditedFrom } from "./lineage";
import type { DetailTab } from "./use-detail";

// Detail / Panel / Assets and / Trash (design sb8P2, JSKpv): header, PROMPT, DETAILS, a spacer,
// then the footer at the bottom. An image in the library also gets the Info and Edit tabs under the
// header (design oH7EH35br4, Detail / Tabs / Info / Two tabs); History waits for its own work. An
// edited image shows EDITED FROM in PROMPT's place (design Ma9PL8X7rV, Detail / Panel / Info / Edited).

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
  /** Opens the Edit tab. Left out for what can't be edited (a video). */
  onEdit?: (() => void) | undefined;
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
  asset: Pick<AssetListItem, "kind" | "providerId" | "modelId" | "width" | "height" | "createdAt">;
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
  /**
   * An edited image's original, mask and references, shown in place of Prompt. onEditAgain opens
   * the original on Edit with the same mask; left out where that can't happen (the Trash).
   */
  editedFrom?: { from: EditedFrom; onEditAgain?: (() => void) | undefined } | undefined;
  /**
   * The Info and Edit tabs, and what Edit shows. Left out for what can't be edited here (a video,
   * an image in the trash), which keeps the panel as it was, with no tabs.
   */
  tabs?: { tab: DetailTab; onTabChange: (tab: DetailTab) => void; edit: ReactNode } | undefined;
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
  editedFrom,
  tabs,
}: DetailPanelProps) {
  // A photo uploaded as it is has no words to show (design epAPf9QTJL): Details says where it came from.
  const uploadedOnly = asset.kind === "uploaded" && !prompt.trim();
  const header = (
    // Detail / Panel header
    <div className="flex w-full shrink-0 items-center justify-between gap-12">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="truncate text-body-strong text-text-primary">{title}</span>
        <span className="truncate text-caption text-text-tertiary">{caption}</span>
      </div>
      <ModalClose asChild>
        <IconButton variant="round" size={30} icon={X} label={t("assets.detail.close")} />
      </ModalClose>
    </div>
  );
  const info = (
    <>
      {/* The blocks scroll when an open prompt is long, so the footer stays put. */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-12 overflow-y-auto">
        {editedFrom ? (
          <EditedFromSection
            id={id}
            from={editedFrom.from}
            prompt={prompt}
            models={models}
            onOpen={onOpenReference}
            onEditAgain={editedFrom.onEditAgain}
          />
        ) : uploadedOnly ? null : (
          <PromptSection
            key={id}
            prompt={prompt}
            references={references ?? []}
            onOpenReference={onOpenReference}
          />
        )}
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
      {trashed ? (
        <TrashActions actions={actions} />
      ) : (
        <LibraryActions id={id} uploaded={asset.kind === "uploaded"} actions={actions} />
      )}
    </>
  );
  const panelClass = "absolute top-8 right-8 bottom-8 mac-window:top-36 other-window:top-52";

  if (!tabs) {
    return (
      <Surface variant="panel" hidden={hidden} className={panelClass}>
        {header}
        {info}
      </Surface>
    );
  }
  // Each tab's body fills the rest of the panel's column, as the blocks after the tabs would.
  const body = "flex min-h-0 w-full flex-1 flex-col gap-12 focus-visible:outline-none";
  return (
    <Tabs asChild value={tabs.tab} onValueChange={(value) => tabs.onTabChange(value as DetailTab)}>
      <Surface variant="panel" hidden={hidden} className={panelClass}>
        {header}
        {/* Detail / Tabs / Info and / Edit, Two tabs */}
        <TabsList variant="segmented" className="shrink-0">
          <TabsTrigger value="info">{t("assets.detail.tabs.info")}</TabsTrigger>
          <TabsTrigger value="edit">{t("assets.detail.tabs.edit")}</TabsTrigger>
        </TabsList>
        {/* Not tab stops of their own: Tab goes from the tabs straight to the first control. */}
        <TabsContent value="info" tabIndex={-1} className={body}>
          {info}
        </TabsContent>
        {/* Edit's settings scroll when the window is too short for them, footer and all. */}
        <TabsContent value="edit" tabIndex={-1} className={cn(body, "overflow-y-auto")}>
          {tabs.edit}
        </TabsContent>
      </Surface>
    </Tabs>
  );
}

// PROMPT (design O0zG8)

const COPIED_MS = 1200;

/** Chip / Mini with Copy: puts the prompt on the clipboard, then says Copied for a moment. */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  return (
    <MiniChip
      icon={Copy}
      label={copied ? t("assets.detail.copied") : t("assets.detail.copy")}
      onClick={copy}
    />
  );
}

function PromptSection({
  prompt,
  references,
  onOpenReference,
}: {
  prompt: string;
  references: readonly Asset[];
  onOpenReference: (asset: Asset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  const hasPrompt = prompt.trim().length > 0;

  // See all shows only when six lines don't hold the prompt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the prompt changes.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [prompt, open]);

  return (
    <Surface variant="block" className="w-full shrink-0">
      <div className="flex w-full items-center justify-between">
        <SectionLabel>{t("assets.detail.prompt")}</SectionLabel>
        {hasPrompt ? <CopyChip text={prompt} /> : null}
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

/**
 * Detail / Reference thumb / Primary and / Default: 54px, radius 8, the first ringed in accent.
 * Without `onOpen` it's only a picture, for a row that has its own Open.
 */
function ReferenceThumb({
  asset,
  primary,
  label,
  onOpen,
}: {
  asset: Asset;
  primary: boolean;
  label?: string;
  onOpen?: () => void;
}) {
  const image = useAuthedImage(assetThumbUrl(asset.id, { h: 200 }));
  const inner = (
    <>
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
    </>
  );
  const box = "relative size-54 shrink-0 overflow-hidden rounded-8 bg-elevated-2";
  if (!onOpen)
    return (
      <div aria-hidden className={box}>
        {inner}
      </div>
    );
  return (
    <button type="button" aria-label={label} onClick={onOpen} className={cn(box, "cursor-pointer")}>
      {inner}
    </button>
  );
}

// EDITED FROM (design Detail / Section / Edited from, and its Whole image, Rest not kept and Not
// kept exactly variants, which only change the Mask row's second line)

function EditedFromSection({
  id,
  from,
  prompt,
  models,
  onOpen,
  onEditAgain,
}: {
  /** The edited image, under its mask when the original has gone. */
  id: string;
  from: EditedFrom;
  prompt: string;
  models: readonly ModelListItem[] | undefined;
  onOpen: (asset: Asset) => void;
  onEditAgain: (() => void) | undefined;
}) {
  const { original, mask, maskNote, references } = from;
  const first = references[0];
  const hasPrompt = prompt.trim().length > 0;
  const modelOf = (asset: Asset) =>
    models?.find((m) => m.providerId === asset.providerId && m.modelId === asset.modelId)?.displayName ??
    asset.modelId ??
    undefined;
  return (
    <Surface variant="block" className="w-full shrink-0">
      <div className="flex w-full items-center justify-between">
        <SectionLabel>{t("assets.detail.editedFrom.label")}</SectionLabel>
        {hasPrompt ? <CopyChip text={prompt} /> : null}
      </div>
      {original ? (
        <LineageRow
          thumb={<ReferenceThumb asset={original} primary={false} />}
          title={titleOf(original.prompt, modelOf(original))}
          subtitle={t("assets.detail.editedFrom.original")}
        >
          <Button variant="ghost" size="s" onClick={() => onOpen(original)}>
            {t("assets.detail.editedFrom.open")}
          </Button>
        </LineageRow>
      ) : null}
      {mask ? (
        <LineageRow
          thumb={<MaskThumb imageId={original?.id ?? id} mask={mask} />}
          title={t("assets.detail.editedFrom.mask")}
          subtitle={maskNote}
        />
      ) : null}
      {first ? (
        <LineageRow
          thumb={
            <ReferenceThumb
              asset={first}
              primary={false}
              label={t("assets.detail.reference", { index: 1 })}
              onOpen={() => onOpen(first)}
            />
          }
          title={t("assets.detail.editedFrom.references")}
          subtitle={t("assets.detail.editedFrom.referenceCount", { count: references.length })}
        />
      ) : null}
      <p
        className={cn(
          "w-full whitespace-pre-wrap break-words text-small leading-[1.45]",
          hasPrompt ? "text-text-primary" : "text-text-tertiary",
        )}
      >
        {hasPrompt ? prompt : t("assets.detail.noPrompt")}
      </p>
      {onEditAgain && original && mask ? (
        <Button variant="secondary" size="l" icon={Brush} onClick={onEditAgain} className="w-full">
          {t("assets.detail.editedFrom.editAgain")}
        </Button>
      ) : null}
    </Surface>
  );
}

/** A thumb, then its title and a second line, then whatever the row offers (Open). */
function LineageRow({
  thumb,
  title,
  subtitle,
  children,
}: {
  thumb: ReactNode;
  title: string;
  subtitle: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-10">
      {thumb}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate text-small font-medium text-text-primary">{title}</span>
        {subtitle ? <span className="w-full text-caption text-text-tertiary">{subtitle}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The mask over the image it was painted on: the image under the overlay fill, the painted area in
 * the accent at 90%, softened by a 2px blur. The mask's own alpha is 0 where it was painted, so the
 * accent shows through it inverted: a solid layer excluding the mask. It's painted dark in both
 * themes, as everything over an image is, so the accent stays light over the dark fill.
 */
function MaskThumb({ imageId, mask }: { imageId: string; mask: Asset }) {
  const image = useAuthedImage(assetThumbUrl(imageId, { h: 200 }));
  const painted = useAuthedImage(mask.fileUrl);
  const shape =
    painted.status === "ready"
      ? {
          // Older WebKit's names first; where a browser takes both, the standard ones come last and win.
          WebkitMaskImage: `linear-gradient(#000, #000), url("${painted.src}")`,
          WebkitMaskComposite: "xor",
          WebkitMaskSize: "cover",
          WebkitMaskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          maskImage: `linear-gradient(#000, #000), url("${painted.src}")`,
          maskComposite: "exclude",
          // The same crop as the image's object-cover.
          maskSize: "cover",
          maskPosition: "center",
          maskRepeat: "no-repeat",
        }
      : undefined;
  return (
    <div
      aria-hidden
      data-paint="dark"
      className="relative size-54 shrink-0 overflow-hidden rounded-8 bg-elevated-2"
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" draggable={false} className="size-full object-cover" />
      ) : null}
      <span className="absolute inset-0 bg-overlay" />
      {shape ? (
        <span data-mask-thumb className="absolute inset-0 opacity-90 blur-[2px]">
          <span className="absolute inset-0 bg-accent" style={shape} />
        </span>
      ) : null}
      <span className="pointer-events-none absolute inset-0 rounded-8 inset-ring inset-ring-border" />
    </div>
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
        {/* An upload has no model; the first row says where it came from instead. */}
        {asset.kind === "uploaded" && !modelName ? (
          <KeyValueRow label={t("assets.detail.source")} value={t("assets.detail.uploaded")} />
        ) : null}
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

/** Detail / Actions / Assets, With Edit and Uploaded (design AtTwE, CIfbbd5WMA, smL0PuARml). */
function LibraryActions({
  id,
  uploaded,
  actions,
}: {
  id: string;
  uploaded: boolean;
  actions: DetailActions;
}) {
  const [filing, setFiling] = useState(false);
  const replayHint = actions.canReplay ? undefined : t("assets.detail.notMadeHere");
  const recreateHint = actions.canReplay
    ? actions.recreateInexact
      ? t("feed.tile.recreateInexact")
      : undefined
    : uploaded
      ? t("assets.detail.uploadedNoPrompt")
      : replayHint;
  const favouriteLabel = actions.favourite ? t("assets.detail.unfavorite") : t("assets.detail.favorite");
  return (
    <div className="flex w-full shrink-0 flex-col gap-8">
      {/* Recreate row: Recreate, and Edit beside it, which stays on even when Recreate can't. */}
      <div className="flex w-full gap-8">
        <Hint content={recreateHint}>
          <Button
            icon={RefreshCw}
            price={actions.canReplay ? actions.recreatePrice : undefined}
            loading={actions.recreating}
            aria-disabled={!actions.canReplay || undefined}
            onClick={actions.canReplay ? actions.onRecreate : undefined}
            className={cn("min-w-0 flex-1", !actions.canReplay && "cursor-default opacity-40")}
          >
            {t("assets.detail.recreate")}
          </Button>
        </Hint>
        {actions.onEdit ? (
          <Button variant="secondary" size="l" icon={Brush} onClick={actions.onEdit}>
            {t("assets.detail.edit")}
          </Button>
        ) : null}
      </div>
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
