import { nodeTitle } from "@openfield/canvas/engine/describe";
import { incomingEdges } from "@openfield/canvas/store/graph";
import type { CanvasOp } from "@openfield/canvas/store/ops";
import { t } from "@openfield/core";
import { type DragEvent, type KeyboardEvent, useMemo, useState } from "react";
import { useCanvas, useCanvasStoreApi, useReadOnly } from "../../store/context";
import { nodeRegistry } from "../registry";
import { InspectorField } from "../shell/inspector-parts";
import { AssetImage } from "../shell/thumb";

// The order of a Generate's reference images (§7.6): what's connected to "Reference images", in
// the order the model gets them. Drag a chip, or ⌥←/→ on it, to move it; the connections' order
// changes as one undo step. Only shown with two or more.

const DRAG_TYPE = "application/x-openfield-reference";

interface Item {
  edgeId: string;
  name: string;
  /** The first image it hands on, for the chip's picture. */
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
  if (items.length < 2) return null;

  const move = (edgeId: string, to: number) => {
    const ids = items.map((i) => i.edgeId).filter((id) => id !== edgeId);
    const at = Math.max(0, Math.min(ids.length, to));
    ids.splice(at, 0, edgeId);
    if (ids.every((id, i) => id === items[i]!.edgeId)) return;
    const ops: CanvasOp[] = ids.map((id, order) => ({ op: "setEdgeOrder", id, order }));
    store.getState().actions.apply(ops, { label: "reorder" });
  };

  return (
    <InspectorField label={t("canvas.nodes.generate.references")}>
      <ol className="flex w-full flex-wrap gap-6">
        {items.map((item, index) => (
          <li
            key={item.edgeId}
            draggable={!readOnly}
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
            className={over === item.edgeId ? "rounded-8 inset-ring-2 inset-ring-accent" : undefined}
          >
            {/* A button so the keyboard can reach it: ⌥←/→ moves it. */}
            <button
              type="button"
              disabled={readOnly}
              aria-label={t("canvas.nodes.generate.referenceItem", {
                name: item.name,
                index: index + 1,
                count: items.length,
              })}
              title={item.name}
              onKeyDown={(event: KeyboardEvent) => {
                if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                event.preventDefault();
                move(item.edgeId, index + (event.key === "ArrowLeft" ? -1 : 1));
              }}
              className="flex h-32 max-w-160 cursor-grab items-center gap-6 rounded-8 bg-elevated-2 pr-8 pl-3 inset-ring inset-ring-border focus-visible:outline-2 focus-visible:outline-accent"
            >
              {item.assetId ? (
                <AssetImage assetId={item.assetId} height={26} className="size-26 shrink-0 rounded-6" />
              ) : (
                <span className="size-26 shrink-0 rounded-6 bg-surface" />
              )}
              <span className="truncate text-caption text-text-primary">{item.name}</span>
            </button>
          </li>
        ))}
      </ol>
      <span className="text-caption text-text-tertiary">{t("canvas.nodes.generate.referencesHint")}</span>
    </InspectorField>
  );
}
