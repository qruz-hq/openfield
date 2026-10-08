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
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAuthedImage } from "../../api/hooks/images";
import { UPLOAD_ACCEPT, uploadImages } from "../../api/hooks/uploads";
import { errorMessage } from "../../api/raw";
import { LibraryPicker } from "../../canvas/nodes/assets/library-picker";
import { notifyError } from "../../lib/notify";
import { useComposer } from "./store";

// The composer's reference images (§3.2): a row above the prompt, the images in the order the
// model gets them, then the + (upload, or pick with the same library picker the canvas uses).
// Tiles are 56 square, radius 8, 6 apart; the first is the primary reference and carries the
// accent ring. Drag a tile, or Alt and an arrow key, to move it; the others slide out of its way.
// Past the model's limit tiles dim, and the note above the composer says how many will go.

const THUMB = 56;
const GAP = 6;
/** One tile and the gap after it: how far a neighbour slides when a tile passes it. */
const SLOT = THUMB + GAP;
/** How far the pointer moves before a press becomes a drag. */
const DRAG_START = 4;
const EASE = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";

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

/** Where a tile dragged from `from` by `dx` pixels lands, among `count`. */
export function dropIndex(from: number, dx: number, count: number): number {
  return Math.max(0, Math.min(count - 1, from + Math.round(dx / SLOT)));
}

/** How far the tile at `index` slides while another is dragged from `from` towards `to`. */
export function makeRoomOffset(index: number, from: number, to: number): number {
  if (from < to && index > from && index <= to) return -SLOT;
  if (to < from && index >= to && index < from) return SLOT;
  return 0;
}

const isImageFile = (file: File) =>
  (UPLOAD_MIME_TYPES as readonly string[]).includes(file.type) ||
  UPLOAD_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

/**
 * Uploads files as references, in order. `pending` has one id per file still going up, so the
 * row can hold their places. Files that aren't images are turned away by name.
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

/**
 * Slides tiles from where they were to where they are after the order changes (FLIP): call
 * `remember` just before changing it, and the next layout plays the move. Measuring the DOM
 * rather than tracking indexes keeps it right however the change arrived.
 */
function useSlide() {
  const list = useRef<HTMLOListElement>(null);
  const before = useRef<Map<string, number> | null>(null);

  const remember = useCallback(() => {
    const at = new Map<string, number>();
    for (const el of list.current?.querySelectorAll<HTMLElement>("[data-reference]") ?? []) {
      at.set(el.dataset.reference!, el.getBoundingClientRect().left);
    }
    before.current = at;
  }, []);

  // Every render: it only acts when remember() ran since the last one.
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    if (!from || !list.current) return;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const el of list.current.querySelectorAll<HTMLElement>("[data-reference]")) {
      const was = from.get(el.dataset.reference!);
      if (was === undefined) continue;
      el.style.transition = "none";
      el.style.transform = "";
      const dx = was - el.getBoundingClientRect().left;
      if (Math.abs(dx) < 0.5) {
        el.style.removeProperty("transition");
        continue;
      }
      el.style.transform = `translateX(${dx}px)`;
      // Commit the start position before easing back to none.
      el.getBoundingClientRect();
      el.style.transition = EASE;
      el.style.transform = "";
      el.addEventListener("transitionend", () => el.style.removeProperty("transition"), { once: true });
    }
  });

  return { list, remember };
}

interface Drag {
  id: string;
  from: number;
  dx: number;
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
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ id: string; from: number; x: number; moved: boolean } | null>(null);
  const { list, remember } = useSlide();
  const max = referenceLimit(model);
  const count = references.length;
  const room = Math.max(0, max - count - pending.length);
  // The + says why it's held back rather than vanishing (§0.15).
  const reason = !model
    ? null
    : max === 0
      ? t("composer.referencesNone", { model: model.displayName })
      : room === 0
        ? t("composer.referenceLimit", { model: model.displayName, max })
        : null;
  const to = drag ? dropIndex(drag.from, drag.dx, count) : -1;

  const move = (id: string, index: number) => {
    remember();
    useComposer.getState().moveReference(id, index);
  };
  const remove = (id: string) => {
    remember();
    useComposer.getState().removeReference(id);
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, id: string, from: number) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { id, from, x: event.clientX, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p) return;
    const dx = event.clientX - p.x;
    if (!p.moved && Math.abs(dx) < DRAG_START) return;
    p.moved = true;
    // Kept within the row, so the tile can't wander off past either end.
    const clamped = Math.max(-p.from * SLOT, Math.min((count - 1 - p.from) * SLOT, dx));
    setDrag({ id: p.id, from: p.from, dx: clamped });
  };
  const onPointerUp = () => {
    const p = press.current;
    press.current = null;
    if (!p?.moved || !drag) return;
    // Remembered with the tiles where they are now, so they ease into place from there.
    setDrag(null);
    move(drag.id, to);
  };
  const onPointerCancel = () => {
    press.current = null;
    if (drag) {
      remember();
      setDrag(null);
    }
  };

  const tileStyle = (id: string, index: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (id === drag.id) return { transform: `translateX(${drag.dx}px)`, transition: "none", zIndex: 1 };
    return { transform: `translateX(${makeRoomOffset(index, drag.from, to)}px)`, transition: EASE };
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-6">
      <input
        ref={files}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          if (chosen.length) onUpload(chosen);
        }}
      />
      {count || pending.length ? (
        <ol
          ref={list}
          aria-label={t("composer.references")}
          className="-m-2 flex min-w-0 items-center gap-6 overflow-x-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {references.map((assetId, index) => (
            <ReferenceTile
              key={assetId}
              assetId={assetId}
              index={index}
              count={count}
              sent={index < max}
              dragging={drag?.id === assetId}
              style={tileStyle(assetId, index)}
              onPointerDown={(event) => onPointerDown(event, assetId, index)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onMove={(by) => move(assetId, index + by)}
              onRemove={() => remove(assetId)}
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
      <LibraryPicker
        open={pickerOpen}
        initial={references}
        max={Number.isFinite(max) ? max : undefined}
        onOpenChange={setPickerOpen}
        onPick={(ids) => useComposer.getState().setReferences(ids)}
      />
    </div>
  );
}

function ReferenceTile({
  assetId,
  index,
  count,
  sent,
  dragging,
  style,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onMove,
  onRemove,
}: {
  assetId: string;
  index: number;
  count: number;
  /** False past the model's limit: kept, but it won't go with the next run. */
  sent: boolean;
  dragging: boolean;
  style: CSSProperties | undefined;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const image = useAuthedImage(assetThumbUrl(assetId, { h: THUMB }));
  const label = t("composer.referenceItem", { index: index + 1, count });
  return (
    <li data-reference={assetId} style={style} className="group/ref relative size-56 shrink-0 rounded-8">
      <button
        type="button"
        aria-label={sent ? label : `${label} ${t("composer.referenceWontSend")}`}
        title={sent ? undefined : t("composer.referenceWontSend")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={(event: KeyboardEvent) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          onMove(event.key === "ArrowLeft" ? -1 : 1);
        }}
        className={cn(
          "relative block size-full touch-none overflow-hidden rounded-8 bg-elevated-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        {image.status === "ready" ? (
          <img
            src={image.src}
            alt=""
            draggable={false}
            className={cn("absolute inset-0 size-full object-cover", !sent && "opacity-40")}
          />
        ) : null}
        {/* Over the image, which would paint over a ring on the button itself. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-8",
            index === 0 ? "inset-ring-2 inset-ring-accent" : "inset-ring inset-ring-border",
          )}
        />
      </button>
      <button
        type="button"
        aria-label={t("composer.removeReferenceItem", { index: index + 1 })}
        onClick={onRemove}
        className={cn(
          "absolute top-3 right-3 flex size-16 cursor-pointer items-center justify-center rounded-full bg-overlay text-overlay-fg opacity-0 transition-opacity focus-visible:opacity-100",
          !dragging && "group-hover/ref:opacity-100",
        )}
      >
        <X size={10} aria-hidden strokeWidth={2.5} />
      </button>
    </li>
  );
}
