import type { AssetListItem } from "@openfield/core";
import { t } from "@openfield/core";
import { Ban, Folder } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useAuthedImage } from "../api/hooks/images";
import { thumbPath } from "./media";

// Drag and drop in the library (§2.8, design Jicd4, fWo1s, l6Ph7A): images onto folders, folders
// onto folders or onto the Folders heading. Pointer events rather than HTML drag and drop, so the
// ghost and the hint can follow the pointer and change as the target does.
//
// A drop target is any element with data-drop-folder="<id>" (and data-drop-name) or
// data-drop-top. The page decides what a drop means through useDragStore's `rules`.

export type DragPayload =
  | { kind: "images"; ids: string[]; previews: AssetListItem[] }
  | {
      kind: "folder";
      folderId: string;
      name: string;
      /** The folder and everything inside it: dimmed while it's dragged, and never a target. */
      subtree: ReadonlySet<string>;
    };

export type DropTarget = { type: "folder"; id: string; name: string } | { type: "top" };

export type DropVerdict = "allowed" | "blocked" | "none";

export interface DragRules {
  judge: (payload: DragPayload, target: DropTarget) => DropVerdict;
  drop: (payload: DragPayload, target: DropTarget) => void;
  /** A collapsed folder hovered for a while opens, so a drag can reach inside it. */
  expand: (folderId: string) => void;
}

interface DragState {
  payload: DragPayload | null;
  x: number;
  y: number;
  target: DropTarget | null;
  verdict: DropVerdict;
  /** Right edge of the sidebar when the pointer is over it, for placing the hint. */
  sidebarRight: number | null;
  rules: DragRules | null;
}

export const useDragStore = create<DragState>()(() => ({
  payload: null,
  x: 0,
  y: 0,
  target: null,
  verdict: "none",
  sidebarRight: null,
  rules: null,
}));

const START_DISTANCE = 5;
const EXPAND_AFTER_MS = 600;
const EDGE = 48;

function targetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-folder],[data-drop-top]");
  if (!el) return null;
  if (el.dataset.dropTop !== undefined) return { type: "top" };
  const id = el.dataset.dropFolder;
  return id ? { type: "folder", id, name: el.dataset.dropName ?? "" } : null;
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a?.type === b?.type && (a?.type !== "folder" || (b?.type === "folder" && a.id === b.id));

/** Swallows the click that ends a drag, so the card or row doesn't also open. */
function swallowNextClick() {
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/**
 * Makes an element draggable. `payload` is read when the pointer has moved far enough to count as
 * a drag, so a plain click never pays for it.
 */
export function useDragSource(payload: () => DragPayload | null) {
  return useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Controls on top keep their own gesture, except one marked as the whole card's face.
      const control = (event.target as HTMLElement).closest("button,input,[role=checkbox],[data-no-drag]");
      if (control && !control.hasAttribute("data-drag-handle")) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let started = false;
      let hovered: DropTarget | null = null;
      let hoverTimer: ReturnType<typeof setTimeout> | undefined;
      let frame = 0;

      const autoScroll = () => {
        const { payload: active, x, y } = useDragStore.getState();
        if (!active) return;
        const scroller = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drag-scroll]");
        if (scroller) {
          const box = scroller.getBoundingClientRect();
          if (y < box.top + EDGE) scroller.scrollTop -= Math.ceil((box.top + EDGE - y) / 4);
          else if (y > box.bottom - EDGE) scroller.scrollTop += Math.ceil((y - (box.bottom - EDGE)) / 4);
        }
        frame = requestAnimationFrame(autoScroll);
      };

      const update = (x: number, y: number) => {
        const state = useDragStore.getState();
        if (!state.payload || !state.rules) return;
        const target = targetAt(x, y);
        const verdict = target ? state.rules.judge(state.payload, target) : "none";
        const sidebar = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-library-sidebar]");
        useDragStore.setState({
          x,
          y,
          target: verdict === "none" ? null : target,
          verdict,
          sidebarRight: sidebar ? sidebar.getBoundingClientRect().right : null,
        });
        if (!sameTarget(target, hovered)) {
          hovered = target;
          clearTimeout(hoverTimer);
          if (target?.type === "folder" && verdict === "allowed") {
            hoverTimer = setTimeout(() => state.rules?.expand(target.id), EXPAND_AFTER_MS);
          }
        }
      };

      const finish = (dropIt: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        clearTimeout(hoverTimer);
        cancelAnimationFrame(frame);
        if (!started) return;
        document.body.style.removeProperty("cursor");
        const { payload: active, target, verdict, rules } = useDragStore.getState();
        useDragStore.setState({ payload: null, target: null, verdict: "none", sidebarRight: null });
        swallowNextClick();
        if (dropIt && active && target && verdict === "allowed") rules?.drop(active, target);
      };

      const onMove = (e: PointerEvent) => {
        if (!started) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < START_DISTANCE) return;
          const value = payload();
          if (!value) return finish(false);
          started = true;
          document.body.style.cursor = "grabbing";
          window.getSelection()?.removeAllRanges();
          useDragStore.setState({ payload: value, x: e.clientX, y: e.clientY });
          frame = requestAnimationFrame(autoScroll);
        }
        update(e.clientX, e.clientY);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || !started) return;
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [payload],
  );
}

/** The state a folder row or card shows while something is dragged. */
export function useDropState(folderId: string): "drop" | "cant" | "disabled" | null {
  return useDragStore((s) => {
    if (!s.payload) return null;
    if (s.target?.type === "folder" && s.target.id === folderId) {
      return s.verdict === "allowed" ? "drop" : s.verdict === "blocked" ? "cant" : null;
    }
    if (s.payload.kind === "folder" && s.payload.subtree.has(folderId)) return "disabled";
    return null;
  });
}

/** Whether this image is being dragged: it shows at 40% meanwhile (design Jicd4). */
export const useIsDragged = (id: string) =>
  useDragStore((s) => s.payload?.kind === "images" && s.payload.ids.includes(id));

// The ghost and the hint

export function DragLayer() {
  const payload = useDragStore((s) => s.payload);
  const x = useDragStore((s) => s.x);
  const y = useDragStore((s) => s.y);
  const target = useDragStore((s) => s.target);
  const verdict = useDragStore((s) => s.verdict);
  const sidebarRight = useDragStore((s) => s.sidebarRight);
  const ghost = useRef<HTMLDivElement>(null);
  const [ghostWidth, setGhostWidth] = useState(0);
  useLayoutEffect(() => {
    const width = ghost.current?.offsetWidth ?? 0;
    if (width !== ghostWidth) setGhostWidth(width);
  });
  if (!payload) return null;

  const blocked = verdict === "blocked";
  let hint: string | null = null;
  if (payload.kind === "images" && target?.type === "folder" && verdict === "allowed") {
    hint = t("assets.drag.add", { count: payload.ids.length, folder: target.name });
  } else if (payload.kind === "folder" && target) {
    if (blocked) hint = t("assets.drag.insideItself");
    else if (target.type === "top") hint = t("assets.drag.moveTop");
    else hint = t("assets.drag.moveInto", { folder: target.name });
  }

  // The ghost sits just below and right of the pointer. The hint goes beside it, and never over
  // the sidebar while the pointer is on it, so the rows stay readable.
  const ghostX = x + 10;
  const ghostY = y + 6;
  const hintX = Math.max(ghostX + ghostWidth + 16, sidebarRight === null ? 0 : sidebarRight + 7);
  const hintY = y + (payload.kind === "images" ? 62 : 10);

  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-60">
      <div ref={ghost} className="absolute" style={{ left: ghostX, top: ghostY }}>
        {payload.kind === "images" ? (
          <ImagesGhost previews={payload.previews} count={payload.ids.length} />
        ) : (
          <FolderGhost name={payload.name} blocked={blocked} />
        )}
      </div>
      {hint ? (
        <div
          className="absolute flex max-w-240 items-center gap-8 rounded-8 bg-elevated-2 px-8 py-6 inset-ring inset-ring-border shadow-popover text-caption font-medium text-text-primary"
          style={{ left: hintX, top: hintY }}
        >
          {hint}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** Library / Drag ghost / Images: two stacked thumbnails and a count (design qimon). */
function ImagesGhost({ previews, count }: { previews: AssetListItem[]; count: number }) {
  const [front, back] = previews;
  return (
    <div className="relative h-92 w-96">
      {back && count > 1 ? <GhostImage asset={back} className="top-14 left-22 -rotate-8" /> : null}
      {front ? <GhostImage asset={front} className="top-18 left-10 shadow-[0_12px_24px_#00000080]" /> : null}
      {count > 1 ? (
        <span className="absolute top-6 left-60 flex h-22 items-center justify-center rounded-full bg-accent px-7 font-mono text-[12px] leading-[16px] font-semibold text-accent-fg">
          {count}
        </span>
      ) : null}
    </div>
  );
}

function GhostImage({ asset, className }: { asset: AssetListItem; className: string }) {
  const image = useAuthedImage(thumbPath(asset, 200));
  return (
    <span
      className={`absolute size-64 overflow-hidden rounded-10 bg-elevated inset-ring inset-ring-border-strong ${className}`}
    >
      {image.status === "ready" ? <img src={image.src} alt="" className="size-full object-cover" /> : null}
    </span>
  );
}

/** Library / Drag ghost / Folder and / Can't drop (design D1CFEp, aIda4). */
function FolderGhost({ name, blocked }: { name: string; blocked: boolean }) {
  return (
    <span
      className={`flex h-36 items-center gap-8 rounded-10 bg-elevated-2 px-12 inset-ring shadow-[0_12px_24px_#00000080] ${blocked ? "inset-ring-danger-line" : "inset-ring-border-strong"}`}
    >
      <Folder size={16} className="shrink-0 text-text-secondary" />
      <span className="max-w-200 truncate text-small font-medium text-text-primary">{name}</span>
      {blocked ? <Ban size={14} className="shrink-0 text-danger" /> : null}
    </span>
  );
}
