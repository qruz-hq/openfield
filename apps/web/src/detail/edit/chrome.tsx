import { type MessageKey, t } from "@openfield/core";
import { cn, Divider, IconButton, Slider, Tooltip } from "@openfield/ui";
import {
  Brush,
  Contrast,
  Eraser,
  Eye,
  Hand,
  Lasso,
  type LucideIcon,
  Minus,
  Plus,
  Redo2,
  SquareDashed,
  Trash2,
  Undo2,
} from "lucide-react";
import type { MouseEvent } from "react";
import { isMac } from "../../canvas/editor/shortcuts";
import { toolShortcut } from "./keys";
import { BRUSH_SLIDER_STEPS, type MaskTool, sizeOfSlider, sliderOfSize, useEditSession } from "./session";

// The Edit tab's floating chrome over the media area (design f90S4YuAoH and friends): the toolbar
// (Image edit / Toolbar), the bar above it with the tool's options (Image edit / Brush options and
// / Shape options) and the zoom control at the bottom left (Editor / Zoom control).

/**
 * Toolbar buttons keep focus where it was, on the view, so holding Space pans right after a click
 * instead of pressing the button again. Tab still reaches them from the keyboard.
 */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** Icon button / Tool / 36, dimmed to 40% when it can't do anything yet (design jk02HG1ctk). */
const dimmed = "disabled:text-text-secondary disabled:opacity-40";

const TOOLS: Record<MaskTool, { icon: LucideIcon; label: MessageKey }> = {
  pan: { icon: Hand, label: "edit.tools.pan" },
  brush: { icon: Brush, label: "edit.tools.brush" },
  eraser: { icon: Eraser, label: "edit.tools.eraser" },
  lasso: { icon: Lasso, label: "edit.tools.lasso" },
  rect: { icon: SquareDashed, label: "edit.tools.rectangle" },
};

function ToolButton({
  icon,
  label,
  shortcut,
  active,
  disabled,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string | undefined;
  active?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label} shortcut={shortcut} side="top" sideOffset={8}>
      <IconButton
        variant="tool"
        icon={icon}
        label={label}
        active={active}
        aria-pressed={pressed}
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={onClick}
        className={dimmed}
      />
    </Tooltip>
  );
}

/**
 * Image edit / Toolbar: Pan | Brush, Eraser, Lasso, Rectangle | Invert, Clear | Undo, Redo. It rests
 * at 40% while a run goes or the photo can't take a mask (design DFd2yqIj0C, 6YuF99zpGo).
 */
export function EditToolbar({ resting = false }: { resting?: boolean }) {
  const tool = useEditSession((s) => s.tool);
  const mask = useEditSession((s) => s.mask);
  const { setTool, invert, clear, undo, redo } = useEditSession.getState();
  const mac = isMac();
  const pick = (id: MaskTool) => (
    <ToolButton
      icon={TOOLS[id].icon}
      label={t(TOOLS[id].label)}
      shortcut={toolShortcut[id]}
      active={tool === id}
      pressed={tool === id}
      onClick={() => setTool(id)}
    />
  );
  return (
    <div
      role="toolbar"
      aria-label={t("edit.tools.label")}
      inert={resting}
      className={cn(
        "absolute bottom-16 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-12 bg-elevated p-4 inset-ring inset-ring-border",
        resting && "opacity-40",
      )}
    >
      {pick("pan")}
      <Divider orientation="vertical" size={20} />
      {pick("brush")}
      {pick("eraser")}
      {pick("lasso")}
      {pick("rect")}
      <Divider orientation="vertical" size={20} />
      <ToolButton icon={Contrast} label={t("edit.tools.invert")} onClick={invert} />
      <ToolButton icon={Trash2} label={t("edit.tools.clear")} disabled={mask.empty} onClick={clear} />
      <Divider orientation="vertical" size={20} />
      <ToolButton
        icon={Undo2}
        label={t("edit.tools.undo")}
        shortcut={mac ? "⌘Z" : "Ctrl+Z"}
        disabled={!mask.canUndo}
        onClick={undo}
      />
      <ToolButton
        icon={Redo2}
        label={t("edit.tools.redo")}
        shortcut={mac ? "⇧⌘Z" : "Shift+Ctrl+Z"}
        disabled={!mask.canRedo}
        onClick={redo}
      />
    </div>
  );
}

/** Size, Hardness or Mask: a 12/500 label, a 96 wide slider and a 40 wide mono value. */
function OptionSlider({
  icon,
  label,
  value,
  max,
  shown,
  onChange,
}: {
  icon?: LucideIcon;
  label: string;
  value: number;
  max: number;
  shown: string;
  onChange: (value: number) => void;
}) {
  const Icon = icon;
  return (
    <div className="flex items-center gap-8">
      {Icon ? <Icon size={14} aria-hidden className="shrink-0 text-text-secondary" /> : null}
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <Slider
        value={[value]}
        min={0}
        max={max}
        step={1}
        thumbLabel={label}
        onValueChange={([next]) => next !== undefined && onChange(next)}
        className="w-96"
      />
      <span className="w-40 shrink-0 text-mono-12 text-text-primary">{shown}</span>
    </div>
  );
}

const optionsBar =
  "absolute bottom-68 left-1/2 flex h-44 -translate-x-1/2 items-center gap-12 rounded-12 bg-elevated px-14 inset-ring inset-ring-border";

function MaskOpacity() {
  const opacity = useEditSession((s) => s.maskOpacity);
  return (
    <OptionSlider
      icon={Eye}
      label={t("edit.options.mask")}
      value={opacity}
      max={100}
      shown={t("edit.options.percent", { value: opacity })}
      onChange={useEditSession.getState().setMaskOpacity}
    />
  );
}

/** Image edit / Brush options: Size | Hardness | Mask, for the brush and the eraser. */
export function BrushOptions() {
  const size = useEditSession((s) => s.brushSize);
  const hardness = useEditSession((s) => s.hardness);
  const { setBrushSize, setHardness } = useEditSession.getState();
  return (
    <fieldset aria-label={t("edit.options.brush")} className={optionsBar}>
      <OptionSlider
        label={t("edit.options.size")}
        value={sliderOfSize(size)}
        max={BRUSH_SLIDER_STEPS}
        shown={t("edit.options.px", { value: size })}
        onChange={(value) => {
          // Near 1 px several slider steps round to one size; an arrow key still moves it a pixel.
          const next = sizeOfSlider(value);
          setBrushSize(next !== size ? next : size + Math.sign(value - sliderOfSize(size)));
        }}
      />
      <Divider orientation="vertical" size={20} />
      <OptionSlider
        label={t("edit.options.hardness")}
        value={hardness}
        max={100}
        shown={t("edit.options.percent", { value: hardness })}
        onChange={setHardness}
      />
      <Divider orientation="vertical" size={20} />
      <MaskOpacity />
    </fieldset>
  );
}

/** Image edit / Shape options: how to draw the lasso or the box | Mask. */
export function ShapeOptions({ tool }: { tool: "lasso" | "rect" }) {
  return (
    <fieldset aria-label={t("edit.options.shape")} className={optionsBar}>
      <span className="whitespace-nowrap text-caption text-text-secondary">
        {t(tool === "lasso" ? "edit.options.lassoHint" : "edit.options.rectangleHint")}
      </span>
      <Divider orientation="vertical" size={20} />
      <MaskOpacity />
    </fieldset>
  );
}

/**
 * Editor / Zoom control: − 100% + on the overlay fill, bottom left. It sits over the image's blurred
 * copy, so it takes the overlay's own colours, which stay readable in the light theme too.
 */
export function ZoomControl({
  zoom,
  onZoomIn,
  onZoomOut,
}: {
  /** Screen px per image px. */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const overlayButton =
    "text-overlay-fg-muted not-disabled:hover:bg-overlay-line not-disabled:hover:text-overlay-fg";
  return (
    <fieldset
      aria-label={t("edit.zoom.label")}
      className="absolute bottom-16 left-16 flex h-36 items-center rounded-10 bg-overlay px-4 inset-ring inset-ring-overlay-line backdrop-blur-panel"
    >
      <IconButton
        icon={Minus}
        label={t("edit.zoom.out")}
        onMouseDown={keepFocus}
        onClick={onZoomOut}
        className={overlayButton}
      />
      <div className="flex h-28 w-52 items-center justify-center">
        <span className="text-mono-12 text-overlay-fg">
          {t("edit.zoom.percent", { value: Math.round(zoom * 100) })}
        </span>
      </div>
      <IconButton
        icon={Plus}
        label={t("edit.zoom.in")}
        onMouseDown={keepFocus}
        onClick={onZoomIn}
        className={overlayButton}
      />
    </fieldset>
  );
}
