import { t } from "@openfield/core";
import {
  cn,
  Divider,
  IconButton,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuTrigger,
  Surface,
  Tooltip,
} from "@openfield/ui";
import { useViewport } from "@xyflow/react";
import { Map as MapIcon, Minus, Plus, Scan, ScanSearch } from "lucide-react";
import { useCanvasActions, useUi } from "../../store";
import { toolKey } from "../shortcuts";
import type { EditorCommands } from "../use-commands";
import { Minimap } from "./minimap";
import { setMinimapPref } from "./prefs";

// Zoom cluster (design ehbF7): a 205×40 floating bar at the bottom left, radius 12, padding 0 6,
// gap 4: − 100% + | Fit | Minimap. The percentage opens the zoom menu (L5XKz); the minimap
// (zM5C9) sits 8 above the cluster at the same width.

const PRESETS = [
  [0.25, 0.5, 0.75],
  [1, 1.5, 2],
] as const;

const percent = (zoom: number) => t("canvas.editor.zoom.percent", { value: Math.round(zoom * 100) });

export function ZoomCluster({ commands }: { commands: EditorCommands }) {
  const { zoom } = useViewport();
  const minimapOpen = useUi((ui) => ui.minimapOpen);
  const actions = useCanvasActions();

  const toggleMinimap = () => {
    actions.setUi({ minimapOpen: !minimapOpen });
    setMinimapPref(!minimapOpen);
  };

  return (
    <div className="absolute bottom-12 left-12 z-10 flex w-205 flex-col gap-8">
      {minimapOpen ? <Minimap /> : null}
      <Surface
        variant="floating-bar"
        role="group"
        aria-label={t("canvas.editor.zoom.label")}
        className="h-40 w-205 gap-4 rounded-12 px-6 py-0"
      >
        <div className="flex h-36 items-center">
          <IconButton icon={Minus} label={t("canvas.editor.zoom.out")} onClick={commands.zoomOut} />
          <ZoomMenu zoom={zoom} commands={commands} />
          <IconButton icon={Plus} label={t("canvas.editor.zoom.in")} onClick={commands.zoomIn} />
        </div>
        <Divider orientation="vertical" size={20} />
        <Tooltip
          content={t("canvas.editor.zoom.fit")}
          shortcut={toolKey("zoom.fit")}
          side="top"
          sideOffset={8}
        >
          <IconButton icon={Scan} label={t("canvas.editor.zoom.fit")} onClick={commands.fit} />
        </Tooltip>
        <Tooltip content={t("canvas.editor.zoom.minimap")} side="top" sideOffset={8}>
          <IconButton
            icon={MapIcon}
            label={t(minimapOpen ? "canvas.editor.zoom.hideMinimap" : "canvas.editor.zoom.showMinimap")}
            active={minimapOpen}
            aria-pressed={minimapOpen}
            onClick={toggleMinimap}
          />
        </Tooltip>
      </Surface>
    </div>
  );
}

/** From the % button (46, 854 on a 900 tall screen) to the menu's corner at (229, 840). */
const MENU_SIDE_OFFSET = 14;
const MENU_ALIGN_OFFSET = 183;

const presetClass =
  "h-30 flex-1 justify-center gap-0 px-0 [&>span]:flex-none [&>span]:text-center text-mono-12 data-highlighted:bg-elevated-2";

function ZoomMenu({ zoom, commands }: { zoom: number; commands: EditorCommands }) {
  const current = Math.round(zoom * 100);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t("canvas.editor.zoom.level")}
          className="flex h-28 w-52 cursor-pointer items-center justify-center rounded-8 text-mono-12 text-text-primary hover:bg-elevated-2"
        >
          {percent(zoom)}
        </button>
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        // Opens beside the minimap, not over it (kit L5XKz sits at 229, 8 above the cluster).
        sideOffset={MENU_SIDE_OFFSET}
        alignOffset={MENU_ALIGN_OFFSET}
        className="w-220 gap-4 p-6"
      >
        {PRESETS.map((row) => (
          <MenuGroup key={row[0]} className="flex w-full gap-4">
            {row.map((level) => {
              const on = current === Math.round(level * 100);
              return (
                <MenuItem
                  key={level}
                  onSelect={() => commands.zoomTo(level)}
                  className={cn(
                    presetClass,
                    on
                      ? "bg-segment-on font-semibold text-text-primary inset-ring inset-ring-segment-on-line"
                      : "font-medium text-text-tertiary",
                  )}
                >
                  {percent(level)}
                </MenuItem>
              );
            })}
          </MenuGroup>
        ))}
        <div className="w-full p-4">
          <hr className="h-px w-full border-0 bg-border" />
        </div>
        <MenuItem icon={Scan} shortcut={toolKey("zoom.fit")} onSelect={commands.fit}>
          {t("canvas.editor.zoom.fit")}
        </MenuItem>
        <MenuItem icon={ScanSearch} shortcut={toolKey("zoom.selection")} onSelect={commands.zoomToSelection}>
          {t("canvas.editor.zoom.selection")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
