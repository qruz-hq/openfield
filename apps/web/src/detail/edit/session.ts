import { MASK_COMPOSITE_DEFAULTS, MASK_COMPOSITE_MAX_PX, type ModelKey } from "@openfield/core";
import type { ComposerValues } from "@openfield/providers/manifest";
import { create } from "zustand";
import { type ReferenceSlice, referenceSlice } from "../../image/composer/store";
import { MAX_BRUSH_SIZE, MaskEditor, MIN_BRUSH_SIZE, type Rect } from "./mask";

// One edit in the detail view's Edit tab (§4.6): the image it's on, the mask painted over it, the
// tool in hand and what the panel asks for. Its own store, so editing never touches the composer's
// prompt, model or references. Nothing persists: an edit lasts while its image is open.
//
// The mask itself is a MaskEditor, one coverage byte per image pixel plus its own undo history. It's
// mutable, so the store holds it by reference and bumps `maskVersion` whenever it changes; what
// changed goes to the paint surface (subscribeMask), which redraws just that part of the overlay.

export type MaskTool = "pan" | "brush" | "eraser" | "lasso" | "rect";

/** What a fresh edit starts on, and what Esc goes back to. */
export const DEFAULT_TOOL: MaskTool = "brush";

/** The brush starts at this share of the image's short side: 92 px on a 1152 × 1536 photo. */
const BRUSH_SHARE = 0.08;

export const defaultBrushSize = (width: number, height: number) =>
  Math.round(Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, Math.min(width, height) * BRUSH_SHARE)));

// The brush size slider runs on a square-root scale, so the small sizes that need precision get
// most of its length: 92 px sits at 42% of it, as the design draws it.
export const BRUSH_SLIDER_STEPS = 1000;

export const sliderOfSize = (size: number) =>
  Math.round(Math.sqrt((size - MIN_BRUSH_SIZE) / (MAX_BRUSH_SIZE - MIN_BRUSH_SIZE)) * BRUSH_SLIDER_STEPS);

export const sizeOfSlider = (value: number) =>
  Math.round(MIN_BRUSH_SIZE + (MAX_BRUSH_SIZE - MIN_BRUSH_SIZE) * (value / BRUSH_SLIDER_STEPS) ** 2);

export interface MaskState {
  empty: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const NO_MASK: MaskState = { empty: true, canUndo: false, canRedo: false };

export interface EditSessionState extends ReferenceSlice {
  /** The image being edited, or null when no edit is open. */
  assetId: string | null;
  /** The mask at the image's stored size, with its undo history. */
  editor: MaskEditor | null;
  /** Goes up whenever the mask changes. */
  maskVersion: number;
  mask: MaskState;
  tool: MaskTool;
  /** Brush and eraser diameter, in image pixels. */
  brushSize: number;
  /** 0-100. */
  hardness: number;
  /** How strongly the painted area shows over the image, 0-100. */
  maskOpacity: number;
  prompt: string;
  /** null until the person picks one. Like the size settings, it carries on to the next edit. */
  model: ModelKey | null;
  /** Resolution and quality. The aspect always follows the image. */
  values: ComposerValues;
  batch: number;
  /** Keep the rest of the image: put the original back outside the mask. */
  composite: boolean;
  featherPx: number;
  expandPx: number;
  /** The server turned the image away: a phone photo stored on its side (design 6YuF99zpGo). */
  turned: boolean;
  /**
   * The mask as it was last saved for a run. While `maskVersion` still matches, Generate again
   * sends it by id instead of saving it once more.
   */
  savedMask: { version: number; assetId: string } | null;
  /**
   * Set while "Leave this edit?" is asked: what leaving does once the person agrees. Every way out
   * of an edit with a mask or a prompt goes through leaveEdit, which sets it.
   */
  leaving: (() => void) | null;

  /** Starts an edit on an image at its stored size, or keeps the one already open on it. */
  start: (assetId: string, width: number, height: number, initial?: Uint8Array) => void;
  /** Drops the edit and its mask. */
  end: () => void;
  setTool: (tool: MaskTool) => void;
  setBrushSize: (size: number) => void;
  setHardness: (hardness: number) => void;
  setMaskOpacity: (opacity: number) => void;
  setPrompt: (prompt: string) => void;
  setModel: (model: ModelKey) => void;
  setValues: (values: ComposerValues) => void;
  setBatch: (batch: number) => void;
  setComposite: (composite: boolean) => void;
  setFeatherPx: (px: number) => void;
  setExpandPx: (px: number) => void;
  setTurned: (turned: boolean) => void;
  /** Remembers the mask saved for the current `maskVersion`. */
  setSavedMask: (assetId: string, version: number) => void;
  /** Runs one change on the mask: a stroke's step, a shape, undo. `change` returns what it redrew. */
  changeMask: (change: (editor: MaskEditor) => Rect | null) => Rect | null;
  undo: () => void;
  redo: () => void;
  invert: () => void;
  clear: () => void;
}

type MaskListener = (rect: Rect | null) => void;
const maskListeners = new Set<MaskListener>();

/**
 * Called with the part of the mask that changed, or null when all of it may have (a new edit).
 * Returns the unsubscribe.
 */
export function subscribeMask(listener: MaskListener): () => void {
  maskListeners.add(listener);
  return () => maskListeners.delete(listener);
}

const maskStateOf = (editor: MaskEditor | null): MaskState =>
  editor ? { empty: editor.isEmpty(), canUndo: editor.canUndo, canRedo: editor.canRedo } : NO_MASK;

const sameMask = (a: MaskState, b: MaskState) =>
  a.empty === b.empty && a.canUndo === b.canUndo && a.canRedo === b.canRedo;

const FRESH = {
  assetId: null,
  editor: null,
  maskVersion: 0,
  mask: NO_MASK,
  tool: DEFAULT_TOOL,
  // start() sizes it to the image.
  brushSize: 92,
  prompt: "",
  composite: MASK_COMPOSITE_DEFAULTS.composite,
  featherPx: MASK_COMPOSITE_DEFAULTS.featherPx,
  expandPx: MASK_COMPOSITE_DEFAULTS.expandPx,
  turned: false,
  savedMask: null,
  leaving: null,
} satisfies Partial<EditSessionState>;

const clampPx = (px: number) => Math.round(Math.min(MASK_COMPOSITE_MAX_PX, Math.max(0, px)));

export const useEditSession = create<EditSessionState>()((set, get) => {
  const changeMask = (change: (editor: MaskEditor) => Rect | null): Rect | null => {
    const { editor, maskVersion, mask } = get();
    if (!editor) return null;
    const rect = change(editor);
    // Mid-stroke the flags wait for the stroke's end: erasing would otherwise rescan the whole
    // mask for emptiness on every pointer move.
    const next = editor.stroking ? mask : maskStateOf(editor);
    set({ maskVersion: maskVersion + 1, ...(sameMask(mask, next) ? {} : { mask: next }) });
    if (rect) for (const listener of maskListeners) listener(rect);
    return rect;
  };

  return {
    ...FRESH,
    // Hardness, the overlay's strength, the model and its sizes are the person's taste, so they
    // outlast an edit. Keep the rest starts on again with each one.
    hardness: 80,
    maskOpacity: 50,
    model: null,
    values: {},
    batch: 1,
    ...referenceSlice(set),
    start: (assetId, width, height, initial) => {
      const { editor } = get();
      if (get().assetId === assetId && editor?.mask.width === width && editor.mask.height === height) return;
      const next = new MaskEditor(width, height, initial ? { initial } : {});
      set({
        ...FRESH,
        references: [],
        assetId,
        editor: next,
        mask: maskStateOf(next),
        brushSize: defaultBrushSize(width, height),
      });
      for (const listener of maskListeners) listener(null);
    },
    end: () => set({ ...FRESH, references: [] }),
    setTool: (tool) => set({ tool }),
    setBrushSize: (brushSize) =>
      set({ brushSize: Math.round(Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, brushSize))) }),
    setHardness: (hardness) => set({ hardness: Math.round(Math.min(100, Math.max(0, hardness))) }),
    setMaskOpacity: (maskOpacity) =>
      set({ maskOpacity: Math.round(Math.min(100, Math.max(0, maskOpacity))) }),
    setPrompt: (prompt) => set({ prompt }),
    setModel: (model) => set({ model }),
    setValues: (values) => set((state) => ({ values: { ...state.values, ...values } })),
    setBatch: (batch) => set({ batch: Math.max(1, Math.round(batch)) }),
    setComposite: (composite) => set({ composite }),
    setFeatherPx: (px) => set({ featherPx: clampPx(px) }),
    setExpandPx: (px) => set({ expandPx: clampPx(px) }),
    setTurned: (turned) => set({ turned }),
    setSavedMask: (assetId, version) => set({ savedMask: { assetId, version } }),
    changeMask,
    undo: () => void changeMask((editor) => editor.undo()),
    redo: () => void changeMask((editor) => editor.redo()),
    invert: () => void changeMask((editor) => editor.apply({ type: "invert" })),
    clear: () => void changeMask((editor) => editor.apply({ type: "clear" })),
  };
});

/** Something would be lost by leaving: a painted mask, a prompt or a reference. */
export function editHasWork(state: EditSessionState = useEditSession.getState()): boolean {
  return (
    state.assetId !== null && (!state.mask.empty || state.prompt.trim() !== "" || state.references.length > 0)
  );
}

/**
 * Leaves the edit: at once when nothing would be lost, else after "Leave this edit?" agrees. The
 * dialog lives in the detail view and reads `leaving`.
 */
export function leaveEdit(then: () => void): void {
  if (editHasWork()) useEditSession.setState({ leaving: then });
  else then();
}

/** "Leave": drops the edit, then does what was asked. */
export function confirmLeave(): void {
  const then = useEditSession.getState().leaving;
  useEditSession.getState().end();
  then?.();
}

/** "Keep editing". */
export const cancelLeave = () => useEditSession.setState({ leaving: null });
