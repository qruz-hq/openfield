import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

// Which version of an image's file the canvas shows. Library images never change, except an edit
// blended again with other Keep the rest settings: its file changes in place, and thumbnails are
// cached for good, so their URL carries the version (?v=, as the server's own asset URLs do). The
// canvas learns versions as it opens (assetVersions), from the event stream (asset.updated), and
// from its own re-blends.

export const imageVersions = createStore<{ v: Readonly<Record<string, string>> }>()(() => ({ v: {} }));

/** Versions for many images at once, as a canvas opens. */
export function rememberImageVersions(versions: Readonly<Record<string, string>> | undefined): void {
  if (!versions) return;
  const { v } = imageVersions.getState();
  if (Object.entries(versions).every(([id, version]) => v[id] === version)) return;
  imageVersions.setState({ v: { ...v, ...versions } });
}

/** The ?v of a URL the server gave, or null when it has none. */
export function versionInUrl(url: string): string | null {
  return /[?&]v=([^&#]+)/.exec(url)?.[1] ?? null;
}

/** An image the server sent again (an event, a re-blend's answer): its file may be a new version. */
export function noteImageVersion(asset: { id: string; thumbUrl: string }): void {
  const version = versionInUrl(asset.thumbUrl);
  if (version) rememberImageVersions({ [asset.id]: version });
}

export const imageVersionOf = (assetId: string): string | undefined => imageVersions.getState().v[assetId];

export const useImageVersion = (assetId: string | null): string | undefined =>
  useStore(imageVersions, (s) => (assetId ? s.v[assetId] : undefined));
