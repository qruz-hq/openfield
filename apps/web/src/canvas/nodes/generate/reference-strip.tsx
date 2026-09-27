import { t } from "@openfield/core";
import { AssetImage } from "../shell/thumb";

// The Generate card's reference images (design uwVfe): up to three thumbnails above the prompt, in
// the order the model gets them, then "+N" for the rest. They show with the bottom bar. One still to
// come from a node upstream is an empty tile until it arrives.

const SHOWN = 3;

export function ReferenceStrip({ images }: { images: readonly (string | null)[] }) {
  if (!images.length) return null;
  const shown = images.slice(0, SHOWN);
  const more = images.length - shown.length;
  return (
    <div
      className="of-card-refs"
      role="img"
      aria-label={t("canvas.nodes.card.references", { count: images.length })}
    >
      {shown.map((assetId, i) =>
        assetId ? (
          // Positions are the model's order, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: the same image can be connected twice.
          <AssetImage key={i} assetId={assetId} height={24} className="of-card-ref" />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: an image still to come has no id yet.
          <span key={i} className="of-card-ref" data-pending />
        ),
      )}
      {more > 0 ? <span className="of-card-ref-more">+{more}</span> : null}
    </div>
  );
}
