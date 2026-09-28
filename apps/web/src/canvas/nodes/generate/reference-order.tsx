import { nodeTitle } from "@openfield/canvas/engine/describe";
import type { CanvasOp } from "@openfield/canvas/store/ops";
import { t } from "@openfield/core";
import { type DragEvent, type KeyboardEvent, useMemo, useState } from "react";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas, useCanvasStoreApi, useLocked, useReadOnly } from "../../store/context";
import { nodeRegistry } from "../registry";
import { useLinkHover } from "../shell/linked-text";
import { AssetImage } from "../shell/thumb";

// A Generate's reference images (§7.6, design iy0ZN): what's connected to "Reference images", in
// the order the model gets them, as thumbnails before the + in the inspector's prompt card. Each
// link shows every image it hands on (a Variations node's four takes, an Upload's photos), from
// the same lists the card's strip is built from (engine/links.ts), and is named in its tooltip.
// With two or more links, drag any image of one, or ⌥←/→ on it, to move that link and all its
// images; the connections' order changes as one undo step. Hovering a link's images outlines them
// and lights the link and the node they come from, like a Prompt node's words (linked-text.tsx).

const DRAG_TYPE = "application/x-openfield-reference";
const NO_LINKS: readonly never[] = [];

interface Item {
  edgeId: string;
  /** The node the images come from. */
  nodeId: string;
  name: string;
  /** Every image it hands on: an asset id, or null for one still to come. */
  images: readonly (string | null)[];
}

export function ReferenceOrder({ nodeId }: { nodeId: string }) {
  const store = useCanvasStoreApi();
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const [over, setOver] = useState<string | null>(null);
  const links = useNodeAnalysis(nodeId)?.imageLinks ?? NO_LINKS;
  const nodes = useCanvas((s) => s.doc.nodes);
  const items = useMemo(
    () =>
      links
        .filter((link) => link.port === "input_images")
        .map((link): Item => {
          const source = nodes[link.nodeId];
          return {
            edgeId: link.edgeId,
            nodeId: link.nodeId,
            name: source ? nodeTitle(source, nodeRegistry) : link.nodeId,
            images: link.images,
          };
        }),
    [links, nodes],
  );
  if (!items.length) return null;
  // A locked node's links keep their order: it's one of its settings.
  const orderable = items.length > 1 && !readOnly && !locked;

  const move = (edgeId: string, to: number) => {
    const ids = items.map((i) => i.edgeId).filter((id) => id !== edgeId);
    const at = Math.max(0, Math.min(ids.length, to));
    ids.splice(at, 0, edgeId);
    if (ids.every((id, i) => id === items[i]!.edgeId)) return;
    const ops: CanvasOp[] = ids.map((id, order) => ({ op: "setEdgeOrder", id, order }));
    store.getState().actions.apply(ops, { label: "reorder" });
  };

  return (
    // Its items sit in the prompt card's row, before the + (design iy0ZN). A link with several
    // images keeps them together and wraps with the row, so everything that goes in shows.
    <ol className="contents" aria-label={t("canvas.nodes.generate.references")}>
      {items.map((item, index) => (
        <ReferenceLink
          key={item.edgeId}
          item={item}
          index={index}
          count={items.length}
          orderable={orderable}
          over={over === item.edgeId}
          onOver={setOver}
          onMove={move}
        />
      ))}
    </ol>
  );
}

/** One link's images: dragged, moved with ⌥←/→, and lit with its link on hover. */
function ReferenceLink({
  item,
  index,
  count,
  orderable,
  over,
  onOver,
  onMove,
}: {
  item: Item;
  index: number;
  count: number;
  orderable: boolean;
  over: boolean;
  onOver: (edgeId: string | null) => void;
  onMove: (edgeId: string, to: number) => void;
}) {
  const hover = useLinkHover(item);
  const hint = t("canvas.nodes.generate.referencesHint");
  return (
    <li
      data-reference-link={item.edgeId}
      {...hover}
      draggable={orderable}
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, item.edgeId);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        onOver(item.edgeId);
      }}
      onDragLeave={() => onOver(null)}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        onOver(null);
        const dragged = event.dataTransfer.getData(DRAG_TYPE);
        if (dragged) onMove(dragged, index);
      }}
      className={
        over
          ? "of-linked of-linked-block flex max-w-full flex-wrap gap-6 outline-2 outline-accent"
          : "of-linked of-linked-block flex max-w-full flex-wrap gap-6"
      }
    >
      {/* One button per link so the keyboard reaches each once: ⌥←/→ moves the link. */}
      <button
        type="button"
        disabled={!orderable}
        aria-label={t("canvas.nodes.generate.referenceItem", {
          name: item.name,
          images: item.images.length,
          index: index + 1,
          count,
        })}
        title={orderable ? `${item.name}. ${hint}` : item.name}
        onKeyDown={(event: KeyboardEvent) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          onMove(item.edgeId, index + (event.key === "ArrowLeft" ? -1 : 1));
        }}
        className="flex max-w-full flex-wrap gap-6 rounded-8 enabled:cursor-grab focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-100"
      >
        {(item.images.length ? item.images : [null]).map((assetId, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: positions are the model's order; the same image can come twice.
            key={i}
            data-reference-thumb
            className="block size-32 shrink-0 overflow-hidden rounded-8 outline-1 -outline-offset-1 outline-border"
          >
            {assetId ? (
              <AssetImage assetId={assetId} height={32} className="size-full" />
            ) : (
              <span className="block size-full bg-elevated-2" />
            )}
          </span>
        ))}
      </button>
    </li>
  );
}
