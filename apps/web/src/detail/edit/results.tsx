import { assetThumbUrl, t } from "@openfield/core";
import { cn, Spinner, TileStatusPill, Tooltip } from "@openfield/ui";
import { CircleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { useAuthedImage } from "../../api/hooks/images";
import type { ResultSlot } from "./plan";

// Over the media area while an edit runs and after (design DFd2yqIj0C, Kb96vQFIiK): the results
// strip at the left (Image edit / Results strip, an Editor / Version strip) with the original, then
// one thumb per image in the batch, and the Generating label on the image's corner.

const THUMB = 40;

export function ResultsStrip({
  originalId,
  slots,
  shown,
  onShow,
}: {
  originalId: string;
  slots: readonly ResultSlot[];
  /** The image picked, null for the original, undefined for none yet. */
  shown: string | null | undefined;
  onShow: (assetId: string | null) => void;
}) {
  return (
    <fieldset
      aria-label={t("edit.results.label")}
      className="absolute top-1/2 left-16 flex -translate-y-1/2 flex-col gap-8"
    >
      <Tooltip content={t("edit.results.original")} side="right">
        <Thumb
          assetId={originalId}
          label={t("edit.results.original")}
          selected={shown === null}
          onClick={() => onShow(null)}
        />
      </Tooltip>
      {slots.map((slot, i) =>
        slot.state === "done" && slot.assetId ? (
          <Thumb
            key={slot.jobId}
            assetId={slot.assetId}
            label={t("edit.results.image", { index: i + 1 })}
            selected={shown === slot.assetId}
            onClick={() => onShow(slot.assetId)}
          />
        ) : slot.state === "failed" ? (
          // Editor / Version thumb / Failed
          <div
            key={slot.jobId}
            role="img"
            aria-label={t("edit.results.failed", { index: i + 1 })}
            className="flex size-40 items-center justify-center rounded-8 bg-danger-soft inset-ring inset-ring-danger-line"
          >
            <CircleAlert size={16} aria-hidden className="text-danger" />
          </div>
        ) : (
          // Image edit / Results strip / Generating: one per image on its way.
          <div
            key={slot.jobId}
            role="img"
            aria-label={t("edit.results.working", { index: i + 1 })}
            className="flex size-40 items-center justify-center rounded-8 bg-elevated-2"
          >
            <Spinner size={16} className="text-text-secondary" />
          </div>
        ),
      )}
    </fieldset>
  );
}

/**
 * A 40 square thumb, radius 8. Picked, it sits 3 inside a 2px accent ring at radius 10. The rest of
 * the props are a tooltip's, when it wraps one.
 */
function Thumb({
  assetId,
  label,
  selected,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { assetId: string; label: string; selected: boolean }) {
  const image = useAuthedImage(assetThumbUrl(assetId, { h: THUMB }));
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        "relative flex size-40 shrink-0 cursor-pointer items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        selected ? "rounded-10 p-3 inset-ring-2 inset-ring-accent-line" : "rounded-8",
      )}
    >
      <span
        className={cn(
          "relative block size-full overflow-hidden bg-elevated-2",
          selected ? "rounded-7" : "rounded-8",
        )}
      >
        {image.status === "ready" ? (
          <img src={image.src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
        ) : null}
        {/* Over the image, which would paint over a ring on the box itself. */}
        {selected ? null : (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-8 inset-ring inset-ring-border"
          />
        )}
      </span>
    </button>
  );
}

/** Pill / Tile status / Generating on the image's top left corner, 10 in. */
export function GeneratingLabel() {
  return (
    <TileStatusPill status="generating" className="absolute top-10 left-10">
      {t("edit.status.generating")}
    </TileStatusPill>
  );
}
