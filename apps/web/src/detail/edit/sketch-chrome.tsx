import { MARKS_MAX, type Mark, type MessageKey, t } from "@openfield/core";
import {
  cn,
  Divider,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  SegmentedItem,
  Tooltip,
} from "@openfield/ui";
import {
  Brush,
  Circle,
  Crosshair,
  Hand,
  type LucideIcon,
  MoveUpRight,
  Pipette,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isMac } from "../../canvas/editor/shortcuts";
import { keepFocus, optionsBar, ToolButton, toolbarClass } from "./chrome";
import { sketchShortcut } from "./keys";
import { type EditMode, useEditSession } from "./session";
import { CHIP_PX, isLightColor, MARK_PRESETS, normalHex, type SketchTool } from "./sketch";

// Sketch & point's chrome over the media area: the switch between the two ways to show a change
// (Image edit / Mode switch), the toolbar (Image edit / Toolbar / Sketch & point, gE73OxCUB4), the
// hint above it (Image edit / Sketch hint, YDcIyHcwgu) and the picked mark's popover (Image edit /
// Mark popover, 1Z8HRn00FF), whose colour field the toolbar's swatch shares.

/** Image edit / Mode switch: Paint area | Sketch & point, a 236 wide Segmented / 2. */
export function ModeSwitch() {
  const mode = useEditSession((s) => s.mode);
  return (
    <ModeSegmented
      value={mode}
      onChange={(next) => useEditSession.getState().setMode(next)}
      className="w-236 shrink-0"
    />
  );
}

/**
 * The same switch on any value: the edit window's toolbar holds the session's, a canvas Edit node's
 * settings hold the node's (design RIMVE6Wb5c, full width).
 */
export function ModeSegmented({
  value,
  onChange,
  disabled,
  className,
  ...props
}: {
  value: EditMode;
  onChange: (mode: EditMode) => void;
  disabled?: boolean;
  className?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <Segmented
      aria-label={props["aria-labelledby"] ? undefined : t("edit.mode.label")}
      aria-labelledby={props["aria-labelledby"]}
      value={value}
      onValueChange={(next) => onChange(next as EditMode)}
      onMouseDown={keepFocus}
      disabled={disabled}
      className={className}
    >
      <SegmentedItem value="paint">{t("edit.mode.paint")}</SegmentedItem>
      <SegmentedItem value="sketch">{t("edit.mode.sketch")}</SegmentedItem>
    </Segmented>
  );
}

const TOOLS: Record<SketchTool, { icon: LucideIcon; label: MessageKey }> = {
  pan: { icon: Hand, label: "edit.sketch.tools.pan" },
  brush: { icon: Brush, label: "edit.sketch.tools.brush" },
  circle: { icon: Circle, label: "edit.sketch.tools.circle" },
  box: { icon: Square, label: "edit.sketch.tools.box" },
  arrow: { icon: MoveUpRight, label: "edit.sketch.tools.arrow" },
  point: { icon: Crosshair, label: "edit.sketch.tools.point" },
};

/**
 * Image edit / Toolbar / Sketch & point: the switch | Pan | Sketch, Circle, Box, Arrow, Point | the
 * next mark's colour | Undo, Redo, Clear. Rests at 40% while a run goes, as the mask's does.
 */
export function SketchToolbar({ resting = false, className }: { resting?: boolean; className?: string }) {
  const tool = useEditSession((s) => s.sketchTool);
  const marks = useEditSession((s) => s.marks.length);
  const canUndo = useEditSession((s) => s.marksPast.length > 0);
  const canRedo = useEditSession((s) => s.marksFuture.length > 0);
  const { setTool, undo, redo, clearMarks } = useEditSession.getState();
  const mac = isMac();
  const pick = (id: SketchTool) => (
    <ToolButton
      icon={TOOLS[id].icon}
      label={t(TOOLS[id].label)}
      shortcut={sketchShortcut[id]}
      active={tool === id}
      pressed={tool === id}
      onClick={() => setTool(id)}
    />
  );
  return (
    <div
      role="toolbar"
      aria-label={t("edit.sketch.tools.label")}
      inert={resting}
      className={cn(toolbarClass, resting && "opacity-40", className)}
    >
      <ModeSwitch />
      <Divider orientation="vertical" size={20} />
      {pick("pan")}
      <Divider orientation="vertical" size={20} />
      {pick("brush")}
      {pick("circle")}
      {pick("box")}
      {pick("arrow")}
      {pick("point")}
      <Divider orientation="vertical" size={20} />
      <ColorButton />
      <Divider orientation="vertical" size={20} />
      <ToolButton
        icon={Undo2}
        label={t("edit.tools.undo")}
        shortcut={mac ? "⌘Z" : "Ctrl+Z"}
        disabled={!canUndo}
        onClick={undo}
      />
      <ToolButton
        icon={Redo2}
        label={t("edit.tools.redo")}
        shortcut={mac ? "⇧⌘Z" : "Shift+Ctrl+Z"}
        disabled={!canRedo}
        onClick={redo}
      />
      <ToolButton
        icon={Trash2}
        label={t("edit.sketch.tools.clear")}
        disabled={marks === 0}
        onClick={clearMarks}
      />
    </div>
  );
}

/** The toolbar's Color cell: an 18 px swatch of the next mark's colour, opening the colour field. */
function ColorButton() {
  const color = useEditSession((s) => s.markColor);
  const label = t("edit.sketch.tools.color");
  return (
    <Popover>
      <Tooltip content={label} side="top" sideOffset={8}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onMouseDown={keepFocus}
            className="flex size-36 shrink-0 cursor-pointer items-center justify-center rounded-8 hover:bg-elevated-2"
          >
            <span
              data-color-swatch
              className="size-18 rounded-full border-2 border-border-strong bg-clip-padding"
              style={{ backgroundColor: color }}
            />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={12}
        onCloseAutoFocus={focusView}
        className={popoverClass}
      >
        <ColorField value={color} onChange={useEditSession.getState().setMarkColor} />
      </PopoverContent>
    </Popover>
  );
}

/** Image edit / Sketch hint: what the tool in hand does, or that there's no room for another mark. */
export function SketchHint({ model, className }: { model: string | undefined; className?: string }) {
  const tool = useEditSession((s) => s.sketchTool);
  const full = useEditSession((s) => s.marks.length >= MARKS_MAX);
  if (tool === "pan" && !full) return null;
  return (
    <div role="status" className={cn(optionsBar, className)}>
      <span className="whitespace-nowrap text-caption font-normal text-text-secondary">
        {full
          ? t("edit.sketch.hints.full", { model: model ?? "", max: MARKS_MAX })
          : t(`edit.sketch.hints.${tool as Exclude<SketchTool, "pan">}`)}
      </span>
    </div>
  );
}

/**
 * Hands focus back to the detail view as a popover closes, so the tools' keys go on working. The
 * view's own element is the dialog the media area is in.
 */
const focusView = (event: Event) => {
  event.preventDefault();
  document
    .querySelector("[data-sketch-input], [data-paint-input]")
    ?.closest<HTMLElement>("[role='dialog']")
    ?.focus({ preventScroll: true });
};

/** Image edit / Mark popover's box: 264 wide, 12 in, 12 between its parts. */
const popoverClass = "w-264 gap-12 rounded-14 p-12";

/** The EyeDropper API, where the browser has it (Chromium). */
interface EyeDropperLike {
  open: () => Promise<{ sRGBHex: string }>;
}
const eyeDropper = (): EyeDropperLike | null => {
  const Ctor = (window as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  return Ctor ? new Ctor() : null;
};

/**
 * Image edit / Mark popover / Color: the swatch, the hex and the eyedropper in a row, then the eight
 * presets spread across. The hex takes effect once it's a whole colour.
 */
export function ColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const canPick = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    try {
      const picked = await eyeDropper()?.open();
      const hex = picked && normalHex(picked.sRGBHex);
      if (hex) onChange(hex);
    } catch {
      // Esc closes the eyedropper without a colour: nothing changes.
    }
  };
  return (
    <div className="flex w-full flex-col gap-8">
      <span className="text-caption font-medium text-text-tertiary">{t("edit.sketch.color")}</span>
      <div className="flex w-full items-center gap-8">
        <span
          aria-hidden
          className="size-32 shrink-0 rounded-8 inset-ring inset-ring-border-strong"
          style={{ backgroundColor: value }}
        />
        <Input
          mono
          aria-label={t("edit.sketch.hex")}
          value={text}
          spellCheck={false}
          maxLength={7}
          onChange={(event) => {
            setText(event.target.value);
            const hex = normalHex(event.target.value);
            if (hex) onChange(hex);
          }}
          onBlur={() => setText(value)}
          boxClassName="h-32 flex-1"
        />
        {canPick ? (
          <IconButton
            variant="secondary"
            size={32}
            icon={Pipette}
            label={t("edit.sketch.pick")}
            onClick={() => void pickFromScreen()}
          />
        ) : null}
      </div>
      <div className="flex w-full items-center justify-between">
        {MARK_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={t("edit.sketch.preset", { color: preset })}
            aria-pressed={preset === value}
            onClick={() => onChange(preset)}
            className={cn(
              "size-20 shrink-0 cursor-pointer rounded-full",
              preset === value
                ? "outline-2 outline-offset-0 outline-accent"
                : "inset-ring inset-ring-border-strong",
            )}
            style={{ backgroundColor: preset }}
          />
        ))}
      </div>
    </div>
  );
}

const KIND_KEYS: Record<Mark["kind"], MessageKey> = {
  point: "edit.sketch.kinds.point",
  box: "edit.sketch.kinds.box",
  circle: "edit.sketch.kinds.circle",
  stroke: "edit.sketch.kinds.stroke",
  arrow: "edit.sketch.kinds.arrow",
};

/** "Box", "Sketch": a mark's kind as the list and the popover name it. */
export const kindName = (mark: Mark) => t(KIND_KEYS[mark.kind]);

/**
 * Image edit / Mark popover: the mark's chip and name with Remove, its colour, an optional material,
 * and the note that both go into the prompt. Focus stays on the view, so the tools' keys still work.
 */
export function MarkPopover({ index, mark }: { index: number; mark: Mark }) {
  const n = index + 1;
  const { updateMark, removeMark, recordMarks } = useEditSession.getState();
  // The marks when the material field was focused: typing in it is one step for Undo.
  const before = useRef<readonly Mark[] | null>(null);
  return (
    <PopoverContent
      side="right"
      align="start"
      sideOffset={14}
      collisionPadding={16}
      onOpenAutoFocus={(event) => event.preventDefault()}
      // It has no trigger to hand focus back to: the view takes it.
      onCloseAutoFocus={focusView}
      aria-label={t("edit.sketch.markTitle", { n, kind: kindName(mark) })}
      className={popoverClass}
    >
      {/* Header */}
      <div className="flex w-full items-center gap-8">
        <MarkChip mark={mark} n={n} selected={false} />
        <p className="min-w-0 flex-1 text-small font-semibold text-text-primary">
          {t("edit.sketch.markTitle", { n, kind: kindName(mark) })}
        </p>
        <IconButton icon={Trash2} label={t("edit.sketch.remove", { n })} onClick={() => removeMark(index)} />
      </div>
      <ColorField value={mark.color ?? "#F5F6F7"} onChange={(color) => updateMark(index, { color })} />
      {/* Material */}
      <div className="flex w-full flex-col gap-8">
        <div className="flex w-full items-center justify-between">
          <label htmlFor="mark-material" className="text-caption font-medium text-text-tertiary">
            {t("edit.sketch.material")}
          </label>
          <span className="text-micro font-normal text-text-tertiary">{t("edit.sketch.optional")}</span>
        </div>
        <Input
          id="mark-material"
          value={mark.material ?? ""}
          maxLength={80}
          placeholder={t("edit.sketch.materialPlaceholder")}
          onFocus={() => {
            before.current = useEditSession.getState().marks;
          }}
          onChange={(event) => {
            const material = event.target.value;
            updateMark(index, { material: material.trim() ? material : undefined }, false);
          }}
          onBlur={() => {
            if (before.current) recordMarks(before.current);
            before.current = null;
          }}
          boxClassName="h-32"
        />
      </div>
      <p className="w-full text-micro font-normal text-text-tertiary">{t("edit.sketch.note")}</p>
    </PopoverContent>
  );
}

/** Sketch / Mark chip (and / Selected): the mark's number on its colour, 22 across. */
export function MarkChip({
  mark,
  n,
  selected,
  at,
}: {
  mark: Mark;
  n: number;
  selected: boolean;
  /** Its centre over the image; without one it sits in the flow, as in the list and the popover. */
  at?: { x: number; y: number };
}) {
  const color = mark.color ?? "#F5F6F7";
  return (
    <span
      data-mark-chip={n}
      aria-hidden
      className={cn(
        "flex size-22 shrink-0 items-center justify-center rounded-[11px] border-2 text-[11px] leading-none font-semibold",
        selected ? "border-accent" : "border-surface",
        at && "absolute",
      )}
      style={{
        backgroundColor: color,
        color: isLightColor(color) ? "#14161A" : "#FFFFFF",
        ...(at && { left: at.x - CHIP_PX / 2, top: at.y - CHIP_PX / 2 }),
      }}
    >
      {n}
    </span>
  );
}
