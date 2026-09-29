import { cn } from "@openfield/ui";
import { useMemo, useRef } from "react";
import { useFadeOut, useReducedMotion } from "../../editor/flow/motion-state";
import { firstLanding, type LinkActivity, linkActivity } from "../../editor/flow/pulse";
import { useNodeRuntime } from "../../store/context";
import { useCompanyWait } from "./company-wait";

// The light around a generating node (design ULrpL "Circling", Put28 "Still (reduced motion)",
// screen v74jhh): once the edge pulse feeding it lands, it keeps going around the card's outline
// instead of stopping at the port. Fades out like the pulse when the run ends (FADE_MS, edges.tsx).

/** How long the ring fades where it is when the run ends (matches the link pulse's FADE_MS). */
const FADE_MS = 200;

/** The node's own run state, read the same way a link into it reads its target (pulse.ts). */
function useCardActivity(id: string): LinkActivity {
  const state = useNodeRuntime(id)?.state;
  const wait = useCompanyWait(id);
  return linkActivity(state ? { state } : undefined, wait !== null);
}

export type RingLook = "none" | "still" | "circling";

/**
 * What the ring shows, the same rule a link into the node uses for its own line (edges.tsx's
 * `look`): active and not reduced circles; waiting at the company, or reduced motion, is the still
 * outline either way; idle is nothing.
 */
export function ringLook(activity: LinkActivity, reduced: boolean): RingLook {
  if (activity === "idle") return "none";
  if (activity === "waiting" || reduced) return "still";
  return "circling";
}

/**
 * Sits outside the card, like the selection and drop-target rings below it in node-shell.tsx, so
 * the same markup rings a full-bleed image card and a panel alike. Waiting at the company, or under
 * reduced motion, it's the plain outline (of-ring-still); idle, nothing.
 */
export function NodeRing({ id }: { id: string }) {
  const activity = useCardActivity(id);
  const reduced = useReducedMotion();
  const look = ringLook(activity, reduced);
  const running = look !== "none";
  const circling = look === "circling";
  const runId = useNodeRuntime(id)?.runId ?? null;
  // A new run waits for its own first pulse to land before it starts circling, same as the voxel
  // swarm's first puff (voxel-field.tsx) - so the lap always starts where the light arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the run starting, not the clock.
  const delayMs = useMemo(() => {
    if (!circling) return 0;
    const now = performance.now();
    return firstLanding(now) - now;
  }, [circling, runId]);
  const fading = useFadeOut(running, FADE_MS);
  // Freezes which look the fade-out keeps, instead of jumping to the other ring style mid-fade.
  const lastCircling = useRef(circling);
  if (running) lastCircling.current = circling;
  if (!running && !fading) return null;
  const show = running ? circling : lastCircling.current;
  return (
    <div
      aria-hidden
      className={cn(
        "of-ring pointer-events-none absolute -inset-2 rounded-16",
        show ? "of-ring-circling" : "of-ring-still",
        !running && "of-ring-out",
      )}
      style={
        show
          ? { animationDelay: `${delayMs}ms`, animationPlayState: running ? "running" : "paused" }
          : undefined
      }
    />
  );
}
