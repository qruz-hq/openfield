import type { ModelKey } from "@openfield/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "../../lib/storage";
import type { VideoComposerValues } from "./video-values";

// What the person has set up in the Video composer (§0.3): its own store, separate from the image
// composer's, so switching pages never mixes their settings. Unset values mean "the model's own
// default". Frames are kept as an asset id only; assetThumbUrl(id) draws the tile.

export interface VideoComposerState extends VideoComposerValues {
  prompt: string;
  /** null until the person picks one; the first ready video model applies meanwhile. */
  model: ModelKey | null;
  cameraFixed: boolean;
  setPrompt: (prompt: string) => void;
  setValues: (values: VideoComposerValues) => void;
  setCameraFixed: (cameraFixed: boolean) => void;
  setStartFrame: (assetId: string | null) => void;
  setEndFrame: (assetId: string | null) => void;
  switchModel: (model: ModelKey | null, values: VideoComposerValues) => void;
}

export const useVideoComposer = create<VideoComposerState>()(
  persist(
    (set) => ({
      prompt: "",
      model: null,
      aspect: undefined,
      resolution: undefined,
      seconds: undefined,
      sound: undefined,
      cameraFixed: false,
      startFrame: undefined,
      endFrame: undefined,
      setPrompt: (prompt) => set({ prompt }),
      setValues: (values) => set(values),
      setCameraFixed: (cameraFixed) => set({ cameraFixed }),
      setStartFrame: (assetId) => set({ startFrame: assetId ? { assetId } : undefined }),
      setEndFrame: (assetId) => set({ endFrame: assetId ? { assetId } : undefined }),
      switchModel: (model, values) =>
        set({
          model,
          aspect: values.aspect,
          resolution: values.resolution,
          seconds: values.seconds,
          sound: values.sound,
        }),
    }),
    {
      name: "openfield.composer.video",
      version: 1,
      storage: safeStorage({ debounceMs: 500 }),
      partialize: ({
        prompt,
        model,
        aspect,
        resolution,
        seconds,
        sound,
        cameraFixed,
        startFrame,
        endFrame,
      }) => ({
        prompt,
        model,
        aspect,
        resolution,
        seconds,
        sound,
        cameraFixed,
        startFrame,
        endFrame,
      }),
    },
  ),
);
