import {
  assetThumbUrl,
  type ModelListItem,
  newId,
  t,
  UPLOAD_EXTENSIONS,
  UPLOAD_MIME_TYPES,
} from "@openfield/core";
import { cn, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Spinner, Tooltip } from "@openfield/ui";
import { FolderOpen, Plus, Upload, X } from "lucide-react";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { useAuthedImage } from "../../api/hooks/images";
import { UPLOAD_ACCEPT, uploadImages } from "../../api/hooks/uploads";
import { errorMessage } from "../../api/raw";
import { ImagePicker } from "../../assets/image-picker";
import { notifyError } from "../../lib/notify";
import { useComposer } from "./store";

// The composer's reference images (§3.2): the + (upload, or pick from the library), then the
// strip of what will ride along on the next run. 56 square tiles, radius 8, 6 apart; the first is
// the primary reference and carries the accent ring. Drag a tile to reorder. Past the model's
// limit tiles dim, and the note above the composer says how many will go.

const DRAG_TYPE = "application/x-openfield-reference";
const STRIP_THUMB = 56;

/** What the picked model takes. No model yet: nothing to hold the + back. */
export function referenceLimit(model: ModelListItem | undefined): number {
  if (!model) return Number.POSITIVE_INFINITY;
  const refs = model.capabilities.references;
  return refs.supported ? refs.max : 0;
}

/** The note above the composer when some references won't be sent, else null. */
export function referenceNote(model: ModelListItem | undefined, count: number): string | null {
  if (!model || !count) return null;
  const max = referenceLimit(model);
  if (max === 0) return t("composer.referencesNone", { model: model.displayName });
  if (count > max)
    return t("composer.referencesDropped", { sent: max, total: count, model: model.displayName });
  return null;
}

const isImageFile = (file: File) =>
  (UPLOAD_MIME_TYPES as readonly string[]).includes(file.type) ||
  UPLOAD_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

/**
 * Uploads files as references, in order. `pending` has one id per file still going up, so the
 * strip can hold their places. Files that aren't images are turned away by name.
 */
export function useReferenceUploads() {
  const [pending, setPending] = useState<readonly string[]>([]);
  const upload = useCallback(async (files: readonly File[]) => {
    const images = files.filter(isImageFile);
    for (const file of files) {
      if (!isImageFile(file)) notifyError(t("composer.rejectedFile", { name: file.name }));
    }
    if (!images.length) return;
    const ids = images.map(() => newId());
    setPending((now) => [...now, ...ids]);
    try {
      const { assetIds, failed } = await uploadImages(images);
      for (const { error } of failed) notifyError(errorMessage(error));
      useComposer.getState().addReferences(assetIds);
    } finally {
      setPending((now) => now.filter((id) => !ids.includes(id)));
    }
  }, []);
  return { pending, upload };
}

export function ComposerReferences({
  model,
  pending,
  onUpload,
}: {
  model: ModelListItem | undefined;
  pending: readonly string[];
  onUpload: (files: File[]) => void;
}) {
  const references = useComposer((s) => s.references);
  const files = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  const max = referenceLimit(model);
  const room = Math.max(0, max - references.length - pending.length);
  // The + says why it's held back rather than vanishing (§0.15).
  const reason = !model
    ? null
    : max === 0
      ? t("composer.referencesNone", { model: model.displayName })
      : room === 0
        ? t("composer.referenceLimit", { model: model.displayName, max })
        : null;

  return (
    <>
      <input
        ref={files}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const list = [...(event.target.files ?? [])];
          event.target.value = "";
          if (list.length) onUpload(list);
        }}
      />
      {reason ? (
        <Tooltip content={reason}>
          <IconButton
            variant="secondary"
            size={32}
            icon={Plus}
            label={t("composer.attach")}
            aria-disabled="true"
            onClick={(event) => event.preventDefault()}
            className="shrink-0 cursor-default text-text-tertiary"
          />
        </Tooltip>
      ) : (
        <Menu>
          <MenuTrigger asChild>
            <IconButton
              variant="secondary"
              size={32}
              icon={Plus}
              label={t("composer.attach")}
              className="shrink-0"
            />
          </MenuTrigger>
          <MenuContent side="top" align="start">
            <MenuItem icon={Upload} onSelect={() => files.current?.click()}>
              {t("composer.attachUpload")}
            </MenuItem>
            <MenuItem icon={FolderOpen} onSelect={() => setPickerOpen(true)}>
              {t("composer.attachLibrary")}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      {references.length || pending.length ? (
        <ol
          aria-label={t("composer.references")}
          className="-m-2 flex max-w-[50%] shrink-0 items-center gap-6 overflow-x-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {references.map((assetId, index) => (
            <ReferenceTile
              key={assetId}
              assetId={assetId}
              index={index}
              count={references.length}
              sent={index < max}
              over={over === index}
              onOver={(on) => setOver(on ? index : null)}
            />
          ))}
          {pending.map((id) => (
            <li
              key={id}
              className="flex size-56 shrink-0 items-center justify-center rounded-8 bg-elevated-2 inset-ring inset-ring-border"
            >
              <Spinner size={14} label={t("app.loading")} className="text-text-tertiary" />
            </li>
          ))}
        </ol>
      ) : null}
      <ImagePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("composer.referencesPickerTitle")}
        max={Number.isFinite(room) ? room : 64}
        onPick={(ids) => useComposer.getState().addReferences(ids)}
      />
    </>
  );
}

function ReferenceTile({
  assetId,
  index,
  count,
  sent,
  over,
  onOver,
}: {
  assetId: string;
  index: number;
  count: number;
  /** False past the model's limit: kept, but it won't go with the next run. */
  sent: boolean;
  over: boolean;
  onOver: (on: boolean) => void;
}) {
  const image = useAuthedImage(assetThumbUrl(assetId, { h: STRIP_THUMB }));
  const label = t("composer.referenceItem", { index: index + 1, count });
  return (
    <li
      draggable
      title={sent ? undefined : t("composer.referenceWontSend")}
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, assetId);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        onOver(true);
      }}
      onDragLeave={() => onOver(false)}
      onDrop={(event: DragEvent) => {
        const dragged = event.dataTransfer.getData(DRAG_TYPE);
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
        onOver(false);
        useComposer.getState().moveReference(dragged, index);
      }}
      className={cn(
        "group/ref relative size-56 shrink-0 cursor-grab overflow-hidden rounded-8 bg-elevated-2",
        // An outline, not an inset ring: the image would paint over a ring.
        index === 0
          ? "outline-2 -outline-offset-2 outline-accent"
          : "outline-1 -outline-offset-1 outline-border",
        over && "ring-2 ring-accent-line",
      )}
    >
      {image.status === "ready" ? (
        <img
          src={image.src}
          alt={sent ? label : `${label}. ${t("composer.referenceWontSend")}`}
          draggable={false}
          className={cn("absolute inset-0 size-full object-cover", !sent && "opacity-40")}
        />
      ) : null}
      <button
        type="button"
        aria-label={t("composer.removeReferenceItem", { index: index + 1 })}
        onClick={() => useComposer.getState().removeReference(assetId)}
        className="absolute top-3 right-3 flex size-16 cursor-pointer items-center justify-center rounded-full bg-overlay text-overlay-fg opacity-0 transition-opacity group-hover/ref:opacity-100 focus-visible:opacity-100"
      >
        <X size={10} aria-hidden strokeWidth={2.5} />
      </button>
    </li>
  );
}
