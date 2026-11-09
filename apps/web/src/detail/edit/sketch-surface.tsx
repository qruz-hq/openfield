import { MARKS_MAX, type Mark, type MarkPoint } from "@openfield/core";
import { cn, Popover, PopoverAnchor } from "@openfield/ui";
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PinnedFrame } from "../media";
import { useEditSession } from "./session";
import {
  boundsOf,
  chipAt,
  chipCenter,
  fractionAt,
  MARK_OF_TOOL,
  MIN_DRAG_PX,
  placeAt,
  type Rect,
  thinStroke,
} from "./sketch";
import { MarkChip, MarkPopover } from "./sketch-chrome";

// Sketch & point's surface (design dtuXJVDUtn): like the paint surface, parts handed to Media. A
// sizeless element in the image's zoomed box tells where the image is on screen. The marks are drawn
// pinned, in screen px, so their lines and numbered chips keep their size at any zoom. The input over
// the media area takes the pointer: a press on a chip picks that mark, anything else draws with the
// tool in hand. The picked mark's popover hangs off its right side.

interface SketchOptions {
  /** Pan instead of draw: the Pan tool, or Space held. */
  panning: boolean;
}

export interface SketchSurface {
  layer: ReactNode;
  pinned: (frame: PinnedFrame) => ReactNode;
  input: ReactNode;
  /** Esc: drops what's being drawn. True when there was something. */
  cancel: () => boolean;
}

/** A mark being drawn: its kind, and the points so far. */
interface Draft {
  pointer: number;
  kind: Exclude<Mark["kind"], "point">;
  points: MarkPoint[];
  /** Where the press started on screen, to tell a drag from a click. */
  start: { x: number; y: number };
  moved: boolean;
}

/** The mark a draft makes once the pointer comes up; null when it's too short to be one. */
function markOf(draft: Draft, color: string): Mark | null {
  if (!draft.moved) return null;
  const first = draft.points[0]!;
  const last = draft.points.at(-1)!;
  if (draft.kind === "stroke")
    return draft.points.length >= 2 ? { kind: "stroke", points: thinStroke(draft.points), color } : null;
  return { kind: draft.kind, from: first, to: last, color };
}

export function useSketchSurface({ panning }: SketchOptions): SketchSurface {
  const tool = useEditSession((s) => s.sketchTool);
  const anchor = useRef<HTMLDivElement>(null);
  const draftRef = useRef<Draft | null>(null);
  const [draft, setDraftView] = useState<Draft | null>(null);

  const setDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraftView(next);
  }, []);

  const cancel = useCallback(() => {
    if (!draftRef.current) return false;
    setDraft(null);
    return true;
  }, [setDraft]);

  // Changing tools drops a half-drawn mark.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the tool change drops it.
  useEffect(() => void cancel(), [tool]);

  const imageRect = (): Rect | null => {
    const rect = anchor.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? rect : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || draftRef.current) return;
    const image = imageRect();
    if (!image) return;
    const client = { x: event.clientX, y: event.clientY };
    const session = useEditSession.getState();
    const hit = chipAt(session.marks, image, client);
    // The media area under this would start a pan.
    event.stopPropagation();
    if (hit !== null) {
      session.selectMark(hit);
      return;
    }
    const inside =
      client.x >= image.left &&
      client.y >= image.top &&
      client.x <= image.left + image.width &&
      client.y <= image.top + image.height;
    if (!inside || tool === "pan" || session.marks.length >= MARKS_MAX) return;
    const at = fractionAt(image, client);
    const color = session.markColor;
    if (tool === "point") {
      session.addMark({ kind: "point", at, color });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({
      pointer: event.pointerId,
      kind: MARK_OF_TOOL[tool],
      points: [at],
      start: client,
      moved: false,
    });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = draftRef.current;
    const image = imageRect();
    if (!current || current.pointer !== event.pointerId || !image) return;
    const at = fractionAt(image, { x: event.clientX, y: event.clientY });
    const moved =
      current.moved ||
      Math.hypot(event.clientX - current.start.x, event.clientY - current.start.y) >= MIN_DRAG_PX;
    if (current.kind === "stroke") {
      // Every point the pointer reported since the last frame, so a fast line keeps its curve.
      const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = events.length
        ? events.map((e) => fractionAt(image, { x: e.clientX, y: e.clientY }))
        : [at];
      setDraft({ ...current, moved, points: [...current.points, ...points] });
    } else {
      setDraft({ ...current, moved, points: [current.points[0]!, at] });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = draftRef.current;
    if (!current || current.pointer !== event.pointerId) return;
    setDraft(null);
    const session = useEditSession.getState();
    const mark = markOf(current, session.markColor);
    if (mark) session.addMark(mark);
  };

  const layer = <div ref={anchor} aria-hidden className="pointer-events-none absolute inset-0" />;

  const input = (
    // Pointer only; the tools' keys are the view's (keys.ts).
    <div
      data-sketch-input
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => cancel()}
      className={cn("absolute inset-0", panning ? "pointer-events-none" : "cursor-crosshair")}
    />
  );

  const pinned = (frame: PinnedFrame) => <SketchMarks frame={frame} draft={draft} />;

  return { layer, pinned, input, cancel };
}

/** The marks over the image, the one being drawn, and the picked one's popover. */
function SketchMarks({ frame, draft }: { frame: PinnedFrame; draft: Draft | null }) {
  const marks = useEditSession((s) => s.marks);
  const selected = useEditSession((s) => s.selectedMark);
  const color = useEditSession((s) => s.markColor);
  const image = frame.image;
  const pending = draft ? markOf({ ...draft, moved: true }, color) : null;
  const picked = selected !== null ? marks[selected] : undefined;

  return (
    <>
      <svg aria-hidden className="absolute inset-0 size-full overflow-visible">
        {marks.map((mark, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a mark is its number; removing one renumbers the rest.
          <MarkShape key={i} mark={mark} image={image} />
        ))}
        {pending ? <MarkShape mark={pending} image={image} /> : null}
      </svg>
      {marks.map((mark, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        <MarkChip key={i} mark={mark} n={i + 1} selected={i === selected} at={chipCenter(mark, image)} />
      ))}
      {picked && selected !== null ? (
        <Popover
          open
          onOpenChange={(open) => {
            // A press on another chip picks that one before this closes: keep it picked.
            const session = useEditSession.getState();
            if (!open && session.selectedMark === selected) session.selectMark(null);
          }}
        >
          <PopoverAnchor asChild>
            <div className="absolute" style={anchorBox(picked, image)} />
          </PopoverAnchor>
          <MarkPopover index={selected} mark={picked} />
        </Popover>
      ) : null}
    </>
  );
}

/** What the popover hangs off: a mark's box, or a point's dot. */
function anchorBox(mark: Mark, image: Rect) {
  if (mark.kind === "point") {
    const at = placeAt(image, mark.at);
    return { left: at.x - 6, top: at.y - 6, width: 12, height: 12 };
  }
  const { from, to } = boundsOf(mark);
  const a = placeAt(image, from);
  const b = placeAt(image, to);
  return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
}

/**
 * Sketch / Mark / Box, Point and Shapes: a box (radius 4) and a circle at 8% of the mark's colour
 * with a 2 px line, a point's 12 px dot in a 28 px halo at 20%, and a line or an arrow 2.5 px wide.
 */
function MarkShape({ mark, image }: { mark: Mark; image: Rect }) {
  const color = mark.color ?? "#F5F6F7";
  switch (mark.kind) {
    case "point": {
      const at = placeAt(image, mark.at);
      return (
        <g data-mark-shape="point">
          <circle cx={at.x} cy={at.y} r={13.25} fill={`${color}33`} stroke={color} strokeWidth={1.5} />
          <circle cx={at.x} cy={at.y} r={5} fill={color} stroke="#FFFFFF" strokeWidth={2} />
        </g>
      );
    }
    case "box":
    case "circle": {
      const { from, to } = boundsOf(mark);
      const a = placeAt(image, from);
      const b = placeAt(image, to);
      // Lines sit inside the shape's box, as the design's inside strokes do.
      const box = {
        x: a.x + 1,
        y: a.y + 1,
        width: Math.max(0, b.x - a.x - 2),
        height: Math.max(0, b.y - a.y - 2),
      };
      return mark.kind === "box" ? (
        <rect data-mark-shape="box" {...box} rx={4} fill={`${color}14`} stroke={color} strokeWidth={2} />
      ) : (
        <ellipse
          data-mark-shape="circle"
          cx={box.x + box.width / 2}
          cy={box.y + box.height / 2}
          rx={box.width / 2}
          ry={box.height / 2}
          fill={`${color}14`}
          stroke={color}
          strokeWidth={2}
        />
      );
    }
    case "stroke": {
      const d = mark.points
        .map((p, i) => {
          const at = placeAt(image, p);
          return `${i === 0 ? "M" : "L"}${at.x} ${at.y}`;
        })
        .join(" ");
      return (
        <path
          data-mark-shape="stroke"
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    case "arrow": {
      const a = placeAt(image, mark.from);
      const b = placeAt(image, mark.to);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      // The head: two 10 px lines back from the tip, 30 degrees either side, as move-up-right draws.
      const head = [-1, 1].map((side) => {
        const turn = angle + Math.PI + (side * Math.PI) / 6;
        return `M${b.x} ${b.y} L${b.x + 10 * Math.cos(turn)} ${b.y + 10 * Math.sin(turn)}`;
      });
      return (
        <path
          data-mark-shape="arrow"
          d={`M${a.x} ${a.y} L${b.x} ${b.y} ${head.join(" ")}`}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
  }
}
