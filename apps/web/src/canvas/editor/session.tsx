import type { CanvasDetail, CanvasVersion } from "@openfield/core";
import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Point } from "../store";
import type { CanvasStore } from "../store/store";
import type { CanvasState } from "../store/types";
import type { Autosave } from "./autosave";
import type { Guide } from "./geometry";
import type { PreviewCapture } from "./preview-capture";

// One editor session per open canvas. It holds what outlives a single React Flow instance: the
// canvas's own store (`main`), autosave, and the editor's chrome state (find, dialogs, version
// preview). While a version is previewed, the pane shows a second, read-only store; `main` keeps
// saving and running underneath.

export interface VersionPreview {
  version: CanvasVersion;
  store: CanvasStore;
}

export interface EditorUiState {
  /** An annotation arrow is being dragged: every node shows its arrow targets. */
  annotationConnecting: boolean;
  findQuery: string;
  findIndex: number;
  /** The Find match in focus, ringed on the pane. */
  findHit: string | null;
  /** Frames picked for delete that still hold nodes: ask what happens to them. */
  frameDelete: readonly string[] | null;
  deleteCanvasOpen: boolean;
  saveVersionOpen: boolean;
  renamingCanvas: boolean;
  /** The last pointer position over the pane, in pane units, for paste. */
  pointer: Point | null;
  /** Consecutive pastes of one copy step down and right. */
  paste: { key: string; at: Point; count: number } | null;
  preview: VersionPreview | null;
  /** A port picked with Enter, waiting for the port it connects to (keyboard connections). */
  keyboardConnect: { nodeId: string; handleId: string; type: "source" | "target" } | null;
  /** Bumped when the document is replaced wholesale, so React Flow starts over with it. */
  flowKey: number;
  /** Alignment guides while a drag lines up with a neighbour (§7.9). */
  guides: readonly Guide[];
}

export const createEditorUi = (): StoreApi<EditorUiState> =>
  createStore<EditorUiState>()(() => ({
    annotationConnecting: false,
    findQuery: "",
    findIndex: 0,
    findHit: null,
    frameDelete: null,
    deleteCanvasOpen: false,
    saveVersionOpen: false,
    renamingCanvas: false,
    pointer: null,
    paste: null,
    preview: null,
    keyboardConnect: null,
    flowKey: 0,
    guides: [],
  }));

export interface EditorSession {
  canvasId: string;
  main: CanvasStore;
  ui: StoreApi<EditorUiState>;
  autosave: Autosave;
  /** The index card picture, refreshed after saves (M4-15). */
  capture: PreviewCapture;
  /** Replaces the canvas with the server's copy (Reload, Restore) and starts the pane over. */
  reloadFrom(detail: CanvasDetail): void;
  previewVersion(version: CanvasVersion): Promise<void>;
  exitPreview(): void;
  restoreVersion(versionId: string): Promise<void>;
  /** Saves what's pending, then asks the server for a snapshot of that (before a big delete). */
  snapshot(kind: "before_delete"): Promise<void>;
}

const SessionContext = createContext<EditorSession | null>(null);

export function EditorSessionProvider({
  session,
  children,
}: {
  session: EditorSession;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): EditorSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs an EditorSessionProvider");
  return session;
}

export function useEditorUi<T>(selector: (state: EditorUiState) => T): T {
  return useStore(useSession().ui, selector);
}

const NO_UI = createEditorUi();

/** For parts other agents render (node shells): works outside an editor session too. */
export function useEditorUiOptional<T>(selector: (state: EditorUiState) => T): T {
  const session = useContext(SessionContext);
  return useStore(session?.ui ?? NO_UI, selector);
}

/** The canvas's own store, even while a version preview has the pane. */
export function useMain<T>(selector: (state: CanvasState) => T): T {
  return useStore(useSession().main, selector);
}
