import type { ModelKey } from "@openfield/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ComposerValues } from "../../lib/controls";
import { safeStorage } from "../../lib/storage";

// What the person has set up in the composer. Submitting never clears it, and it survives a
// reload (§3.1). Unset values mean "the model's own default".

export interface ComposerState extends ComposerValues {
  prompt: string;
  /** null until the person picks one; the default model applies meanwhile. */
  model: ModelKey | null;
  batch: number;
  setPrompt: (prompt: string) => void;
  setBatch: (batch: number) => void;
  setValues: (values: ComposerValues) => void;
  /** Switch model with the values already carried or clamped for it. */
  switchModel: (model: ModelKey | null, values: ComposerValues, batch: number) => void;
}

export const useComposer = create<ComposerState>()(
  persist(
    (set) => ({
      prompt: "",
      model: null,
      batch: 1,
      setPrompt: (prompt) => set({ prompt }),
      setBatch: (batch) => set({ batch }),
      setValues: (values) => set(values),
      switchModel: (model, values, batch) =>
        set({ model, aspect: values.aspect, resolution: values.resolution, quality: values.quality, batch }),
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
