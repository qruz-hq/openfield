import type { AssetListItem } from "@openfield/core";
import { t } from "@openfield/core";
import { Button, cn, IconButton } from "@openfield/ui";
import { GripVertical, Images, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import { AssetImage } from "../shell/thumb";

// Picked (design gkQu2, row iSwFh/r28nn, empty DcBnO): the node's list in order, its own thumb and
// prompt, dragged or moved with Alt and an arrow key, same as a Generate card's reference order
// (reference-order.tsx) - a native drag, no library, plus a keyboard way to do the same move.

const DRAG_TYPE = "application/x-openfield-picked";

export function PickerPicked({
  ids,
  assets,
  onRemove,
  onMove,
  onClear,
}: {
  ids: readonly string[];
  /** Its prompt and thumbnail, once known - from whatever place the grid last showed it in, or
   * fetched on its own for a pick the node already had when the picker opened. */
  assets: ReadonlyMap<string, Pick<AssetListItem, "prompt">>;
  onRemove: (id: string) => void;
  onMove: (id: string, to: number) => void;
  onClear: () => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="flex h-full w-300 shrink-0 flex-col gap-4 border-l border-border bg-surface p-12">
      <div className="flex w-full items-center justify-between px-4 pb-8">
        <h2 className="text-body-strong text-text-primary">
          {t("canvas.nodes.picker.picked.title", { count: ids.length })}
        </h2>
        {ids.length ? (
          <Button variant="link" size="s" onClick={onClear}>
            {t("canvas.nodes.picker.picked.clear")}
          </Button>
        ) : null}
      </div>
      {ids.length === 0 ? (
        <div className="flex w-full flex-col items-center gap-6 px-16 py-24 text-center">
          <Images size={20} aria-hidden className="text-text-tertiary" />
          <p className="text-small font-medium text-text-secondary">
            {t("canvas.nodes.picker.picked.emptyTitle")}
          </p>
          <p className="text-caption leading-[1.4] text-text-tertiary">
            {t("canvas.nodes.picker.picked.emptyBody")}
          </p>
        </div>
      ) : (
        <ol
          aria-label={t("canvas.nodes.picker.picked.list")}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
        >
          {ids.map((id, index) => (
            <PickedRow
              key={id}
              id={id}
              prompt={assets.get(id)?.prompt ?? ""}
              index={index}
              over={over === id}
              onOver={setOver}
              onRemove={() => onRemove(id)}
              onMove={(to) => onMove(id, to)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function PickedRow({
  id,
  prompt,
  index,
  over,
  onOver,
  onRemove,
  onMove,
}: {
  id: string;
  prompt: string;
  index: number;
  over: boolean;
  onOver: (id: string | null) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  const order = t("canvas.nodes.picker.picked.order", { index: index + 1 });
  return (
    <li
      draggable
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        onOver(id);
      }}
      onDragLeave={() => onOver(null)}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        onOver(null);
        if (event.dataTransfer.getData(DRAG_TYPE)) onMove(index);
      }}
      className={cn(
        "flex h-60 w-full shrink-0 cursor-grab items-center gap-10 rounded-10 py-0 pr-8 pl-4 transition-colors hover:bg-elevated-2",
        over && "outline-2 outline-accent -outline-offset-2",
      )}
    >
      <button
        type="button"
        aria-label={t("canvas.nodes.picker.picked.reorder", { order })}
        onKeyDown={(event: KeyboardEvent) => {
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          onMove(index + (event.key === "ArrowUp" ? -1 : 1));
        }}
        className="flex shrink-0 cursor-grab items-center justify-center outline-none focus-visible:rounded-4 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <GripVertical size={14} aria-hidden className="text-text-tertiary" />
      </button>
      <span className="block size-44 shrink-0 overflow-hidden rounded-8">
        <AssetImage assetId={id} height={44} className="size-full" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-mono-11 text-text-tertiary">{order}</span>
        <span className="line-clamp-2 text-small leading-[1.3] text-text-primary">
          {prompt.trim() || t("feed.tile.noPrompt")}
        </span>
      </span>
      <IconButton
        variant="ghost"
        size={24}
        icon={X}
        label={t("canvas.nodes.picker.picked.remove", { order })}
        onClick={onRemove}
      />
    </li>
  );
}

/** Picker / Order badge (design pr1TU): over a picked thumb in the grid, top-left at 8,8. */
export function OrderBadge({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      className="absolute top-8 left-8 flex size-22 items-center justify-center rounded-full bg-accent"
    >
      <span className="text-mono-11 font-semibold text-accent-fg">{index + 1}</span>
    </span>
  );
}
