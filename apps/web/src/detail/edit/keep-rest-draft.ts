import { type KeepRestState, t } from "@openfield/core";
import { useCallback, useState } from "react";
import { create } from "zustand";
import { applyKeepRest, type KeepRestSettings, saveKeepRest, useKeepRest } from "../../api/hooks/keep-rest";
import { errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import type { FixBrush, FixLayer } from "./fix-layer";
import { encodeFixes, readFixes } from "./fix-png";
import type { KeepRestValues } from "./keep-rest-preview";

export type { KeepRestValues };

// Keep the rest after a run, in the Edit tab (design wSsx3rDRlh): the switch, Sensitivity,
// Feather, Expand and touch-up strokes on a finished edit change nothing until Apply. Until then
// they're a draft, previewed on the image from the stored model result. One draft per new image,
// so picking another in the strip and coming back keeps what was moved.
//
// Off is only a view of the model's own result: the server never writes it in place, so with the
// switch off the draft can only be saved as a new image.

const TOUCH_BRUSH_SHARE = 0.04;

interface Draft extends KeepRestValues {
  /** What the library image was made with when the draft began, to tell what moved. */
  saved: KeepRestValues;
  /** The fix layer, from the stored one, once Touch up opened. Null until then. */
  fixes: FixLayer | null;
  /** Goes up with each stroke and undo, so the preview knows to draw again. */
  fixesVersion: number;
}

interface DraftState {
  drafts: Record<string, Draft>;
  /** The new image being touched up, or null. */
  touching: string | null;
  brush: FixBrush;
  /** Touch up's brush, in the original's pixels. 0 until the first edit sizes it. */
  brushSize: number;
  /** The new images an Apply or a save is on its way for. */
  busy: Record<string, "apply" | "save">;
  set: (assetId: string, state: KeepRestState, patch: Partial<Draft>) => void;
  discard: (assetId: string) => void;
  setTouching: (assetId: string | null) => void;
  setBrush: (brush: FixBrush) => void;
  setBrushSize: (size: number) => void;
  setBusy: (assetId: string, busy: "apply" | "save" | null) => void;
  /** Forgets every draft, as when the edit ends. */
  clear: () => void;
}

/** The values the library image was made with, before anything is moved. */
export const savedValues = (state: KeepRestState): KeepRestValues => ({
  keep: state.keep,
  sensitivity: state.sensitivity,
  featherPx: state.featherPx,
  expandPx: state.expandPx,
});

export const useKeepRestDrafts = create<DraftState>()((set, get) => ({
  drafts: {},
  touching: null,
  brush: "model",
  brushSize: 0,
  busy: {},
  set: (assetId, state, patch) =>
    set((s) => {
      const saved = savedValues(state);
      const draft = { ...(s.drafts[assetId] ?? { ...saved, saved, fixes: null, fixesVersion: 0 }), ...patch };
      return { drafts: { ...s.drafts, [assetId]: draft } };
    }),
  discard: (assetId) =>
    set((s) => {
      const { [assetId]: _gone, ...drafts } = s.drafts;
      return { drafts, touching: s.touching === assetId ? null : s.touching };
    }),
  setTouching: (touching) => set({ touching }),
  setBrush: (brush) => set({ brush }),
  setBrushSize: (brushSize) => set({ brushSize: Math.round(Math.max(1, Math.min(512, brushSize))) }),
  setBusy: (assetId, busy) =>
    set((s) => {
      const { [assetId]: _was, ...rest } = s.busy;
      return { busy: busy ? { ...rest, [assetId]: busy } : rest };
    }),
  clear: () => {
    if (Object.keys(get().drafts).length || get().touching) set({ drafts: {}, touching: null });
  },
}));

const movedFrom = (draft: Draft, saved: KeepRestValues) =>
  draft.keep !== saved.keep ||
  draft.sensitivity !== saved.sensitivity ||
  draft.featherPx !== saved.featherPx ||
  draft.expandPx !== saved.expandPx;

/** Something moved after a run that Apply or Discard hasn't settled yet, on any new image. */
export function anyKeepRestDraft(): boolean {
  return Object.values(useKeepRestDrafts.getState().drafts).some(
    (draft) => movedFrom(draft, draft.saved) || draft.fixes?.changed,
  );
}

/** The stored fix layer, or an empty one when none was painted. */
export type KeepRestLive = ReturnType<typeof useKeepRestLive>;

/**
 * Everything the panel's block, the compare bar and the media area need about the new image
 * `assetId` compares: what the server says can be adjusted, the draft over it, and the actions.
 */
export function useKeepRestLive(assetId: string | null) {
  const query = useKeepRest(assetId);
  const state = query.data;
  const draft = useKeepRestDrafts((s) => (assetId ? s.drafts[assetId] : undefined));
  const touching = useKeepRestDrafts((s) => assetId !== null && s.touching === assetId);
  const busy = useKeepRestDrafts((s) => (assetId ? s.busy[assetId] : undefined));
  const [loadingFixes, setLoadingFixes] = useState(false);

  const available = state?.available === true;
  const saved = state ? savedValues(state) : null;
  const values: KeepRestValues | null = draft ?? saved;
  const strokes = draft?.fixes?.changed ?? false;
  const moved = !!draft && !!saved && movedFrom(draft, saved);
  const pending = available && (moved || strokes);

  const set = useCallback(
    (patch: Partial<KeepRestValues>) => {
      if (!assetId || !state?.available) return;
      useKeepRestDrafts.getState().set(assetId, state, patch);
    },
    [assetId, state],
  );

  const discard = useCallback(() => {
    if (assetId) useKeepRestDrafts.getState().discard(assetId);
  }, [assetId]);

  /** Touch up: the stored fix layer first, so the strokes add to it rather than replace it. */
  const startTouch = useCallback(async () => {
    if (!assetId || !state?.available) return;
    const store = useKeepRestDrafts.getState();
    // The brush starts at 4% of the short side, half the mask brush's: touching up is finer work.
    if (!store.brushSize && state.base)
      store.setBrushSize(Math.min(state.base.width, state.base.height) * TOUCH_BRUSH_SHARE);
    if (!store.drafts[assetId]?.fixes) {
      setLoadingFixes(true);
      try {
        const { width, height } = state.base ?? { width: 0, height: 0 };
        const fixes = await readFixes(state.fixesUrl, width, height);
        useKeepRestDrafts.getState().set(assetId, state, { fixes });
      } catch {
        notifyError(t("keepRest.failed"));
        return;
      } finally {
        setLoadingFixes(false);
      }
    }
    useKeepRestDrafts.getState().setTouching(assetId);
  }, [assetId, state]);

  const endTouch = useCallback(() => useKeepRestDrafts.getState().setTouching(null), []);

  /** Apply: the kept version made again with the draft, in place. Only with the switch on. */
  const apply = useCallback(async () => {
    if (!assetId || !state?.available || !draft?.keep) return;
    const store = useKeepRestDrafts.getState();
    if (store.busy[assetId]) return;
    store.setBusy(assetId, "apply");
    try {
      const settings: KeepRestSettings = {
        ...(!state.keep && { keep: true }),
        ...(draft.sensitivity !== state.sensitivity && { sensitivity: draft.sensitivity }),
        ...(draft.featherPx !== state.featherPx && { featherPx: draft.featherPx }),
        ...(draft.expandPx !== state.expandPx && { expandPx: draft.expandPx }),
      };
      const fixes = draft.fixes?.changed ? await encodeFixes(draft.fixes) : undefined;
      await applyKeepRest(assetId, settings, fixes);
      useKeepRestDrafts.getState().discard(assetId);
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      useKeepRestDrafts.getState().setBusy(assetId, null);
    }
  }, [assetId, state, draft]);

  /**
   * Save as new image: the model's own result, with the original put back under any "use the
   * original" strokes. With the switch off that was the draft, so it's settled.
   */
  const save = useCallback(
    async (onOpen?: (id: string) => void) => {
      if (!assetId || !state?.available) return;
      const store = useKeepRestDrafts.getState();
      if (store.busy[assetId]) return;
      store.setBusy(assetId, "save");
      try {
        const fixes = draft?.fixes?.changed ? await encodeFixes(draft.fixes) : undefined;
        const out = await saveKeepRest(assetId, fixes);
        if (draft && !draft.keep) useKeepRestDrafts.getState().discard(assetId);
        notify(t(out.existing ? "edit.keep.savedAlready" : "edit.keep.savedNew"), {
          ...(onOpen && { action: { label: t("edit.keep.openSaved"), onClick: () => onOpen(out.asset.id) } }),
        });
      } catch (error) {
        notifyError(errorMessage(error));
      } finally {
        useKeepRestDrafts.getState().setBusy(assetId, null);
      }
    },
    [assetId, state, draft],
  );

  return {
    state,
    available,
    /** The values shown: the draft's, else the library image's. */
    values,
    draft,
    pending,
    strokes,
    touching,
    busy,
    loadingFixes,
    set,
    discard,
    apply,
    save,
    startTouch,
    endTouch,
  };
}
