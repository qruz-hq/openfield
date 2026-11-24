import { assetThumbUrl, type Mark } from "@openfield/core";
import { cn } from "@openfield/ui";
import { useAuthedImage } from "../../../api/hooks/images";
import { boundsOf, placeAt, type Rect } from "../../../detail/edit/sketch";

// Canvas / Inspector / Image edit / Sketch & point's Mask thumb (design z21YIbngO8): the image under
// the overlay fill, as the mask thumb has it, with the node's marks over it in their colours. At
// 40 px a box or circle is a 1 px line round 20% of its colour, a point a 5 px dot, a line 1.5 px.

const SIZE = 40;

export function MarksThumb({
  imageId,
  dims,
  marks,
  className,
}: {
  imageId: string | null;
  /** The image's size, to place the marks on its object-cover crop; without it they fill the box. */
  dims: { w: number; h: number } | undefined;
  marks: readonly Mark[];
  className?: string;
}) {
  const image = useAuthedImage(imageId ? assetThumbUrl(imageId, { h: 200 }) : null);
  // The same crop as the image's object-cover.
  const scale = dims ? Math.max(SIZE / dims.w, SIZE / dims.h) : 1;
  const frame: Rect = dims
    ? {
        left: (SIZE - dims.w * scale) / 2,
        top: (SIZE - dims.h * scale) / 2,
        width: dims.w * scale,
        height: dims.h * scale,
      }
    : { left: 0, top: 0, width: SIZE, height: SIZE };
  return (
    <div
      aria-hidden
      data-paint="dark"
      className={cn("relative size-40 shrink-0 overflow-hidden rounded-8 bg-elevated-2", className)}
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" draggable={false} className="size-full object-cover" />
      ) : null}
      <span className="absolute inset-0 bg-overlay" />
      <svg
        aria-hidden
        data-marks-thumb
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0 size-full"
      >
        {marks.map((mark, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a mark is its number.
          <ThumbMark key={i} mark={mark} frame={frame} />
        ))}
      </svg>
      <span className="pointer-events-none absolute inset-0 rounded-8 inset-ring inset-ring-border" />
    </div>
  );
}

function ThumbMark({ mark, frame }: { mark: Mark; frame: Rect }) {
  const color = mark.color ?? "#F5F6F7";
  switch (mark.kind) {
    case "point": {
      const at = placeAt(frame, mark.at);
      return <circle cx={at.x} cy={at.y} r={2.5} fill={color} />;
    }
    case "box":
    case "circle": {
      const { from, to } = boundsOf(mark);
      const a = placeAt(frame, from);
      const b = placeAt(frame, to);
      const box = { x: a.x, y: a.y, width: Math.max(0, b.x - a.x), height: Math.max(0, b.y - a.y) };
      return mark.kind === "box" ? (
        <rect {...box} fill={`${color}33`} stroke={color} strokeWidth={1} />
      ) : (
        <ellipse
          cx={box.x + box.width / 2}
          cy={box.y + box.height / 2}
          rx={box.width / 2}
          ry={box.height / 2}
          fill={`${color}33`}
          stroke={color}
          strokeWidth={1}
        />
      );
    }
    case "stroke":
    case "arrow": {
      const points = mark.kind === "stroke" ? mark.points : [mark.from, mark.to];
      const d = points
        .map((p, i) => {
          const at = placeAt(frame, p);
          return `${i === 0 ? "M" : "L"}${at.x} ${at.y}`;
        })
        .join(" ");
      return <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />;
    }
  }
}
