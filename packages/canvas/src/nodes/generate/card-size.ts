import type { AspectRatio, SizeSpec } from "@openfield/core";
import { modelKeyOf } from "../../engine/inputs";
import type { EngineContext } from "../../engine/types";
import type { NodeFrame, Size } from "../../store/ops";
import { readModel, readSize } from "../params";
import { resolveFor } from "./settings";

// The Generate card's size (design Y5jjx, height rule SwytB). The card is the image: 320 wide and
// 320 ÷ ratio tall, kept between 180 and 480. Past either limit the height stays at the limit and
// the width follows the ratio, from 240 to 480. Only ratios beyond both limits (1:4, 4:1…) show the
// whole image inside the card instead of filling it. Pure, so the rule is tested on its own.

export const CARD_WIDTH = 320;
export const CARD_MIN_HEIGHT = 180;
export const CARD_MAX_HEIGHT = 480;
export const CARD_MIN_WIDTH = 240;
export const CARD_MAX_WIDTH = 480;
/** Below this width the bottom bar stacks the prompt over Run (design tG2C4). */
export const CARD_NARROW_BELOW = 300;
/** Below this height a message state cuts the prompt at one line (design VgxbW). */
export const CARD_SHORT_BELOW = 240;

export interface CardBox extends Size {
  /** The image is wider or taller than the card can get: show all of it rather than fill. */
  contain: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The card for an image of this width ÷ height. */
export function cardBox(ratio: number): CardBox {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const h = CARD_WIDTH / r;
  if (h > CARD_MAX_HEIGHT || h < CARD_MIN_HEIGHT) {
    const height = h > CARD_MAX_HEIGHT ? CARD_MAX_HEIGHT : CARD_MIN_HEIGHT;
    const want = height * r;
    const w = clamp(want, CARD_MIN_WIDTH, CARD_MAX_WIDTH);
    return { w, h: height, contain: w !== want };
  }
  return { w: CARD_WIDTH, h, contain: false };
}

/** "3:4" as 0.75. Auto and anything unreadable give null. */
export function aspectRatioValue(aspect: AspectRatio | string | undefined | null): number | null {
  if (!aspect || aspect === "auto") return null;
  const [w, h] = aspect.split(":").map(Number);
  return w && h && w > 0 && h > 0 ? w / h : null;
}

/** The shape a node asks for before it has an image: its aspect ratio, or the model's default. */
export function chosenRatio(params: Readonly<Record<string, unknown>>, ctx: EngineContext): number | null {
  const size = readSize(params.size) as SizeSpec | undefined;
  if (size?.kind === "pixels") return size.width / size.height;
  const model = ctx.model(modelKeyOf(readModel(params.model), ctx));
  const aspect = model
    ? resolveFor(model, { size }, 1).aspect
    : size?.kind === "aspect"
      ? size.ratio
      : undefined;
  return aspectRatioValue(aspect);
}

/** An image's pixel size. `approx`: read off a thumbnail, so only good for drawing. */
export interface ImageSize {
  w: number;
  h: number;
  approx?: true;
}

/** Images already seen, and which of a node's images it shows (the pager). */
export interface CardMediaView {
  dims: Readonly<Record<string, ImageSize>>;
  shown: Readonly<Record<string, string>>;
}

/** Which of `assetIds` the card shows: the one picked with the pager while it's still there, else the first. */
export function shownIndex(media: CardMediaView, nodeId: string, assetIds: readonly string[]): number {
  const picked = media.shown[nodeId];
  const at = picked ? assetIds.indexOf(picked) : -1;
  return at >= 0 ? at : 0;
}

export interface CardLayout extends CardBox {
  /** The image on show, if the node has one. */
  assetId: string | null;
  index: number;
  count: number;
  /**
   * The box comes from the image's own size or the chosen ratio. False while the saved box stands
   * in (the size hasn't arrived) or a thumbnail's rounded size does: good for drawing, not saving.
   */
  exact: boolean;
  narrow: boolean;
  short: boolean;
}

export interface CardLayoutInput {
  frame: Pick<NodeFrame, "id" | "size">;
  params: Readonly<Record<string, unknown>>;
  result: { assetIds: readonly string[] } | null;
  ctx: EngineContext;
  media: CardMediaView;
}

/**
 * The card's box: the shown image's shape once its size is known, the saved box while it loads (so
 * a reopened canvas doesn't jump), and the chosen aspect ratio before there's an image. Auto is
 * square until the first image arrives.
 */
export function cardLayout({ frame, params, result, ctx, media }: CardLayoutInput): CardLayout {
  const assetIds = result?.assetIds ?? [];
  const index = shownIndex(media, frame.id, assetIds);
  const assetId = assetIds[index] ?? null;
  const dims = assetId ? media.dims[assetId] : undefined;
  let box: CardBox;
  let exact = true;
  if (dims) {
    box = cardBox(dims.w / dims.h);
    exact = !dims.approx;
  } else if (assetId) {
    // The image's size is on its way: the saved box stands in, or the chosen ratio without one.
    box = frame.size
      ? { w: frame.size.w, h: frame.size.h, contain: false }
      : cardBox(chosenRatio(params, ctx) ?? 1);
    exact = false;
  } else box = cardBox(chosenRatio(params, ctx) ?? 1);
  return {
    ...box,
    assetId,
    index,
    count: assetIds.length,
    exact,
    narrow: box.w < CARD_NARROW_BELOW,
    short: box.h < CARD_SHORT_BELOW,
  };
}

/**
 * What a card's saved size follows: its first image (the pager's pick is only for looking), or
 * before one the settings that pick its shape. Document fields only, so the model list loading or
 * a thumbnail arriving never reads as a change.
 */
export function restKey(
  params: Readonly<Record<string, unknown>>,
  result: { assetIds: readonly string[] } | null,
): string {
  const first = result?.assetIds[0];
  return first ? `image:${first}` : `shape:${JSON.stringify([params.size ?? null, params.model ?? null])}`;
}

/** The box a card saves, to the hundredth of a pixel, or null until its image's exact size is known. */
export function restBox(input: Omit<CardLayoutInput, "media">, media: CardMediaView): Size | null {
  const layout = cardLayout({ ...input, media: { dims: media.dims, shown: {} } });
  if (!layout.exact) return null;
  return { w: Math.round(layout.w * 100) / 100, h: Math.round(layout.h * 100) / 100 };
}

/**
 * The card's box from the document and the library's image sizes, without a browser: its first
 * image's shape once that's known, else its saved box, else the chosen ratio. To the hundredth of a
 * pixel, like the size the editor saves (restBox).
 */
export function imageCardBox(input: Omit<CardLayoutInput, "media">, images: CardMediaView["dims"]): Size {
  const layout = cardLayout({ ...input, media: { dims: images, shown: {} } });
  return { w: Math.round(layout.w * 100) / 100, h: Math.round(layout.h * 100) / 100 };
}
