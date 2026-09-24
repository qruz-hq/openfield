import { type MessageKey, t } from "@openfield/core";
import { Button, Divider, IconButton, Surface, Tooltip } from "@openfield/ui";
import { type ReactFlowState, useStore } from "@xyflow/react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  Copy,
  Group,
  type LucideIcon,
  Play,
  Trash2,
} from "lucide-react";
import { type ReactElement, useCallback } from "react";
import { shallow } from "zustand/shallow";
import { tightCost } from "../../../lib/cost";
import { roundToCents, sumEstimates } from "../../engine/cost";
import { useEngineStore } from "../../engine/engine-store";
import { nodeRegistry } from "../../nodes/registry";
import { useCanvas } from "../../store";
import type { Alignment } from "../geometry";
import { toolKey } from "../shortcuts";
import type { EditorCommands } from "../use-commands";

// Context toolbar (design NVGGf, placed as HJfx0 on doZgF): above a multi-selection, centred on its
// box, 12 above it, labels included. Align ×6 | Distribute ×2 | Group into frame · Duplicate | Run · Delete.

const GAP = 12;
/** Node labels sit this far above their frames, in pane units (design JXox3). */
const LABEL_BAND = 22;
const BAR_HEIGHT = 48;
/** Never under the top bar. */
const MIN_TOP = 64;

const ALIGN: { how: Alignment; label: MessageKey; icon: LucideIcon }[] = [
  { how: "left", label: "canvas.editor.selection.alignLeft", icon: AlignStartVertical },
  { how: "center", label: "canvas.editor.selection.alignCenter", icon: AlignCenterVertical },
  { how: "right", label: "canvas.editor.selection.alignRight", icon: AlignEndVertical },
  { how: "top", label: "canvas.editor.selection.alignTop", icon: AlignStartHorizontal },
  { how: "middle", label: "canvas.editor.selection.alignMiddle", icon: AlignCenterHorizontal },
  { how: "bottom", label: "canvas.editor.selection.alignBottom", icon: AlignEndHorizontal },
];

export function ContextToolbar({ commands }: { commands: EditorCommands }) {
  const ids = useCanvas((s) => s.selection.nodeIds);
  const runnable = useCanvas((s) =>
    s.selection.nodeIds.some((id) => nodeRegistry.get(s.doc.nodes[id]?.type ?? "")?.runnable),
  );
  const runReady = useCanvas((s) => s.runController.ready);
  // What running the selected nodes costs, from the engine's live estimates: up-to-date ones are
  // free, and blocked or already running ones don't run.
  const price = useEngineStore((s) => {
    const estimates = ids.flatMap((id) => {
      const a = s.analysis.nodes[id];
      // Cent by cent, like the node pills, Run all and the run preview.
      return a?.estimate && !a.upToDate && !a.blocker && !a.held ? [roundToCents(a.estimate)] : [];
    });
    return estimates.length ? tightCost(sumEstimates(estimates)) : undefined;
  });

  const selectBox = useCallback(
    (s: ReactFlowState) => {
      let x1 = Number.POSITIVE_INFINITY;
      let y1 = Number.POSITIVE_INFINITY;
      let x2 = Number.NEGATIVE_INFINITY;
      let y2 = Number.NEGATIVE_INFINITY;
      for (const id of ids) {
        const node = s.nodeLookup.get(id);
        if (!node || node.hidden) continue;
        const { x, y } = node.internals.positionAbsolute;
        x1 = Math.min(x1, x);
        y1 = Math.min(y1, y);
        x2 = Math.max(x2, x + (node.measured.width ?? 0));
        y2 = Math.max(y2, y + (node.measured.height ?? 0));
      }
      if (!Number.isFinite(x1)) return null;
      const [tx, ty, zoom] = s.transform;
      return {
        left: x1 * zoom + tx,
        right: x2 * zoom + tx,
        top: (y1 - LABEL_BAND) * zoom + ty,
        paneWidth: s.width,
      };
    },
    [ids],
  );
  const box = useStore(selectBox, shallow);

  if (ids.length < 2 || !box) return null;
  const centre = (box.left + box.right) / 2;
  const top = Math.max(MIN_TOP, box.top - GAP - BAR_HEIGHT);

  return (
    <div
      className="pointer-events-none absolute z-10 flex w-0 justify-center"
      style={{ left: Math.min(Math.max(centre, 0), box.paneWidth), top }}
    >
      <Surface
        variant="floating-bar"
        role="toolbar"
        aria-label={t("canvas.editor.selection.label")}
        className="pointer-events-auto h-48 shrink-0 gap-2 p-6"
      >
        {ALIGN.map((a) => (
          <Tip key={a.how} label={a.label}>
            <IconButton size={32} icon={a.icon} label={t(a.label)} onClick={() => commands.align(a.how)} />
          </Tip>
        ))}
        <Divider orientation="vertical" size={20} />
        <Tip label="canvas.editor.selection.distributeAcross">
          <IconButton
            size={32}
            icon={AlignHorizontalSpaceAround}
            label={t("canvas.editor.selection.distributeAcross")}
            disabled={ids.length < 3}
            onClick={() => commands.distribute("x")}
          />
        </Tip>
        <Tip label="canvas.editor.selection.distributeDown">
          <IconButton
            size={32}
            icon={AlignVerticalSpaceAround}
            label={t("canvas.editor.selection.distributeDown")}
            disabled={ids.length < 3}
            onClick={() => commands.distribute("y")}
          />
        </Tip>
        <Divider orientation="vertical" size={20} />
        <Tooltip
          content={t("canvas.editor.selection.group")}
          shortcut={toolKey("group")}
          side="top"
          sideOffset={8}
        >
          <Button variant="ghost" size="s" icon={Group} onClick={commands.group}>
            {t("canvas.editor.selection.group")}
          </Button>
        </Tooltip>
        <Tip label="canvas.editor.selection.duplicate" shortcut={toolKey("duplicate")}>
          <IconButton
            size={32}
            icon={Copy}
            label={t("canvas.editor.selection.duplicate")}
            onClick={commands.duplicateSelection}
          />
        </Tip>
        <Divider orientation="vertical" size={20} />
        <Button
          variant="primary"
          size="s"
          icon={Play}
          price={price}
          disabled={!runnable || !runReady}
          onClick={() => commands.run("selection")}
        >
          {t("canvas.editor.selection.run")}
        </Button>
        <Tip label="canvas.editor.selection.delete" shortcut={toolKey("delete")}>
          <IconButton
            size={32}
            icon={Trash2}
            tone="danger"
            label={t("canvas.editor.selection.delete")}
            onClick={commands.deleteSelection}
          />
        </Tip>
      </Surface>
    </div>
  );
}

function Tip({
  label,
  shortcut,
  children,
}: {
  label: MessageKey;
  shortcut?: string;
  children: ReactElement;
}) {
  return (
    <Tooltip content={t(label)} shortcut={shortcut} side="top" sideOffset={8}>
      {children}
    </Tooltip>
  );
}
