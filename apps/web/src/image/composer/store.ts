import type { ModelKey } from "@openfield/core";
import type { ComposerValues } from "@openfield/providers/manifest";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "../../lib/storage";

// What the person has set up in the composer. Submitting never clears it, and it survives a
// reload (§3.1). Unset values mean "the model's own default".

export interface ComposerState extends ComposerValues {
  prompt: string;
  /** null until the person picks one; the default model applies meanwhile. */
  model: ModelKey | null;
  batch: number;
  /**
   * Assets riding along as references on the next run (a feed tile's Use as reference). Not
   * persisted: an asset queued from one session may not still make sense to send after a reload.
   */
  references: string[];
  setPrompt: (prompt: string) => void;
  setBatch: (batch: number) => void;
  setValues: (values: ComposerValues) => void;
  /** Switch model with the values already carried or clamped for it. */
  switchModel: (model: ModelKey | null, values: ComposerValues, batch: number) => void;
  addReference: (assetId: string) => void;
  /** Adds several at the end, in order, skipping ones already there. */
  addReferences: (assetIds: readonly string[]) => void;
  /** Replaces them all, in this order (the library picker's Add). */
  setReferences: (assetIds: readonly string[]) => void;
  removeReference: (assetId: string) => void;
  /** Moves one to position `to`. The first is the primary reference. */
  moveReference: (assetId: string, to: number) => void;
}

export const useComposer = create<ComposerState>()(
  persist(
    (set) => ({
      prompt: "",
      model: null,
      batch: 1,
      references: [],
      setPrompt: (prompt) => set({ prompt }),
      setBatch: (batch) => set({ batch }),
      setValues: (values) => set(values),
      switchModel: (model, values, batch) =>
        set({ model, aspect: values.aspect, resolution: values.resolution, quality: values.quality, batch }),
      addReference: (assetId) =>
        set((state) =>
          state.references.includes(assetId) ? state : { references: [...state.references, assetId] },
        ),
      addReferences: (assetIds) =>
        set((state) => ({
          references: [...state.references, ...new Set(assetIds)].filter(
            (id, at, all) => all.indexOf(id) === at,
          ),
        })),
      setReferences: (assetIds) => set({ references: [...new Set(assetIds)] }),
      removeReference: (assetId) =>
        set((state) => ({ references: state.references.filter((id) => id !== assetId) })),
      moveReference: (assetId, to) =>
        set((state) => {
          if (!state.references.includes(assetId)) return state;
          const rest = state.references.filter((id) => id !== assetId);
          rest.splice(Math.max(0, Math.min(rest.length, to)), 0, assetId);
          return { references: rest };
        }),
    }),
    {
      name: "openfield.composer",
      version: 1,
      // Half a second after the last change, not on every keystroke.
      storage: safeStorage({ debounceMs: 500 }),
      partialize: ({ prompt, model, batch, aspect, resolution, quality }) => ({
        prompt,
        model,
        batch,
        aspect,
        resolution,
        quality,
      }),
    },
  ),
);
