import { t } from "@openfield/core";
import { Button } from "@openfield/ui";
import { Image as ImageIcon, Play, Plus } from "lucide-react";
import { useAssets } from "../../api/hooks/assets";
import { useAuthedImage } from "../../api/hooks/images";
import { thumbPath } from "../nodes/shell/thumb";
import { SketchDots, usePatternId } from "./graph-sketch";

// Canvas · Index empty (O5bcdk): Empty state / Page (xhSY1) with the mark swapped for a small
// Prompt → Generate illustration (rzh3x), then New canvas and Start from a template.

export function IndexEmptyState({
  onCreate,
  creating,
  onTemplates,
}: {
  onCreate: () => void;
  creating: boolean;
  onTemplates: () => void;
}) {
  return (
    <div className="flex w-520 max-w-full flex-col items-center gap-32">
      <div className="flex w-full flex-col items-center gap-24">
        <Illustration />
        <div className="flex w-full flex-col items-center gap-10">
          <h2 className="w-full text-center text-display text-text-primary">{t("canvas.empty.title")}</h2>
          <p className="w-full text-center text-[15px] leading-[1.45] text-text-secondary">
            {t("canvas.empty.body")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-12">
        <Button variant="primary" size="m" icon={Plus} loading={creating} onClick={onCreate}>
          {t("canvas.empty.newCanvas")}
        </Button>
        <Button variant="secondary" size="m" onClick={onTemplates}>
          {t("canvas.empty.fromTemplate")}
        </Button>
      </div>
    </div>
  );
}

/** The newest image in the library stands in for the design's photo; with none, the empty mark. */
function useNewestImage(): string | null {
  const assets = useAssets("all");
  const newest = assets.data?.pages[0]?.items[0];
  const image = useAuthedImage(newest ? thumbPath(newest.id, 84) : null);
  return newest && image.status === "ready" ? image.src : null;
}

const port = "absolute size-10 rounded-full bg-elevated-2 inset-ring inset-ring-border-strong";
const label = "absolute text-[10px] leading-[12px] font-medium text-text-tertiary";

/** rzh3x: 400×180 on the canvas fill. Positions are the design's own. */
function Illustration() {
  const dots = usePatternId();
  const photo = useNewestImage();
  return (
    <div
      aria-hidden
      className="relative h-180 w-400 max-w-full shrink-0 overflow-hidden rounded-16 bg-canvas inset-ring inset-ring-border"
    >
      <svg aria-hidden className="absolute inset-0 size-full">
        <SketchDots id={dots} />
      </svg>
      <svg aria-hidden className="absolute top-76 left-132 h-22 w-56 overflow-visible" viewBox="0 0 56 22">
        <path d="M0 0c28 0 28 22 56 22" className="fill-none stroke-border-strong" strokeWidth={1.5} />
      </svg>
      <svg aria-hidden className="absolute top-98 left-300 h-26 w-40 overflow-visible" viewBox="0 0 40 26">
        <path d="M0 0c20 0 20 26 40 26" className="fill-none stroke-border-strong" strokeWidth={1.5} />
      </svg>
      <div className="absolute top-44 left-28 flex h-64 w-104 flex-col gap-8 rounded-10 bg-elevated px-12 py-16 inset-ring inset-ring-border">
        <div className="h-6 w-80 shrink-0 rounded-[3px] bg-border-strong" />
        <div className="h-6 w-52 shrink-0 rounded-[3px] bg-border" />
      </div>
      <div className="absolute top-38 left-188 flex h-120 w-112 flex-col overflow-hidden rounded-10 bg-elevated">
        <div className="relative flex h-84 w-full shrink-0 items-center justify-center bg-surface">
          {photo ? (
            <img src={photo} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
          ) : (
            <ImageIcon size={14} className="text-border-strong" />
          )}
        </div>
        <div className="flex w-full flex-1 items-center justify-between px-8">
          <div className="h-6 w-40 rounded-[3px] bg-border-strong" />
          <div className="flex h-16 w-26 items-center justify-center rounded-full bg-border-strong">
            <Play size={9} className="text-text-secondary" />
          </div>
        </div>
        {/* The node's stroke, over the picture. */}
        <div className="pointer-events-none absolute inset-0 rounded-10 inset-ring inset-ring-border" />
      </div>
      <div className="absolute top-108 left-340 flex size-32 items-center justify-center rounded-16 bg-canvas inset-ring inset-ring-border-strong">
        <Plus size={14} className="text-text-tertiary" />
      </div>
      <div className={`${port} top-71 left-127`} />
      <div className={`${port} top-93 left-183`} />
      <div className={`${port} top-93 left-295`} />
      <p className={`${label} top-28 left-28`}>{t("canvas.empty.prompt")}</p>
      <p className={`${label} top-22 left-188`}>{t("canvas.empty.generate")}</p>
    </div>
  );
}
