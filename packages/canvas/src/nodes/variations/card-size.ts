import type { EngineContext } from "../../engine/types";
import type { NodeFrame, Size } from "../../store/ops";
import {
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  CARD_WIDTH,
  type CardMediaView,
  chosenRatio,
} from "../generate/card-size";
import { modelList, promptLines, type VariationsParams, variationsSpec } from "./spec";

// The Variations card's size (design njYDO). Like Generate's, the card is its images: 320 wide, and
// as tall as its grid of images at their shape (the first image's once it has one, the chosen
// aspect ratio before), kept between 180 and 480. The grid is the results grid's (web
// nodes/shell/results.tsx): one image fills the card, two sit side by side, more sit in two rows.
// Pure, so the rule is tested on its own.

/** The gap between images in the grid. */
export const GRID_GAP = 2;

/** Images one run makes, before an incoming image list runs it once per image. */
export function takesOf(p: VariationsParams): number {
  if (p.strategy === "model-list") return modelList(p).length;
  if (p.strategy === "prompt-list") return promptLines(p).length;
  return p.count;
}

/** How the grid lays out n images. */
export function gridShape(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  return { cols: 2, rows: 2 };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The card for n images of this width ÷ height. */
export function variationsBox(n: number, ratio: number): Size {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const { cols, rows } = gridShape(n);
  const cell = (CARD_WIDTH - (cols - 1) * GRID_GAP) / cols;
  const h = rows * (cell / r) + (rows - 1) * GRID_GAP;
  return { w: CARD_WIDTH, h: round(Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, h))) };
}

export interface VariationsLayout extends Size {
  /** Images it shows, or will make in one run before it has any. */
  count: number;
  /** From the first image's own size or the chosen ratio; false while a stand-in draws it. */
  exact: boolean;
}

export interface VariationsLayoutInput {
  frame: Pick<NodeFrame, "id" | "size">;
  params: Readonly<Record<string, unknown>>;
  result: { assetIds: readonly string[] } | null;
  ctx: EngineContext;
  media: CardMediaView;
}

/**
 * The card's box: the images' shape once the first one's size is known, the saved box while it
 * loads (so a reopened canvas doesn't jump), and the chosen aspect ratio before there are images.
 */
export function variationsLayout({
  frame,
  params,
  result,
  ctx,
  media,
}: VariationsLayoutInput): VariationsLayout {
  const assetIds = result?.assetIds ?? [];
  const count = assetIds.length || takesOf(variationsSpec.parseParams(params, ctx));
  const first = assetIds[0];
  const dims = first ? media.dims[first] : undefined;
  if (dims) return { ...variationsBox(count, dims.w / dims.h), count, exact: !dims.approx };
  const chosen = variationsBox(count, chosenRatio(params, ctx) ?? 1);
  if (first) return { ...(frame.size ?? chosen), count, exact: false };
  return { ...chosen, count, exact: true };
}

/** Changes when what the box rests on changes: its images, or what it will make and at what shape. */
export function variationsRestKey(
  params: Readonly<Record<string, unknown>>,
  result: { assetIds: readonly string[] } | null,
): string {
  const images = result?.assetIds ?? [];
  if (images.length) return `images:${images[0]}:${images.length}`;
  return `shape:${JSON.stringify([
    params.size ?? null,
    params.model ?? null,
    params.strategy ?? null,
    params.count ?? null,
    params.prompts ?? null,
    params.models ?? null,
  ])}`;
}

/** The box a card saves, to the hundredth of a pixel, or null until its first image's exact size is known. */
export function variationsRestBox(
  input: Omit<VariationsLayoutInput, "media">,
  media: CardMediaView,
): Size | null {
  const layout = variationsLayout({ ...input, media: { dims: media.dims, shown: {} } });
  return layout.exact ? { w: layout.w, h: layout.h } : null;
}
