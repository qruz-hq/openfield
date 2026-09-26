import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useAuthedImage } from "../../../api/hooks/images";
import { useAssetMissing } from "../../store/context";
import { AssetImage, thumbPath } from "../shell/thumb";
import { rememberImageSize } from "./card-media";

// Parts of the Generate card (design A0Fi5O): the pill (aDnHY), the pager (V8qUEE), the message
// (fXWGW) and the image that fills Media. Pills and the pager sit on images, so they keep the dark
// overlay in both themes, like every control on an image.

export interface CardPillProps {
  icon?: LucideIcon;
  /** Inputs changed: an accent dot in place of the icon. */
  dot?: boolean;
  label: string;
  /** "2nd in line", "Batch". */
  detail?: string | null;
  /** The elapsed time, in mono. */
  value?: string | null;
  tone?: "danger";
  /** Hidden at rest, shown on hover. */
  reveal?: boolean;
  /** Drops to its icon on a narrow card while the pager's arrows show. */
  long?: boolean;
  spin?: boolean;
}

/**
 * Canvas / Card / Pill: 24 tall, $overlay with a hairline and an 8 px blur, 10 across, gap 6.
 * It's the one part of the top bar that gives way: when the pill, the pager and the menu don't all
 * fit, its label ends in an ellipsis (icon, detail and time stay), so the menu never leaves the card.
 */
export function CardPill({ icon: Icon, dot, label, detail, value, tone, reveal, long, spin }: CardPillProps) {
  return (
    <span
      className={cn(
        "inline-flex h-24 min-w-0 items-center gap-6 rounded-full bg-overlay px-10 inset-ring inset-ring-overlay-line backdrop-blur-chip",
        reveal && "of-reveal of-reveal-pill",
        long && "of-pill-long",
      )}
    >
      {dot ? <span aria-hidden className="size-6 shrink-0 rounded-full bg-accent" /> : null}
      {Icon ? (
        <Icon
          size={12}
          aria-hidden
          className={cn(
            "shrink-0",
            tone === "danger" ? "of-pill-danger" : "text-overlay-fg-muted",
            spin && "motion-safe:animate-spin",
          )}
        />
      ) : null}
      <span className="of-pill-text min-w-0 truncate text-caption font-medium text-overlay-fg">{label}</span>
      {detail ? (
        <span className="of-pill-text shrink-0 text-caption text-overlay-fg-muted">{detail}</span>
      ) : null}
      {value ? (
        <span className="of-pill-text shrink-0 text-mono-12 text-overlay-fg-muted">{value}</span>
      ) : null}
    </span>
  );
}

/**
 * Canvas / Card / Pager: "1 of 4" at rest, "‹ 1 of 4 ›" on hover, in the top bar so nothing
 * touches the ports. Each arrow is a 24×24 hit area; they wrap around.
 */
export function CardPager({
  index,
  count,
  onPick,
}: {
  index: number;
  count: number;
  onPick: (index: number) => void;
}) {
  const step = (by: number) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    onPick((index + by + count) % count);
  };
  const arrow = "of-card-pager-arrow nodrag size-24 shrink-0 cursor-pointer items-center justify-center";
  return (
    <span className="of-card-pager inline-flex h-24 shrink-0 items-center rounded-full bg-overlay inset-ring inset-ring-overlay-line backdrop-blur-chip">
      <button type="button" aria-label={t("canvas.nodes.card.previous")} onClick={step(-1)} className={arrow}>
        <ChevronLeft size={14} aria-hidden className="text-overlay-fg" />
      </button>
      <span className="text-mono-12 whitespace-nowrap text-overlay-fg">
        {t("canvas.nodes.card.pager", { index: index + 1, count })}
      </span>
      <button type="button" aria-label={t("canvas.nodes.card.next")} onClick={step(1)} className={arrow}>
        <ChevronRight size={14} aria-hidden className="text-overlay-fg" />
      </button>
    </span>
  );
}

/**
 * Canvas / Card / Message: the words in the middle of a failed, blocked or canceled card and the one
 * action. After a result it sits on an $overlay scrim of its own over the last image, painted in
 * the dark theme whatever the app's, like the pills and menu beside it: its text and action stay
 * readable on the dark fill.
 */
export function CardMessage({
  text,
  overImage,
  children,
}: {
  text: string;
  overImage: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-over-image={overImage || undefined}
      data-paint={overImage ? "dark" : undefined}
      className="of-card-message flex w-full flex-col items-center gap-10 px-16"
    >
      <p
        title={text}
        className="of-card-message-text w-full text-center text-small leading-[1.45] text-text-primary"
      >
        {text}
      </p>
      {children ? <div className="flex items-center gap-6">{children}</div> : null}
    </div>
  );
}

/**
 * The image that fills the card, at the thumbnail size for its height. Once it loads, its size
 * stands in for the image's own until that arrives (card-media.ts).
 */
export function CardImage({
  assetId,
  height,
  contain,
  opacity,
}: {
  assetId: string;
  height: number;
  contain: boolean;
  opacity: number;
}) {
  const missing = useAssetMissing(assetId);
  const image = useAuthedImage(missing ? null : thumbPath(assetId, height));
  // Not in this library (deleted, or a canvas from another computer): the usual placeholder.
  if (missing || image.status === "error")
    return <AssetImage assetId={assetId} height={height} className="absolute inset-0" />;
  if (image.status !== "ready") return null;
  return (
    <img
      src={image.src}
      alt=""
      decoding="async"
      draggable={false}
      data-fit={contain ? "contain" : undefined}
      className="of-card-image"
      style={opacity < 1 ? { opacity } : undefined}
      onLoad={(event) =>
        rememberImageSize(assetId, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight, {
          approx: true,
        })
      }
    />
  );
}

/** A preview frame of the image being made (job.partial), until the real one lands. */
export function CardPartial({ path, opacity }: { path: string; opacity: number }) {
  const image = useAuthedImage(path);
  return image.status === "ready" ? (
    <img
      src={image.src}
      alt=""
      draggable={false}
      className="of-card-image"
      style={opacity < 1 ? { opacity } : undefined}
    />
  ) : null;
}
