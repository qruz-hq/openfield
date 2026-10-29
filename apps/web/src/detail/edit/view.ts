import type { Point } from "./mask";

// Where a pointer lands on the image. Media (../media.tsx) centres the image in its box, fits it
// (letterboxed, never past 100%), then zooms and pans it. These mirror that so a stroke lands on the
// pixel under the pointer at any zoom, and the brush cursor can be drawn at the brush's real size.

export interface Size {
  width: number;
  height: number;
}

/** Client px, as getBoundingClientRect gives them. */
export interface Box extends Size {
  left: number;
  top: number;
}

export interface Viewport {
  /** The area the image is centred in: Media's inner box, inside its inset. */
  box: Box;
  /** The image's natural size, which is the mask's. */
  image: Size;
  /** Screen px per image px; null fits the image to the box, as Media's view does. */
  zoom: number | null;
  /** How far the image's centre is panned from the box's centre, in screen px. */
  x: number;
  y: number;
}

/** Media's fit: the whole image in the box, never upscaled (§4.0). 0 until the box has a size. */
export function fitZoom(box: Size, image: Size): number {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return 0;
  return Math.min(box.width / image.width, box.height / image.height, 1);
}

/** The image's rectangle on screen, letterbox and pan included, or null before there's a layout. */
export function imageRect(viewport: Viewport): Box | null {
  const { box, image } = viewport;
  const zoom = viewport.zoom ?? fitZoom(box, image);
  if (!(zoom > 0)) return null;
  const width = image.width * zoom;
  const height = image.height * zoom;
  return {
    left: box.left + (box.width - width) / 2 + viewport.x,
    top: box.top + (box.height - height) / 2 + viewport.y,
    width,
    height,
  };
}

/**
 * A screen point as image pixels, given the image's rectangle on screen (from imageRect, or the
 * transformed element's own getBoundingClientRect). Points off the image map outside 0..size; the
 * mask clips what it paints, so a stroke can start or wander off the edge.
 */
export function screenToImage(rect: Box, image: Size, point: Point): Point {
  return {
    x: ((point.x - rect.left) * image.width) / rect.width,
    y: ((point.y - rect.top) * image.height) / rect.height,
  };
}

export function imageToScreen(rect: Box, image: Size, point: Point): Point {
  return {
    x: rect.left + (point.x * rect.width) / image.width,
    y: rect.top + (point.y * rect.height) / image.height,
  };
}

/** Screen px per image px: a 100px brush is drawn 100 × this wide. */
export const screenScale = (rect: Box, image: Size) => rect.width / image.width;
