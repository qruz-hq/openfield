import { t } from "@openfield/core";
import { Button, cn, IconButton } from "@openfield/ui";
import { Plus, Upload, X } from "lucide-react";
import { type DragEvent, memo, useEffect, useRef, useState } from "react";
import { UPLOAD_ACCEPT, uploadImages } from "../../../api/hooks/uploads";
import { errorMessage } from "../../../api/raw";
import { notifyError } from "../../../lib/notify";
import { EMPTY_ENGINE_CONTEXT } from "../../engine/context-base";
import { useCanvasStoreApi, useReadOnly } from "../../store/context";
import { takeOpenPicker } from "../picker-intent";
import type { NodeComponentProps } from "../registry";
import { NodeShell } from "../shell/node-shell";
import { AssetImage } from "../shell/thumb";
import { useNodeBasics, useParsedParams } from "../shell/use-node";
import { type ImageListParams, uploadSpec } from "./spec";

// Canvas / Node / Upload (design GTnB2) and / Empty (d0l3m). The first image fills the node; the
// rest sit in the footer strip, where clicking one brings it to the front, dragging (or ⌥←/→)
// reorders, and × takes it out (§7.5). Files go to the library one by one (POST /api/uploads) and
// the node keeps their ids, in order: the order the model gets them in.

/** What a thumbnail being dragged within the node carries, so it isn't taken for a file drop. */
const DRAG_TYPE = "application/x-openfield-image";

export const UploadNode = memo(function UploadNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const params = useParsedParams<ImageListParams>(id, uploadSpec, basics?.ctx ?? EMPTY_ENGINE_CONTEXT);
  const store = useCanvasStoreApi();
  const readOnly = useReadOnly();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (takeOpenPicker(id)) input.current?.click();
  }, [id]);

  if (!basics) return null;
  const { frame } = basics;
  const ids = params.assetIds;

  /** The ids as saved right now: an upload finishing late mustn't undo a remove made meanwhile. */
  const current = () =>
    uploadSpec.parseParams(store.getState().doc.params[id] ?? {}, EMPTY_ENGINE_CONTEXT).assetIds;
  const write = (assetIds: string[]) =>
    store.getState().actions.apply([{ op: "setParams", id, patch: { assetIds } }], { label: "images" });

  const add = async (files: File[]) => {
    if (!files.length || readOnly) return;
    setUploading((n) => n + files.length);
    const { assetIds, failed } = await uploadImages(files);
    setUploading((n) => n - files.length);
    if (assetIds.length) write([...current(), ...assetIds.filter((a) => !current().includes(a))]);
    for (const { error } of failed) notifyError(errorMessage(error));
  };
  const remove = (assetId: string) => write(current().filter((a) => a !== assetId));
  /** Puts an image at `to` in the order, the others keeping theirs. */
  const move = (assetId: string, to: number) => {
    const rest = current().filter((a) => a !== assetId);
    const at = Math.max(0, Math.min(rest.length, to));
    if (current().indexOf(assetId) === at) return;
    write([...rest.slice(0, at), assetId, ...rest.slice(at)]);
  };
  const bringToFront = (assetId: string) => move(assetId, 0);
  const reorderable = (index: number) =>
    readOnly
      ? {}
      : {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            event.stopPropagation();
            event.dataTransfer.setData(DRAG_TYPE, ids[index]!);
            event.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
          },
          onDrop: (event: DragEvent) => {
            const dragged = event.dataTransfer.getData(DRAG_TYPE);
            if (!dragged) return;
            event.preventDefault();
            event.stopPropagation();
            move(dragged, index);
          },
        };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const dragged = event.dataTransfer.getData(DRAG_TYPE);
    if (dragged) return move(dragged, 0);
    void add([...event.dataTransfer.files]);
  };
  const dropTarget = {
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes(DRAG_TYPE)) {
        // A thumbnail dropped on the big image goes to the front.
        event.preventDefault();
        return;
      }
      if (readOnly || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept={UPLOAD_ACCEPT}
      multiple
      hidden
      onChange={(event) => {
        void add([...(event.target.files ?? [])]);
        event.target.value = "";
      }}
    />
  );
  const count = uploading
    ? t("canvas.nodes.upload.uploading", { count: uploading })
    : t("canvas.nodes.images.count", { count: ids.length });

  return (
    <NodeShell
      {...props}
      spec={uploadSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      collapsedMeta={<span className="truncate text-caption text-text-secondary">{count}</span>}
      thumbs={ids}
      frameClassName={ids.length ? undefined : "p-8"}
    >
      {picker}
      {ids.length ? (
        <>
          <div className="group relative min-h-0 flex-1" {...dropTarget}>
            <AssetImage assetId={ids[0]!} height={224} className="absolute inset-0" />
            {dragging ? (
              <div className="absolute inset-0 bg-accent-soft inset-ring-2 inset-ring-accent" />
            ) : null}
            {readOnly ? null : (
              <IconButton
                variant="overlay"
                size={32}
                icon={X}
                label={t("canvas.nodes.images.remove", { index: 1 })}
                onClick={() => remove(ids[0]!)}
                className="nodrag absolute top-8 right-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              />
            )}
          </div>
          <div className="flex h-56 shrink-0 items-center gap-6 px-10">
            <div className="nowheel flex min-w-0 gap-6 overflow-x-auto [scrollbar-width:none]">
              {ids.slice(1).map((assetId, i) => (
                <div
                  key={assetId}
                  className="nodrag group/thumb relative size-36 shrink-0"
                  {...reorderable(i + 1)}
                >
                  <button
                    type="button"
                    aria-label={t("canvas.nodes.images.open", { index: i + 2 })}
                    disabled={readOnly}
                    onClick={() => bringToFront(assetId)}
                    onKeyDown={(event) => {
                      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                      event.preventDefault();
                      event.stopPropagation();
                      move(assetId, i + 1 + (event.key === "ArrowLeft" ? -1 : 1));
                    }}
                    className="nodrag block size-36 cursor-pointer overflow-hidden rounded-6 inset-ring inset-ring-border"
                  >
                    <AssetImage assetId={assetId} height={36} className="size-full" />
                  </button>
                  {readOnly ? null : (
                    <button
                      type="button"
                      aria-label={t("canvas.nodes.images.remove", { index: i + 2 })}
                      onClick={() => remove(assetId)}
                      className="nodrag absolute -top-4 -right-4 hidden size-16 cursor-pointer items-center justify-center rounded-full bg-overlay text-overlay-fg group-hover/thumb:flex focus-visible:flex"
                    >
                      <X size={10} aria-hidden />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              aria-label={t("canvas.nodes.upload.add")}
              disabled={readOnly}
              onClick={() => input.current?.click()}
              className="nodrag flex size-36 shrink-0 cursor-pointer items-center justify-center rounded-6 bg-surface text-text-tertiary inset-ring inset-ring-border transition-colors not-disabled:hover:text-text-secondary disabled:cursor-default"
            >
              <Plus size={14} aria-hidden />
            </button>
            <span className="h-1 flex-1" />
            <span className="shrink-0 text-caption text-text-tertiary">{count}</span>
          </div>
        </>
      ) : (
        <div
          {...dropTarget}
          className={cn(
            "flex min-h-0 flex-1 flex-col items-center justify-center gap-12 rounded-10 bg-surface p-16 inset-ring inset-ring-border-strong",
            dragging && "bg-accent-soft inset-ring-2 inset-ring-accent",
          )}
        >
          <span className="flex size-40 items-center justify-center rounded-full bg-elevated-2">
            <Upload size={18} aria-hidden className="text-text-tertiary" />
          </span>
          <span className="flex flex-col items-center gap-4 text-center">
            <span className="text-body-strong text-text-primary">
              {uploading ? count : t("canvas.nodes.upload.emptyTitle")}
            </span>
            <span className="text-caption text-text-tertiary">{t("canvas.nodes.upload.emptyLine")}</span>
          </span>
          <Button
            variant="secondary"
            size="s"
            className="nodrag"
            disabled={readOnly || uploading > 0}
            onClick={() => input.current?.click()}
          >
            {t("canvas.nodes.upload.choose")}
          </Button>
        </div>
      )}
    </NodeShell>
  );
});
