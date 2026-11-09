import { type MarkDrawing, ProviderError, type StoredAsset } from "@openfield/providers/server";
import { loadSharp } from "./sharp";

// Shapes drawn onto an image for one call, for a model that reads them off the picture (Seedream's
// sketch edits). Points are fractions of the image as it's shown, so it's turned upright first.
// Nothing is saved: the drawn copy only goes to the company.

/** The drawings as an SVG the image's size, for sharp to lay over it. Pure, so tests read it. */
export function marksSvg(drawings: readonly MarkDrawing[], width: number, height: number): string {
  const short = Math.min(width, height);
  const px = (p: { x: number; y: number }) => [round(p.x * width), round(p.y * height)] as const;
  const shapes = drawings.map((d) => {
    const line = Math.max(2, round(d.width * short));
    const paint = `stroke="${d.color}" stroke-width="${line}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
    if (d.kind === "circle") {
      const [x1, y1] = px(d.points[0]!);
      const [x2, y2] = px(d.points[1] ?? d.points[0]!);
      const rx = Math.max(line, Math.abs(x2 - x1) / 2);
      const ry = Math.max(line, Math.abs(y2 - y1) / 2);
      return `<ellipse cx="${(x1 + x2) / 2}" cy="${(y1 + y2) / 2}" rx="${rx}" ry="${ry}" ${paint}/>`;
    }
    if (d.kind === "stroke") {
      const points = d.points.map((p) => px(p).join(",")).join(" ");
      return `<polyline points="${points}" ${paint}/>`;
    }
    // An arrow: the shaft, then a filled head at the second point.
    const [x1, y1] = px(d.points[0]!);
    const [x2, y2] = px(d.points[1] ?? d.points[0]!);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = line * 4;
    const wing = (side: number) =>
      [round(x2 - head * Math.cos(angle + side * 0.5)), round(y2 - head * Math.sin(angle + side * 0.5))].join(
        ",",
      );
    return (
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${paint}/>` +
      `<polygon points="${x2},${y2} ${wing(1)} ${wing(-1)}" fill="${d.color}" stroke="${d.color}" stroke-width="${line}" stroke-linejoin="round"/>`
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}</svg>`;
}

/** The image, upright, with the shapes drawn on, in its own format (a JPEG stays a JPEG). */
export async function drawMarks(source: StoredAsset, drawings: readonly MarkDrawing[]): Promise<StoredAsset> {
  const sharp = await loadSharp().catch((err: unknown) => {
    throw new ProviderError("provider_error", {
      message: "Couldn't load the image library to draw marks",
      cause: err,
    });
  });
  // Upright as a fast lossless PNG first, so a JPEG is only encoded once, at the end.
  const upright = await sharp(source.bytes)
    .rotate()
    .png({ compressionLevel: 0 })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = upright.info;
  const drawn = sharp(upright.data).composite([{ input: Buffer.from(marksSvg(drawings, width, height)) }]);
  const jpeg = source.mimeType === "image/jpeg";
  const out = await (jpeg ? drawn.jpeg({ quality: 95 }) : drawn.png()).toBuffer({ resolveWithObject: true });
  return {
    assetId: source.assetId,
    mimeType: jpeg ? "image/jpeg" : "image/png",
    width: out.info.width,
    height: out.info.height,
    bytes: new Uint8Array(out.data),
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
