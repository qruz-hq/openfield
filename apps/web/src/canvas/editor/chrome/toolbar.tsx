import { type MessageKey, t } from "@openfield/core";
import { Divider, IconButton, Surface, Tooltip } from "@openfield/ui";
import {
  Frame,
  Hand,
  type LucideIcon,
  MousePointer2,
  Plus,
  Search,
  Square,
  StickyNote,
  TextCursor,
} from "lucide-react";
import { Fragment } from "react";
import { useCanvasStoreApi, useUi } from "../../store";
import type { CanvasTool } from "../../store/types";
import { type ShortcutId, toolKey } from "../shortcuts";
import type { EditorCommands } from "../use-commands";

// Bottom toolbar (design p1WXGf): a 48 tall floating bar, padding 6, gap 2, of 36 px tool buttons
// in four groups: Select Pan | Note Shape Text | Frame | Find Add. Each tooltip names its key.
//
// The tools come from a manifest (§7.4). Slots the reference toolbar has and this build leaves out
// (Draw, Reaction, Comment, Page, Table) are entries behind a flag that's off, so adding one later
// is a manifest change, not a layout one. A slot whose flag is off renders nothing at all.

/** canvas.tools.* feature flags. Off until the tool ships; nothing unshipped shows (§0.15). */
export const CANVAS_TOOL_FLAGS = {
  "canvas.tools.draw": false,
  "canvas.tools.reactions": false,
  "canvas.tools.comments": false,
  "canvas.tools.pages": false,
  "canvas.tools.table": false,
} as const;
export type CanvasToolFlag = keyof typeof CANVAS_TOOL_FLAGS;

interface ShownTool {
  id: ShortcutId;
  label: MessageKey;
  icon: LucideIcon;
  tool?: CanvasTool;
  flag?: undefined;
}

/** A slot kept for a tool that hasn't shipped: no label or icon until it does. */
interface HiddenSlot {
  id: string;
  flag: CanvasToolFlag;
}

type ToolEntry = ShownTool | HiddenSlot;

export const TOOL_MANIFEST: readonly (readonly ToolEntry[])[] = [
  [
    { id: "tool.select", label: "canvas.editor.tools.select", icon: MousePointer2, tool: "select" },
    { id: "tool.pan", label: "canvas.editor.tools.pan", icon: Hand, tool: "pan" },
  ],
  [
    { id: "tool.note", label: "canvas.editor.tools.note", icon: StickyNote, tool: "note" },
    { id: "tool.shape", label: "canvas.editor.tools.shape", icon: Square, tool: "shape" },
    { id: "tool.text", label: "canvas.editor.tools.text", icon: TextCursor, tool: "text" },
    { id: "tool.draw", flag: "canvas.tools.draw" },
  ],
  [
    { id: "tool.frame", label: "canvas.editor.tools.frame", icon: Frame, tool: "frame" },
    { id: "tool.page", flag: "canvas.tools.pages" },
    { id: "tool.table", flag: "canvas.tools.table" },
  ],
  [
    { id: "tool.reaction", flag: "canvas.tools.reactions" },
    { id: "tool.comment", flag: "canvas.tools.comments" },
  ],
  [
    { id: "find", label: "canvas.editor.tools.find", icon: Search },
    { id: "add", label: "canvas.editor.tools.add", icon: Plus },
  ],
];

const isShown = (entry: ToolEntry): entry is ShownTool =>
  entry.flag === undefined || CANVAS_TOOL_FLAGS[entry.flag];

/** The groups as drawn: hidden slots left out, and a group with nothing left in it too. */
export const shownGroups = (): ShownTool[][] =>
  TOOL_MANIFEST.map((group) => group.filter(isShown)).filter((group) => group.length > 0);

export function Toolbar({ commands }: { commands: EditorCommands }) {
  const active = useUi((ui) => ui.tool);
  const findOpen = useUi((ui) => ui.findOpen);
  const store = useCanvasStoreApi();
  const addOpen = useUi((ui) => ui.addMenu !== null);

  const press = (tool: ShownTool) => {
    if (tool.tool) return commands.setTool(tool.tool);
    const { actions, ui } = store.getState();
    if (tool.id === "find") actions.setUi({ findOpen: !ui.findOpen });
    if (tool.id === "add") commands.openAddMenu();
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-10 flex justify-center">
      <Surface
        variant="floating-bar"
        role="toolbar"
        aria-label={t("canvas.editor.tools.label")}
        data-canvas-toolbar
        className="pointer-events-auto h-48 gap-2 p-6"
      >
        {shownGroups().map((group, i) => (
          <Fragment key={group[0]!.id}>
            {i > 0 ? <Divider orientation="vertical" size={20} /> : null}
            {group.map((tool) => {
              const on = tool.tool ? active === tool.tool : tool.id === "find" ? findOpen : addOpen;
              return (
                <Tooltip
                  key={tool.id}
                  content={t(tool.label)}
                  shortcut={toolKey(tool.id)}
                  side="top"
                  sideOffset={8}
                >
                  <IconButton
                    variant="tool"
                    icon={tool.icon}
                    label={t(tool.label)}
                    active={on}
                    aria-pressed={tool.tool ? on : undefined}
                    data-tool={tool.id}
                    onClick={() => press(tool)}
                  />
                </Tooltip>
              );
            })}
          </Fragment>
        ))}
      </Surface>
    </div>
  );
}
