import { useEffect } from "react";
import { type LiveState, selectGenerating, selectInSync, useLive } from "./live";

// The desktop app loads this same page from the local server. Tauri adds __TAURI_INTERNALS__ to
// the window, and its capability lets this page call set_generating, which animates the dock or
// taskbar icon and asks before quitting mid-run, plus the few window commands its own title bar
// needs (WEB_APP_PERMISSIONS in apps/desktop/src-tauri/src/window.rs). A browser tab never has it, so all of
// this does nothing there. Calling the internals directly keeps @tauri-apps/api out of the bundle.

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const tauri = (): TauriInternals | undefined =>
  (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

/** Running inside the Openfield desktop app. */
export const isDesktop = (): boolean => typeof tauri()?.invoke === "function";

/**
 * Which title bar the page draws, if any. The desktop window has no native one: on a Mac the
 * traffic lights float over the page, elsewhere the page draws minimize, maximize and close. In a
 * browser (null) the page draws nothing extra.
 */
export type WindowPlatform = "mac" | "other";

export function windowPlatformOf(env: { desktop: boolean; userAgent: string }): WindowPlatform | null {
  if (!env.desktop) return null;
  // WKWebView says "Macintosh"; WebView2 and WebKitGTK say Windows or Linux.
  return /Macintosh|Mac OS X/.test(env.userAgent) ? "mac" : "other";
}

export const windowPlatform = (): WindowPlatform | null =>
  windowPlatformOf({ desktop: isDesktop(), userAgent: globalThis.navigator?.userAgent ?? "" });

/** The empty strip at the top of a Mac desktop window that the traffic lights sit in. */
export const STRIP_HEIGHT = 28;

/** How far chrome floating at the top of the window moves down to clear the traffic lights. */
export const windowTopInset = (platform = windowPlatform()): number =>
  platform === "mac" ? STRIP_HEIGHT : 0;

/**
 * Tauri's own window commands. `close` asks first while images are being made, exactly like the
 * system's close button: it raises the same close request the app intercepts. internal_toggle_maximize
 * is the one double-clicking a drag region uses; it leaves a window that can't be resized alone.
 */
export type WindowCommand = "minimize" | "internal_toggle_maximize" | "close";

/** Runs a window command. Never throws: a failure leaves the window as it was. */
export function windowCommand(command: WindowCommand): void {
  const internals = tauri();
  if (typeof internals?.invoke !== "function") return;
  try {
    void internals.invoke(`plugin:window|${command}`).catch(() => {});
  } catch {
    // The window stays as it is.
  }
}

/** Whether the window fills the screen as maximized. False when it can't tell. */
export async function windowIsMaximized(): Promise<boolean> {
  const internals = tauri();
  if (typeof internals?.invoke !== "function") return false;
  try {
    return (await internals.invoke("plugin:window|is_maximized")) === true;
  } catch {
    return false;
  }
}

/** Tells the desktop app whether anything is generating. Never throws. */
export function setGenerating(on: boolean): void {
  const internals = tauri();
  if (typeof internals?.invoke !== "function") return;
  try {
    // An older app without the command rejects; the icon just stays still.
    void internals.invoke("set_generating", { on }).catch(() => {});
  } catch {
    // Same: the page keeps working without the desktop side.
  }
}

/**
 * Sends set_generating whenever the state flips, and again each time a connection's snapshot
 * lands, so a reloaded page or a restarted server never leaves the icon out of step. While the
 * stream is down (or back but not yet caught up) the page can't tell, so the app keeps the last
 * answer: the server may well still be making images, and quitting should still ask first.
 * Returns the unsubscribe.
 */
export function startDesktopBridge(store: typeof useLive = useLive): () => void {
  if (!isDesktop()) return () => {};
  holdAwake();
  let sent: boolean | undefined;
  let inSync = false;
  const sync = (state: LiveState) => {
    const now = selectInSync(state);
    const caughtUp = now && !inSync;
    inSync = now;
    if (!now) return;
    const on = selectGenerating(state);
    if (!caughtUp && on === sent) return;
    sent = on;
    setGenerating(on);
  };
  sync(store.getState());
  return store.subscribe(sync);
}

/**
 * The app turns off background throttling for its window, but only macOS 14+ honours that. For
 * Windows and Linux, Tauri's suggested workaround is a Web Lock held for the page's life: Chromium
 * (WebView2) doesn't freeze a page holding one, so a hidden window still hears about runs.
 */
let awake = false;
function holdAwake(): void {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (awake || !locks) return;
  awake = true;
  void locks.request("openfield-desktop-awake", () => new Promise<never>(() => {})).catch(() => {});
}

/** Mounted once in the app shell. */
export function useDesktopBridge() {
  useEffect(() => startDesktopBridge(), []);
}
