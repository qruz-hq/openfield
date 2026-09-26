import type { NodeRuntime } from "../../engine/types";

// The light that runs along a link while the node it feeds is generating (design YQPWR, motion
// spec IMRkA). Pure: what state a link is in, and where its pulse is at a moment of the shared
// clock. pulse-clock.ts moves the SVG; edges.tsx draws it.

export const PULSE = {
  /** Along the curve at 100% zoom (canvas units, so it scales with the view). */
  length: 72,
  /** Never more than this share of a short link. */
  maxShare: 0.45,
  /** Source port to target port, whatever the link's length. */
  travelMs: 1600,
  /** Travel plus 0.8 s of rest: one clock for the whole canvas. */
  cycleMs: 2400,
  /** More links pulsing than this and the glow goes, to keep the frame cheap. */
  glowMax: 12,
} as const;

/**
 * Idle: the plain link. Active: the node it feeds is generating, so a pulse runs along it.
 * Waiting: that node's run sits at the company (Batch), which can take hours, so the link lights
 * up without moving.
 */
export type LinkActivity = "idle" | "active" | "waiting";

/**
 * A link's state from the run state of the node it feeds (its target), so links out of a
 * generating node stay idle. Nodes waiting in line keep idle links. Only data links ask: arrows
 * are drawn by their own edge type, which has no pulse (edges.tsx).
 */
export function linkActivity(
  target: Pick<NodeRuntime, "state"> | undefined,
  atCompany: boolean,
): LinkActivity {
  const state = target?.state;
  if (state !== "running" && state !== "queued") return "idle";
  if (atCompany) return "waiting";
  return state === "running" ? "active" : "idle";
}

/** The pulse's length on a link `total` long. */
export const pulseLength = (total: number): number => Math.min(PULSE.length, PULSE.maxShare * total);

/** cubic-bezier(x1, y1, x2, y2) as a function of time, like CSS's. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton first, bisection if it wanders.
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = x(u) - t;
      if (Math.abs(err) < 1e-6) return y(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 30; i++) {
      const at = x(u);
      if (Math.abs(at - t) < 1e-6) break;
      if (at < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return y(u);
  };
}

/** The travel's easing, in and out. */
export const pulseEase = cubicBezier(0.45, 0, 0.55, 1);

/** Which cycle of the shared clock a moment falls in, and how far into it. */
export const clockAt = (now: number) => ({
  cycle: Math.floor(now / PULSE.cycleMs),
  phase: ((now % PULSE.cycleMs) + PULSE.cycleMs) % PULSE.cycleMs,
});

/**
 * Where the pulse's head is, as a distance along a link `total` long, at `phase` ms into the cycle;
 * null while it rests. The head leaves the source port's centre at 0 and the pulse is done when
 * its tail reaches the target's, so the head runs to total + length.
 */
export function pulseHead(phase: number, total: number): number | null {
  if (phase < 0 || phase >= PULSE.travelMs || total <= 0) return null;
  return pulseEase(phase / PULSE.travelMs) * (total + pulseLength(total));
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where the pulse's gradient runs, tail to head. On the link where the pulse is on it; past an end,
 * along the link's direction there, while the pulse is still coming out of the source port or
 * sinking into the target's. The ramp keeps its full length either way, so the pulse slides out
 * from under a port instead of fading in (motion spec IMRkA: no opacity fade). `at` is the link's
 * point at a distance along it (SVGPathElement.getPointAtLength).
 */
export function pulseEnds(head: number, total: number, at: (distance: number) => Point): [Point, Point] {
  return [along(head - pulseLength(total), total, at), along(head, total, at)];
}

function along(distance: number, total: number, at: (distance: number) => Point): Point {
  if (distance >= 0 && distance <= total) return at(distance);
  const before = distance < 0;
  const end = at(before ? 0 : total);
  // The link's direction at that end, from a point just inside it.
  const step = Math.min(1, total / 2);
  const inside = at(before ? step : total - step);
  const length = Math.hypot(end.x - inside.x, end.y - inside.y) || 1;
  const past = before ? -distance : distance - total;
  return {
    x: end.x + ((end.x - inside.x) / length) * past,
    y: end.y + ((end.y - inside.y) / length) * past,
  };
}
