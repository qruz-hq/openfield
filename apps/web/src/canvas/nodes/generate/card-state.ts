import type { CanvasNodeState } from "@openfield/core";

// What each state of the Generate card shows (design A0Fi5O, "Hover by state"). Pure, so every row
// of the table is tested. At rest the card is its image, label and ports, with a pill only when the
// state needs attention; on hover, focus or as the only node selected the top bar (pill, menu) and
// the bottom bar (prompt and its action) show over it. A locked card (design zbJ7h) is its images
// with a Locked pill on hover and nothing to run.

export type CardPhase =
  | "empty"
  | "waiting"
  | "atCompany"
  | "generating"
  | "done"
  | "changed"
  | "failed"
  | "blocked"
  | "canceled"
  | "locked";

/** How the image sits in the card: as is, at 50% (a run over it), at 60% (out of date), or none. */
export type CardMedia = "image" | "dimmed" | "faded" | "placeholder";

export interface CardView {
  phase: CardPhase;
  /** The status pill shows at rest, not only on hover. */
  pillAtRest: boolean;
  /** No pill at all: nothing to say yet. */
  noPill: boolean;
  media: CardMedia;
  /** The glyph and ratio (or a wait note) in the middle of a placeholder. */
  emptyGlyph: boolean;
  /**
   * The voxel swarm over the card (voxel/voxel-field.tsx): it runs while generating and idles while
   * waiting, in place of the glyph and ratio. A wait at the company keeps its note over it.
   */
  voxels: "active" | "idle" | null;
  /** Failed, blocked and canceled say so in the middle, with their action. */
  message: boolean;
  /** Next to the prompt: Run, Stop (running), Cancel (queued), or nothing (the message acts). */
  action: "run" | "stop" | "cancel" | null;
  /** The bottom bar shows without hover (Empty: Run is the next step). */
  bottomAtRest: boolean;
  progress: boolean;
  stripes: boolean;
  /** The pill is long enough to drop to its icon on a narrow card while the pager's arrows show. */
  longPill: boolean;
}

export interface CardStateInput {
  state: CanvasNodeState;
  /** It has images from a run (the last good ones stay after a failure). */
  images: boolean;
  /** Its run waits at the company (Batch): no timer, no progress. */
  atCompany: boolean;
  /** A preview frame of the image being made has arrived. */
  partial: boolean;
  /** The browser can draw the voxel swarm (WebGL); without it the card keeps its glyph. */
  voxels?: boolean;
  /** Locked: it keeps its images and never runs (§7.9). A run already under way still shows. */
  locked?: boolean;
}

export function cardView({
  state,
  images,
  atCompany,
  partial,
  voxels = false,
  locked = false,
}: CardStateInput): CardView {
  const base: CardView = {
    phase: "empty",
    pillAtRest: true,
    noPill: false,
    media: images ? "dimmed" : "placeholder",
    emptyGlyph: !images,
    voxels: null,
    message: false,
    action: "run",
    bottomAtRest: false,
    progress: false,
    stripes: false,
    longPill: false,
  };
  if (locked && state !== "queued" && state !== "running") {
    return images
      ? { ...base, phase: "locked", pillAtRest: false, media: "image", emptyGlyph: false, action: null }
      : { ...emptyView(base), phase: "locked", noPill: false, action: null, bottomAtRest: false };
  }
  switch (state) {
    case "queued":
    case "running": {
      const idle = voxels ? ("idle" as const) : null;
      if (atCompany) return { ...base, phase: "atCompany", action: "cancel", longPill: true, voxels: idle };
      if (state === "queued") {
        return {
          ...base,
          phase: "waiting",
          action: "cancel",
          longPill: true,
          voxels: idle,
          emptyGlyph: base.emptyGlyph && !voxels,
        };
      }
      // A preview frame of the new image dims like the last image does under a run (OPInN), so
      // Generating looks the same whether or not the model sends previews.
      const shown = images || partial;
      return {
        ...base,
        phase: "generating",
        media: shown ? "dimmed" : "placeholder",
        emptyGlyph: !shown && !voxels,
        voxels: voxels ? "active" : null,
        action: "stop",
        progress: true,
        longPill: true,
      };
    }
    case "blocked":
      return { ...base, phase: "blocked", emptyGlyph: false, message: true, action: null, stripes: true };
    case "failed":
      return { ...base, phase: "failed", emptyGlyph: false, message: true, action: null };
    case "canceled":
      return { ...base, phase: "canceled", emptyGlyph: false, message: true, action: null };
    case "done":
      return images
        ? { ...base, phase: "done", pillAtRest: false, media: "image", emptyGlyph: false }
        : emptyView(base);
    case "stale":
      return images
        ? { ...base, phase: "changed", media: "faded", emptyGlyph: false, longPill: true }
        : emptyView(base);
    default:
      return images
        ? { ...base, phase: "done", pillAtRest: false, media: "image", emptyGlyph: false }
        : emptyView(base);
  }
}

function emptyView(base: CardView): CardView {
  return {
    ...base,
    phase: "empty",
    pillAtRest: false,
    noPill: true,
    media: "placeholder",
    emptyGlyph: true,
    bottomAtRest: true,
  };
}

/** Scrims go only over an image; placeholders keep both bars clear. */
export const hasScrim = (view: Pick<CardView, "media">) => view.media !== "placeholder";
