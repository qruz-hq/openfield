import { nodeTitle } from "@openfield/canvas/engine/describe";
import { incomingEdges } from "@openfield/canvas/store/graph";
import type { CanvasOp } from "@openfield/canvas/store/ops";
import { t } from "@openfield/core";
import { type DragEvent, type KeyboardEvent, useMemo, useState } from "react";
import { useCanvas, useCanvasStoreApi, useReadOnly } from "../../store/context";
import { nodeRegistry } from "../registry";
import { AssetImage } from "../shell/thumb";

// A Generate's reference images (§7.6, design iy0ZN): what's connected to "Reference images", in
// the order the model gets them, as thumbnails before the + in the inspector's prompt card, each
// named in its tooltip. With two or more, drag one, or ⌥←/→ on it, to move it; the connections'
// order changes as one undo step.

const DRAG_TYPE = "application/x-openfield-reference";

interface Item {
  edgeId: string;
  name: string;
  /** The first image it hands on, for its thumbnail. */
  assetId: string | null;
}

export function ReferenceOrder({ nodeId }: { nodeId: string }) {
  const store = useCanvasStoreApi();
  const readOnly = useReadOnly();
  const [over, setOver] = useState<string | null>(null);
  // The document slices it reads keep their identity until they change, so this recomputes then.
  const doc = useCanvas((s) => s.doc);
  const items = useMemo(
    () =>
      incomingEdges(doc, nodeId, "input_images").map((edge): Item => {
        const source = doc.nodes[edge.source];
        const own = doc.params[edge.source]?.assetIds;
        const first = Array.isArray(own) && typeof own[0] === "string" ? own[0] : null;
        return {
          edgeId: edge.id,
          name: source ? nodeTitle(source, nodeRegistry) : edge.source,
          assetId: first ?? doc.results[edge.source]?.assetIds[0] ?? null,
        };
      }),
    [doc, nodeId],
  );
  if (!items.length) return null;
  const orderable = items.length > 1 && !readOnly;

  const move = (edgeId: string, to: number) => {
    const ids = items.map((i) => i.edgeId).filter((id) => id !== edgeId);
    const at = Math.max(0, Math.min(ids.length, to));
    ids.splice(at, 0, edgeId);
    if (ids.every((id, i) => id === items[i]!.edgeId)) return;
    const ops: CanvasOp[] = ids.map((id, order) => ({ op: "setEdgeOrder", id, order }));
    store.getState().actions.apply(ops, { label: "reorder" });
  };

  const hint = t("canvas.nodes.generate.referencesHint");
  return (
    // Its items sit in the prompt card's row, before the + (design iy0ZN).
    <ol className="contents" aria-label={t("canvas.nodes.generate.references")}>
      {items.map((item, index) => (
        <li
          key={item.edgeId}
          draggable={orderable}
          onDragStart={(event: DragEvent) => {
            event.dataTransfer.setData(DRAG_TYPE, item.edgeId);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event: DragEvent) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            setOver(item.edgeId);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setOver(null);
            const dragged = event.dataTransfer.getData(DRAG_TYPE);
            if (dragged) move(dragged, index);
          }}
          className={over === item.edgeId ? "rounded-8 outline-2 outline-accent" : "rounded-8"}
        >
          {/* A button so the keyboard can reach it: ⌥←/→ moves it. */}
          <button
            type="button"
            disabled={!orderable}
            aria-label={t("canvas.nodes.generate.referenceItem", {
              name: item.name,
              index: index + 1,
              count: items.length,
            })}
            title={orderable ? `${item.name}. ${hint}` : item.name}
            onKeyDown={(event: KeyboardEvent) => {
              if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
              event.preventDefault();
              move(item.edgeId, index + (event.key === "ArrowLeft" ? -1 : 1));
            }}
            className="block size-32 overflow-hidden rounded-8 outline-1 -outline-offset-1 outline-border enabled:cursor-grab focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:opacity-100"
          >
            {item.assetId ? (
              <AssetImage assetId={item.assetId} height={32} className="size-full" />
            ) : (
              <span className="block size-full bg-elevated-2" />
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}
