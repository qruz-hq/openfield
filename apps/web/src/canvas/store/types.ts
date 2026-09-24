import type { CanvasDetail } from "@openfield/core";
import type { CanvasDocument, CanvasViewport } from "@openfield/core/canvas";
import type { NodeRuntime, PortType, RunController } from "../engine/types";
import type { DocMeta } from "./document";
import type { CanvasFragment } from "./graph";
import type { History, PushOptions } from "./history";
import type { CanvasOp, DocSlice, Point } from "./ops";

// The canvas store's shape: the contract the editor and the nodes both code against.
// One store per open canvas (a version preview gets its own, read-only). Slices:
//   doc          the document, normalized. Changes only through actions.apply (undoable, saved).
//   viewport     saved with the document, but panning never makes an undo entry.
//   persist      autosave bookkeeping (§7.8).
//   history      undo and redo.
//   selection    what's selected. UI only.
//   ui           tools, menus, drawers, level of detail. UI only.
//   runtime      live run state per node, from the server. Never saved.
//   fingerprints per node, computed by the engine. Never saved.
//   missingAssets images the document names that aren't in this library. Never saved.

export type SaveStatus = "saved" | "dirty" | "saving" | "offline" | "conflict" | "failed";

/** Why a save was refused for good: trying again the same way would fail the same way. */
export type SaveFailure = "deleted" | "too_big" | "refused";

export interface PersistState {
  /** The server's optimistic-concurrency token, sent with every PATCH. */
  graphVersion: number;
  /** Bumped by every document change. */
  revision: number;
  /** The revision the server last confirmed. */
  savedRevision: number;
  /** Bumped by pans and zooms, which save lazily. */
  viewRevision: number;
  savedViewRevision: number;
  status: SaveStatus;
  /** The server's copy after a 409, for Reload or Keep mine. */
  conflict: CanvasDetail | null;
  /** Set with status "failed". The next change tries again. */
  failure: SaveFailure | null;
  lastSavedAt: string | null;
}

export type CanvasTool = "select" | "pan" | "note" | "shape" | "text" | "frame";

/** Level of detail by zoom (§7.10): full ≥ 40%, a title and thumbnail card ≥ 20%, a flat rectangle below. */
export type LodBucket = "full" | "card" | "rect";

export const lodForZoom = (zoom: number): LodBucket => (zoom >= 0.4 ? "full" : zoom >= 0.2 ? "card" : "rect");

/** A connection being dragged, so ports can brighten or dim while it's in flight (§7.6). */
export interface PendingConnection {
  nodeId: string;
  handleId: string;
  handleType: "source" | "target";
  portType: PortType;
}

/** The add-node menu, anchored where it was opened. With `pending`, it's the drop-on-empty menu. */
export interface AddMenuState {
  /** Where the node goes, in pane coordinates. */
  flowPosition: Point;
  /** Where the menu opens, in screen pixels: its top-left, or with `above` its bottom-left. */
  screenPosition: Point;
  pending: PendingConnection | null;
  /** Opened from the toolbar or A: it sits above the toolbar, clear of the + that opened it. */
  above?: boolean;
}

export type DrawerPanel = "inspector" | "versions";

export interface CanvasUiState {
  tool: CanvasTool;
  lod: LodBucket;
  addMenu: AddMenuState | null;
  connecting: PendingConnection | null;
  /** The right-side drawer: the node inspector or version history (§7.11 drawer host). */
  drawer: { panel: DrawerPanel; nodeId: string | null } | null;
  findOpen: boolean;
  minimapOpen: boolean;
  shortcutsOpen: boolean;
  /** A node whose label is being renamed in place. */
  renamingNodeId: string | null;
  /** A version preview: every document change is refused. */
  readOnly: boolean;
}

export interface SelectionState {
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}

export interface ApplyOptions extends PushOptions {
  /** false: change the document without an undo entry (a finished run reconciled on load). */
  history?: boolean;
  /** Replace the selection after the change, e.g. with pasted nodes. */
  select?: Partial<SelectionState>;
}

export type ApplyResult =
  | { ok: true }
  /** A node with a run in flight can't be deleted or moved out of its frame (§7.7). */
  | { ok: false; reason: "running"; nodeIds: string[] }
  | { ok: false; reason: "read_only" }
  | { ok: false; reason: "invalid"; message: string };

export type FrameDeleteMode = "with-contents" | "frame-only";

/** Pane moves the editor owns (React Flow's instance lives there). Installed on mount. */
export interface ViewController {
  readonly ready: boolean;
  /** Centres a node at the current zoom, never zooming past 100% (Find, "Jump to node"). */
  focusNode(nodeId: string): void;
  /** Zoom to fit (⇧1): fitView with padding 0.15. */
  fitView(): void;
  /** Screen pixels to pane coordinates, for menus opened from outside the pane. */
  screenToFlow(point: Point): Point;
  /**
   * Pans, at the same zoom, just enough to bring the node clear of the chrome (and any extra
   * insets, like the open drawer). Nothing moves when it's already in view.
   */
  revealNode(nodeId: string, insets?: Partial<Record<"top" | "right" | "bottom" | "left", number>>): void;
  /** True when the node's box is at least partly on screen. */
  isNodeVisible(nodeId: string): boolean;
}

export const NOOP_VIEW_CONTROLLER: ViewController = {
  ready: false,
  focusNode: () => {},
  fitView: () => {},
  screenToFlow: (point) => point,
  revealNode: () => {},
  isNodeVisible: () => true,
};

export interface CanvasActions {
  // Document
  apply(ops: readonly CanvasOp[], opts?: ApplyOptions): ApplyResult;
  undo(): ApplyResult | null;
  redo(): ApplyResult | null;
  /** Ends a coalescing gesture so the next change starts a new undo entry. */
  sealHistory(): void;
  clearHistory(): void;
  /** Deletes nodes with their edges. Frames take their contents too, or hand them to their own frame. */
  deleteNodes(ids: readonly string[], mode?: FrameDeleteMode): ApplyResult;
  deleteEdges(ids: readonly string[]): ApplyResult;
  /** ⌘D and ⌥-drag: copies offset by +24/+24, selected. Returns the new ids. */
  duplicateNodes(ids: readonly string[], offset?: Point): string[];
  /** Paste: fresh ids, top-level nodes offset or moved so the fragment's top-left lands at `at`. */
  insertFragment(fragment: CanvasFragment, place: { offset: Point } | { at: Point }): string[];
  // Viewport and selection
  setViewport(viewport: CanvasViewport): void;
  setSelection(selection: Partial<SelectionState>): void;
  selectAll(): void;
  clearSelection(): void;
  // UI
  setUi(patch: Partial<CanvasUiState>): void;
  openAddMenu(menu: AddMenuState): void;
  closeAddMenu(): void;
  openInspector(nodeId: string): void;
  closeDrawer(): void;
  // Engine
  /** Merges partial runtime per node; null clears a node back to idle. */
  setRuntime(updates: Readonly<Record<string, Partial<NodeRuntime> | null>>): void;
  setFingerprints(next: Readonly<Record<string, string>>): void;
  installRunController(controller: RunController): void;
  installViewController(controller: ViewController): void;
  /** Images the canvas names that aren't in the library (placeholders, never sent). */
  setMissingAssets(ids: ReadonlySet<string>): void;
  // Persistence
  /** Loads (or reloads) the server's copy. Clears history and selection; runs carry on. */
  loadDetail(detail: CanvasDetail): void;
  /** The document to PATCH, with the revisions it covers. */
  snapshot(): { document: CanvasDocument; revision: number; viewRevision: number; graphVersion: number };
  markSaving(): void;
  markSaved(saved: { graphVersion: number; updatedAt: string; revision: number; viewRevision: number }): void;
  markOffline(): void;
  /** A save the server refused for a reason that won't pass by waiting. */
  markFailed(failure: SaveFailure): void;
  markConflict(server: CanvasDetail): void;
  /** Keep mine: adopt the server's version token so the next save overwrites it. */
  keepMine(): void;
}

export interface CanvasState {
  canvasId: string;
  doc: DocSlice;
  docMeta: DocMeta;
  viewport: CanvasViewport;
  persist: PersistState;
  history: History;
  selection: SelectionState;
  ui: CanvasUiState;
  runtime: Readonly<Record<string, NodeRuntime>>;
  fingerprints: Readonly<Record<string, string>>;
  missingAssets: ReadonlySet<string>;
  runController: RunController;
  viewController: ViewController;
  actions: CanvasActions;
}
