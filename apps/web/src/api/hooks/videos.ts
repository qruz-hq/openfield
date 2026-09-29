import { useEffect, useState } from "react";
import { rawFetch } from "../raw";

// /files needs the session header, which <video src> can't send either. So a video loads with
// fetch and plays from a blob URL, same as useAuthedImage (§0.16). A tile only asks for one on
// hover or focus, never at rest: the poster (useAuthedImage on the thumbnail) carries the tile
// until then.

interface Entry {
  refs: number;
  promise: Promise<string>;
  url?: string;
  release?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();
const RELEASE_AFTER_MS = 30_000;

function acquire(path: string): Entry {
  let entry = entries.get(path);
  if (!entry) {
    const created: Entry = {
      refs: 0,
      promise: rawFetch(path).then(async (res) => {
        if (!res.ok) throw new Error(`Video ${res.status}`);
        created.url = URL.createObjectURL(await res.blob());
        return created.url;
      }),
    };
    created.promise.catch(() => entries.delete(path));
    entries.set(path, created);
    entry = created;
  }
  clearTimeout(entry.release);
  entry.refs++;
  return entry;
}

function release(path: string) {
  const entry = entries.get(path);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.release = setTimeout(() => {
    if (entry.refs > 0) return;
    entries.delete(path);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }, RELEASE_AFTER_MS);
}

export type VideoState = { status: "loading" } | { status: "ready"; src: string } | { status: "error" };

/** `path`: the video's file URL, or null to load nothing (a tile at rest, before it's hovered). */
export function useAuthedVideo(path: string | null): VideoState {
  const [state, setState] = useState<VideoState>(() => {
    const url = path ? entries.get(path)?.url : undefined;
    return url ? { status: "ready", src: url } : { status: "loading" };
  });

  useEffect(() => {
    if (!path) return;
    let live = true;
    const entry = acquire(path);
    if (entry.url) setState({ status: "ready", src: entry.url });
    else {
      setState({ status: "loading" });
      entry.promise.then(
        (src) => live && setState({ status: "ready", src }),
        () => live && setState({ status: "error" }),
      );
    }
    return () => {
      live = false;
      release(path);
    };
  }, [path]);

  return state;
}
