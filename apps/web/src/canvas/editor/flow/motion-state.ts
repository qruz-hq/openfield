import { useEffect, useState, useSyncExternalStore } from "react";

// Small React state shared by anything that animates on the canvas's own clock: the link pulse
// (edges.tsx) and the ring around a generating node (nodes/shell/ring.tsx). Whether the system asks
// for less motion, and the fade-out window after a running animation stops.

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True when the system asks for less motion. Follows the setting live. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/**
 * True while a motion that just stopped fades out, for `fadeMs` after `running` turns false. Set
 * during render, so the fading element stays mounted (and where it was) through the change.
 */
export function useFadeOut(running: boolean, fadeMs: number): boolean {
  const [was, setWas] = useState(running);
  const [fading, setFading] = useState(false);
  if (was !== running) {
    setWas(running);
    setFading(!running);
  }
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFading(false), fadeMs);
    return () => clearTimeout(timer);
  }, [fading, fadeMs]);
  return fading;
}
