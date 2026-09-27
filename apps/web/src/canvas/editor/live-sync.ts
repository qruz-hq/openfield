import { fromWireOps } from "@openfield/canvas/edits/wire";
import { applyOps, CanvasOpError, type DocSlice } from "@openfield/canvas/store/ops";
import { type AgentActivity, type CanvasDetail, type CanvasUpdated, t } from "@openfield/core";
import { History } from "lucide-react";
import { subscribeEvents } from "../../api/events";
import { fetchCanvas } from "../../api/hooks/canvas-doc";
import { notify } from "../../lib/notify";
import type { SelectionState } from "../store/types";
import type { EditorSession } from "./session";

// Live canvases (§7.11). A change made on the server (an agent's edits) arrives as canvas.updated:
// the document ops, and the version they lead from and to. The tab holding that version replays
// them into its own copy, outside undo, and moves to the new version, so its next save carries its
// own unsaved changes on top rather than meeting a conflict. A frame for a later version waits for
// the one before it (a save of this tab's own may be on its way); one that never comes means another
// tab saved in between, and the tab catches up from the server.

/** How long a frame waits for the version before it, and a 409 for the frames it needs. */
export const CATCH_UP_MS = 1500;

export interface LiveSync {
  /** Resolves true once this tab holds `graphVersion` (it replayed the edits that led there). */
  caughtUp(graphVersion: number, timeoutMs?: number): Promise<boolean>;
  stop(): void;
}

export interface LiveSyncDeps {
  /** The saved canvas, for catching up. Tests pass their own. */
  fetch?: (canvasId: string) => Promise<CanvasDetail>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export function startLiveSync(session: EditorSession, deps: LiveSyncDeps = {}): LiveSync {
  const load = deps.fetch ?? fetchCanvas;
  const later = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const store = session.main;
  const { canvasId } = session;
  const pending = new Map<number, CanvasUpdated>();
  const toasted = new Set<string>();
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const version = () => store.getState().persist.graphVersion;

  const replay = (frame: CanvasUpdated) => {
    const state = store.getState();
    let doc = state.doc;
    // One op at a time: an op whose node this tab has already deleted is skipped, the rest land.
    for (const op of fromWireOps(frame.ops)) {
      try {
        doc = applyOps(doc, [op]).doc;
      } catch (error) {
        if (!(error instanceof CanvasOpError)) throw error;
      }
    }
    const p = state.persist;
    // A tab with nothing unsaved now holds exactly what the server holds.
    const clean = p.status === "saved" && p.revision === p.savedRevision;
    store.setState({
      doc,
      selection: prune(state.selection, doc),
      persist: {
        ...p,
        graphVersion: frame.graphVersion,
        revision: p.revision + 1,
        savedRevision: clean ? p.revision + 1 : p.savedRevision,
        ...(clean && { lastSavedAt: frame.updatedAt }),
      },
    });
  };

  const versionSaved = (name: string, versionId: string | null | undefined) => {
    if (!versionId || toasted.has(versionId)) return;
    toasted.add(versionId);
    notify(t("canvas.agents.versionSaved", { name }), {
      icon: History,
      action: {
        label: t("canvas.agents.view"),
        onClick: () => store.getState().actions.setUi({ drawer: { panel: "versions", nodeId: null } }),
      },
    });
  };

  const landed = (frame: CanvasUpdated) => {
    if (frame.actor.kind !== "agent") return;
    if (frame.touched.length) {
      session.ui.setState({ agentTouch: { nodeIds: frame.touched, name: frame.actor.name, at: Date.now() } });
    }
    versionSaved(frame.actor.name, frame.versionId);
  };

  const catchUp = async () => {
    gapTimer = undefined;
    if (stopped || !pending.size) return;
    // This tab's own save may be what leads to the waiting version: let it land first.
    if (store.getState().persist.status === "saving") {
      gapTimer = later(() => void catchUp(), CATCH_UP_MS);
      return;
    }
    pending.clear();
    const detail = await load(canvasId).catch(() => null);
    if (stopped || !detail) return;
    const p = store.getState().persist;
    if (detail.graphVersion <= p.graphVersion || p.status === "conflict") return;
    if (p.revision === p.savedRevision && p.status !== "saving") session.reloadFrom(detail);
    else store.getState().actions.markConflict(detail);
  };

  const drain = () => {
    for (let next = pending.get(version()); next; next = pending.get(version())) {
      pending.delete(next.fromVersion);
      replay(next);
      landed(next);
    }
    for (const from of pending.keys()) if (from < version()) pending.delete(from);
    if (pending.size && !gapTimer) gapTimer = later(() => void catchUp(), CATCH_UP_MS);
  };

  const onUpdated = (frame: CanvasUpdated) => {
    // The conflict banner owns the canvas until the person picks Reload or Keep mine.
    if (store.getState().persist.status === "conflict") return;
    if (frame.fromVersion < version()) return;
    pending.set(frame.fromVersion, frame);
    drain();
  };

  const onActivity = (activity: AgentActivity) => {
    const { name, sessionId } = activity.actor;
    // Reading keeps a working agent's pill up, and doesn't raise one on its own.
    if (activity.kind === "reading") {
      const current = session.ui.getState().agent;
      if (current?.sessionId === sessionId) session.ui.setState({ agent: { ...current, at: Date.now() } });
      return;
    }
    session.ui.setState({
      agent: { name, sessionId, kind: activity.kind, nodeIds: activity.nodeIds, at: Date.now() },
    });
    versionSaved(name, activity.versionId);
  };

  const unsubscribe = subscribeEvents((event) => {
    if (event.event === "canvas.updated" && event.data.canvasId === canvasId) onUpdated(event.data);
    else if (event.event === "agent.activity" && event.data.canvasId === canvasId) onActivity(event.data);
  });
  // A version this tab moves to (its own save landing) may be the one a waiting frame leads from.
  const unsubscribeVersion = store.subscribe((next, prev) => {
    if (next.persist.graphVersion !== prev.persist.graphVersion && pending.size) drain();
  });

  return {
    caughtUp(target, timeoutMs = CATCH_UP_MS) {
      if (version() >= target) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          resolve(false);
        }, timeoutMs);
        const unsubscribe = store.subscribe((state) => {
          if (state.persist.graphVersion < target) return;
          clearTimeout(timer);
          unsubscribe();
          resolve(true);
        });
      });
    },
    stop() {
      stopped = true;
      if (gapTimer) clearTimeout(gapTimer);
      unsubscribe();
      unsubscribeVersion();
    },
  };
}

function prune(selection: SelectionState, doc: DocSlice): SelectionState {
  const nodeIds = selection.nodeIds.filter((id) => doc.nodes[id]);
  const edgeIds = selection.edgeIds.filter((id) => doc.edges[id]);
  return nodeIds.length === selection.nodeIds.length && edgeIds.length === selection.edgeIds.length
    ? selection
    : { nodeIds, edgeIds };
}
