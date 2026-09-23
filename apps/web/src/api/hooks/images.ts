import { useEffect, useState } from "react";
import { rawFetch } from "../raw";

// /files needs the session header, which <img src> can't send. So images load with fetch and
// show from a blob URL. Each URL is fetched once and freed a little after its last viewer leaves.

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
        if (!res.ok) throw new Error(`Image ${res.status}`);
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

export type ImageState = { status: "loading" } | { status: "ready"; src: string } | { status: "error" };

export function useAuthedImage(path: string | null): ImageState {
  const [state, setState] = useState<ImageState>(() => {
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
