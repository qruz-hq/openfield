import type { NavigateTarget, PresenceBody } from "@openfield/core";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { create } from "zustand";
import { rawFetch } from "../api/raw";
import { DETAIL_PARAM } from "../detail/use-detail";
import { useLive } from "./live";
import { tabId } from "./tab";

// Where this tab is (§7.11), told to the server on every route, selection and focus change, so an
// agent's "the canvas I have open" is the tab the person used last. And ui.navigate: a request from
// an agent to open a canvas or an image in the tab the person is using.

const REPORT_DELAY_MS = 250;

/** What the canvas editor adds while it's open. */
let canvas: { canvasId: string | null; selection: readonly string[] } = { canvasId: null, selection: [] };
let timer: ReturnType<typeof setTimeout> | undefined;

function body(): PresenceBody {
  return {
    tabId,
    path: `${window.location.pathname}${window.location.search}`,
    canvasId: canvas.canvasId,
    selection: [...canvas.selection],
    focused: document.hasFocus(),
  };
}

/** Sends where this tab is, soon (or now), once for a burst of changes. */
export function reportPresence(now = false): void {
  if (timer) clearTimeout(timer);
  const send = () => {
    timer = undefined;
    // Presence is a hint; a report lost to a restart is sent again on reconnect.
    void rawFetch("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    }).catch(() => {});
  };
  if (now) send();
  else timer = setTimeout(send, REPORT_DELAY_MS);
}

/** The open canvas and its selection, from the editor. null when it closes. */
export function setCanvasPresence(canvasId: string | null, selection: readonly string[] = []): void {
  canvas = { canvasId, selection };
  reportPresence();
}

/** Keeps the server told, for the life of the app. */
export function usePresence(): void {
  const { pathname, search } = useLocation();
  const connected = useLive((s) => s.connected);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new route is the reason to report.
  useEffect(() => reportPresence(), [pathname, search]);

  // The server forgets a tab whose stream closed, so it hears again on every reconnect.
  useEffect(() => {
    if (connected) reportPresence(true);
  }, [connected]);

  useEffect(() => {
    const now = () => reportPresence(true);
    window.addEventListener("focus", now);
    window.addEventListener("blur", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      window.removeEventListener("focus", now);
      window.removeEventListener("blur", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, []);
}

interface NavigateState {
  /** Where an agent asked this tab to go, until the shell has gone there. */
  target: NavigateTarget | null;
  request: (target: NavigateTarget) => void;
  done: () => void;
}

export const useNavigateRequest = create<NavigateState>((set) => ({
  target: null,
  request: (target) => set({ target }),
  done: () => set({ target: null }),
}));

/** The path a target opens. A canvas brings the nodes to show along in ?focus=. */
export function pathFor(target: NavigateTarget): string {
  switch (target.kind) {
    case "canvas":
      return target.nodeIds?.length
        ? `/canvas/${target.id}?focus=${encodeURIComponent(target.nodeIds.join(","))}`
        : `/canvas/${target.id}`;
    case "asset":
      return `/assets?${DETAIL_PARAM}=${target.id}`;
    case "path":
      return target.path;
  }
}
