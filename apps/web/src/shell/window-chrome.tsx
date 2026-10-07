import { t } from "@openfield/core";
import { cn, IconButton } from "@openfield/ui";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type WindowPlatform, windowCommand, windowIsMaximized, windowPlatform } from "../lib/desktop";

// The desktop app's title bar, drawn by the page because the window has none (window.rs). On a Mac
// the traffic lights sit in an empty 28px strip above the nav; on Windows and Linux the nav ends
// with minimize, maximize and close. Empty parts of both move the window, and double-clicking them
// maximizes it (Tauri's data-tauri-drag-region). In a browser every part of this renders nothing.

/**
 * Marks <html> with the platform, so `mac-window:` classes can move chrome that floats at the top
 * of the window (the canvas editor's) below the traffic lights. Called once, before the first render.
 */
export function markWindowPlatform(root: HTMLElement, platform = windowPlatform()): void {
  if (platform) root.dataset.window = platform;
}

/** What the nav adds to be a drag region: its empty parts move the window. */
export const dragRegion = (platform = windowPlatform()) =>
  platform ? ({ "data-tauri-drag-region": "deep" } as const) : {};

/**
 * The top 28px of the window. Above the nav (Mac), an empty strip in the nav's colour for the
 * traffic lights. Over the canvas editor, which has no nav (any desktop), a see-through strip that
 * moves the window. It stacks over the canvas but under the editor's own chrome.
 */
export function WindowStrip({
  floating,
  platform = windowPlatform(),
}: {
  floating: boolean;
  platform?: WindowPlatform | null;
}) {
  if (!platform || (!floating && platform !== "mac")) return null;
  return (
    <div
      aria-hidden
      data-tauri-drag-region
      className={floating ? "fixed inset-x-0 top-0 z-6 h-28" : "h-28 shrink-0 bg-surface"}
    />
  );
}

/**
 * Minimize, maximize or restore, and close, for Windows and Linux. In the nav they follow Settings
 * after a hairline; over the canvas editor they sit in a pill like the rest of its top row.
 */
export function WindowControls({
  placement,
  platform = windowPlatform(),
}: {
  placement: "nav" | "floating";
  platform?: WindowPlatform | null;
}) {
  if (platform !== "other") return null;
  return <WindowButtons placement={placement} />;
}

/**
 * The window's title bar again, above an open modal and its scrim, which cover the nav (or the
 * editor's pill) and with it every way to move, minimize, maximize or close the window. It draws
 * the strip and buttons exactly where they sit underneath, so nothing moves when a modal opens.
 */
export function ModalWindowBar({
  inEditor,
  platform = windowPlatform(),
}: {
  inEditor: boolean;
  platform?: WindowPlatform | null;
}) {
  if (!platform) return null;
  return (
    <div
      // The modal turns off pointer events outside itself; this layer needs them back.
      className="pointer-events-auto fixed inset-x-0 top-0 z-50"
      // Moving the window or pressing its buttons is not a click outside the modal: keep it open.
      // The drag itself starts on mousedown, which this leaves alone.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {platform === "mac" ? (
        <div aria-hidden data-tauri-drag-region className="h-28" />
      ) : inEditor ? (
        <>
          <div aria-hidden data-tauri-drag-region className="h-28" />
          <div className="absolute top-12 right-12">
            <WindowButtons placement="floating" />
          </div>
        </>
      ) : (
        // The nav's height and inset, so the buttons land on the nav's own.
        <div data-tauri-drag-region className="flex h-44 items-center justify-end px-16">
          <WindowButtons placement="bare" />
        </div>
      )}
    </div>
  );
}

function WindowButtons({ placement }: { placement: "nav" | "floating" | "bare" }) {
  const maximized = useMaximized();
  return (
    <div
      className={cn(
        "flex items-center gap-4",
        placement === "floating" && "h-40 rounded-10 bg-elevated px-6 inset-ring inset-ring-border",
      )}
    >
      {placement === "nav" ? <span aria-hidden className="mr-4 h-16 w-px bg-border" /> : null}
      <IconButton icon={Minus} label={t("app.window.minimize")} onClick={() => windowCommand("minimize")} />
      <IconButton
        icon={maximized ? Copy : Square}
        label={maximized ? t("app.window.restore") : t("app.window.maximize")}
        onClick={() => windowCommand("internal_toggle_maximize")}
      />
      {/* Goes through the app's close request, so it asks first while images are being made. */}
      <IconButton
        icon={X}
        label={t("app.window.close")}
        onClick={() => windowCommand("close")}
        className="not-disabled:hover:bg-danger not-disabled:hover:text-danger-fg"
      />
    </div>
  );
}

/** Follows the window's maximized state. Maximizing resizes the page, so a resize is when to ask. */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      void windowIsMaximized().then((now) => {
        if (live) setMaximized(now);
      });
    };
    // Dragging an edge fires resize on every frame; ask once it settles.
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 100);
    };
    check();
    window.addEventListener("resize", onResize);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return maximized;
}
