import { assetThumbUrl, t } from "@openfield/core";
import { cn, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from "@openfield/ui";
import { FolderOpen, Plus, Upload, X } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { useAuthedImage } from "../../api/hooks/images";
import { UPLOAD_ACCEPT, uploadImage } from "../../api/hooks/uploads";
import { errorMessage } from "../../api/raw";
import { notifyError } from "../../lib/notify";
import { FramePicker } from "./frame-picker";

// Composer / Video / Start (End) frame (design R67TO9, lBWxa): 84 square, radius 12, elevated-2
// with a border, an accent border once it holds an image. Empty it's a plus and the caption;
// filled, a 28px thumbnail and "1 image". Accepts a drop, an upload, or a library pick.

export interface FrameTileProps {
  kind: "start" | "end";
  assetId: string | undefined;
  onPick: (assetId: string) => void;
  onRemove: () => void;
  disabled?: boolean;
}

export function FrameTile({ kind, assetId, onPick, onRemove, disabled = false }: FrameTileProps) {
  const files = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const image = useAuthedImage(assetId ? assetThumbUrl(assetId, { h: 56 }) : null);

  const label = kind === "start" ? t("video.chips.startFrame.label") : t("video.chips.endFrame.label");
  const addLabel = kind === "start" ? t("video.chips.startFrame.add") : t("video.chips.endFrame.add");
  const removeLabel =
    kind === "start" ? t("video.chips.startFrame.remove") : t("video.chips.endFrame.remove");

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const { asset } = await uploadImage(file);
      onPick(asset.id);
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const file = [...event.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (file) void upload(file);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop only; the button or menu inside is the control.
    <div
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={disabled ? undefined : onDrop}
      className="relative size-84 shrink-0"
    >
      <input
        ref={files}
        type="file"
        accept={UPLOAD_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {assetId ? (
        <fieldset
          aria-label={`${label}: ${t("video.frames.oneImage")}`}
          className="relative flex size-full flex-col justify-between overflow-hidden rounded-12 bg-elevated-2 p-10 inset-ring inset-ring-accent-line"
        >
          <div className="size-28 shrink-0 overflow-hidden rounded-6 bg-surface">
            {image.status === "ready" ? (
              <img src={image.src} alt="" draggable={false} className="size-full object-cover" />
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-micro font-semibold tracking-[0.6px] text-text-tertiary">
              {kind === "start" ? t("video.frames.start") : t("video.frames.end")}
            </span>
            <span className="text-caption font-medium text-text-primary">{t("video.frames.oneImage")}</span>
          </div>
          <IconButton
            variant="ghost"
            size={24}
            icon={X}
            label={removeLabel}
            disabled={disabled}
            onClick={onRemove}
            className="absolute top-2 right-2 bg-overlay text-overlay-fg hover:bg-overlay hover:text-overlay-fg"
          />
        </fieldset>
      ) : (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || uploading}
              aria-label={addLabel}
              className={cn(
                "flex size-full cursor-pointer flex-col justify-between overflow-hidden rounded-12 bg-elevated-2 p-10 text-left inset-ring transition-colors disabled:cursor-default",
                dragOver
                  ? "inset-ring-2 inset-ring-accent-line"
                  : "inset-ring-border hover:inset-ring-border-strong",
              )}
            >
              {uploading ? (
                <Spinner size={14} className="text-text-tertiary" />
              ) : (
                <Plus size={14} aria-hidden className="text-text-tertiary" />
              )}
              <span className="flex flex-col gap-1">
                <span className="text-micro font-semibold tracking-[0.6px] text-text-tertiary">
                  {kind === "start" ? t("video.frames.start") : t("video.frames.end")}
                </span>
                <span className="text-caption font-medium text-text-secondary">
                  {kind === "start" ? t("video.frames.addImage") : t("video.frames.optional")}
                </span>
              </span>
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem icon={Upload} onSelect={() => files.current?.click()}>
              {t("video.frames.upload")}
            </MenuItem>
            <MenuItem icon={FolderOpen} onSelect={() => setPickerOpen(true)}>
              {t("video.frames.fromLibrary")}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      <FramePicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={onPick} />
    </div>
  );
}
