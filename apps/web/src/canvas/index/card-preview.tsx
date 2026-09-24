import type { CanvasSummary } from "@openfield/core";
import { useCanvasSketch } from "../../api/hooks/canvases";
import { useAuthedImage } from "../../api/hooks/images";
import { resolvedTheme } from "../../lib/theme";
import { thumbPath } from "../nodes/shell/thumb";
import { GraphSketch } from "./graph-sketch";

// A card's 16:9 preview (M4-15): the picture the editor captured; past the node limit or when it
// fails, the newest image the canvas made; with neither, a sketch of its nodes.

const PREVIEW_HEIGHT = 180;

function Picture({ src }: { src: string }) {
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      className="absolute inset-0 size-full object-cover"
    />
  );
}

/** The card in the theme on screen: pictures are kept in both, so neither theme gets the other's. */
const inTheme = (url: string | null) =>
  url ? `${url}${url.includes("?") ? "&" : "?"}theme=${resolvedTheme()}` : null;

export function CardPreview({ summary }: { summary: CanvasSummary }) {
  const preview = useAuthedImage(inTheme(summary.previewUrl));
  const showPreview = summary.previewUrl !== null && preview.status !== "error";

  const coverPath =
    !showPreview && summary.coverAssetId ? thumbPath(summary.coverAssetId, PREVIEW_HEIGHT) : null;
  const cover = useAuthedImage(coverPath);
  const showCover = coverPath !== null && cover.status !== "error";

  const sketchNeeded = !showPreview && !showCover && summary.nodeCount > 0;
  const sketch = useCanvasSketch(summary, sketchNeeded);

  if (showPreview) {
    return preview.status === "ready" ? <Picture src={preview.src} /> : <GraphSketch graph={null} />;
  }
  if (showCover) {
    return cover.status === "ready" ? <Picture src={cover.src} /> : <GraphSketch graph={null} />;
  }
  return <GraphSketch graph={sketchNeeded ? (sketch.data ?? null) : null} />;
}
