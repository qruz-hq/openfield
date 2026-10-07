import { useEffect } from "react";
import { type LiveState, selectGenerating, selectInSync, useLive } from "./live";

// The desktop app loads this same page from the local server. Tauri adds __TAURI_INTERNALS__ to
// the window, and its capability lets this page call one command, set_generating, which animates
// the dock or taskbar icon and asks before quitting mid-run. A browser tab never has it, so all of
// this does nothing there. Calling the internals directly keeps @tauri-apps/api out of the bundle.

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const tauri = (): TauriInternals | undefined =>
  (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

/** Running inside the Openfield desktop app. */
export const isDesktop = (): boolean => typeof tauri()?.invoke === "function";

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

/** Mounted once in the app shell. */
export function useDesktopBridge() {
  useEffect(() => startDesktopBridge(), []);
}
