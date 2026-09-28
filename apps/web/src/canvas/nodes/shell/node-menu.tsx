import { type ErrorCode, errorCopy, t } from "@openfield/core";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@openfield/ui";
import {
  ClipboardCopy,
  Copy,
  Download,
  FastForward,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  PencilLine,
  Play,
  ScrollText,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { type SyntheticEvent, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { errorMessage } from "../../../api/raw";
import { notify, notifyError } from "../../../lib/notify";
import { toolKey } from "../../editor/shortcuts";
import { useCanvasActions, useCanvasShallow, useCanvasStoreApi, useLocked } from "../../store/context";
import { downloadAssets } from "./download";
import { useLockActions } from "./use-lock";

// Canvas / Node / Menu (design L8nXKV): right-click on a node, or ⇧F10 and the menu key on a
// focused one. 240 wide, 4 padding, the run items only on nodes that run. The menu opens at the
// pointer; its trigger is a point portaled to the page, since the node itself sits inside the
// pane's zoom transform. Holding ⌥ on a run item makes new images even when nothing changed (§7.7).
// Locked (design NoE6t), Lock reads Unlock, and Run, Run from here and Delete wait for it at 40%.

export interface NodeMenuProps {
  id: string;
  /** The node's name, for the files Download saves. */
  name: string;
  at: { x: number; y: number } | null;
  onClose: () => void;
  runnable: boolean;
  collapsed: boolean;
  /** It has a settings drawer: the menu opens it, which is also the keyboard's way there. */
  inspectable?: boolean;
  /** "end": the menu's right edge sits at `at` (opened from the card's own menu button). */
  align?: "start" | "end";
}

/** A locked node's Run, Run from here and Delete: at 40% in their own colors, not greyed. */
const WAITS = "data-disabled:opacity-40 data-disabled:text-text-primary";

/** The error a failed node shows, for Copy error. */
function useNodeError(id: string): { code: string; reason?: string } | null {
  return useCanvasShallow((s) => {
    const result = s.doc.results[id];
    if (result?.state === "failed" && result.error) return result.error;
    const runtime = s.runtime[id];
    return runtime?.state === "failed" ? runtime.error : null;
  });
}

/** Images the node has to save: what it made, else the ones it holds (Upload, Assets). */
function useDownloadable(id: string): string[] {
  return useCanvasShallow((s) => {
    const made = s.doc.results[id]?.assetIds ?? [];
    const own = s.doc.params[id]?.assetIds;
    const ids = made.length ? made : Array.isArray(own) ? own.filter((a) => typeof a === "string") : [];
    return ids.filter((a) => !s.missingAssets.has(a));
  });
}

export function NodeMenu({
  id,
  name,
  at,
  onClose,
  runnable,
  collapsed,
  inspectable = false,
  align = "start",
}: NodeMenuProps) {
  const store = useCanvasStoreApi();
  const actions = useCanvasActions();
  const images = useDownloadable(id);
  const error = useNodeError(id);
  const locked = useLocked(id);
  const lock = useLockActions(id);
  const navigate = useNavigate();
  // Items are picked on pointer up or a key; either says whether ⌥ was held.
  const alt = useRef(false);
  const noteAlt = (event: SyntheticEvent) => {
    alt.current = (event.nativeEvent as KeyboardEvent | PointerEvent).altKey;
  };
  if (!at) return null;

  const run = (scope: "node" | "downstream") =>
    store.getState().runController.run({ scope, nodeIds: [id], bypassCache: alt.current });
  const download = () =>
    void downloadAssets(images, name).catch((failure: unknown) => notifyError(errorMessage(failure)));
  const copyError = () => {
    if (!error) return;
    const text = `${error.reason ?? errorCopy(error.code as ErrorCode).reason} (${error.code})`;
    navigator.clipboard.writeText(text).then(
      () => notify(t("toast.copied"), { tone: "success" }),
      () => notifyError(t("errors.transport.internal")),
    );
  };
  const remove = () => {
    const result = actions.deleteNodes([id]);
    if (!result.ok && result.reason === "running") notify(t("canvas.editor.toasts.running"));
  };

  return createPortal(
    <Menu open onOpenChange={(open) => !open && onClose()}>
      <MenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at.x, top: at.y }} />
      </MenuTrigger>
      <MenuContent
        align={align}
        side="bottom"
        sideOffset={0}
        className="w-240"
        aria-label={t("canvas.nodes.menu.label")}
        // Focus stays where the picked item sends it (Rename's field), not on the hidden trigger.
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDownCapture={noteAlt}
        onPointerUpCapture={noteAlt}
        onKeyDownCapture={noteAlt}
      >
        {runnable ? (
          <>
            <MenuItem
              icon={Play}
              shortcut={toolKey("run.node")}
              disabled={locked}
              className={WAITS}
              onSelect={() => void run("node")}
            >
              {t("canvas.nodes.menu.run")}
            </MenuItem>
            <MenuItem
              icon={FastForward}
              disabled={locked}
              className={WAITS}
              onSelect={() => void run("downstream")}
            >
              {t("canvas.nodes.menu.runFromHere")}
            </MenuItem>
          </>
        ) : null}
        {inspectable ? (
          <MenuItem icon={SlidersHorizontal} onSelect={() => actions.openInspector(id)}>
            {t("canvas.nodes.menu.settings")}
          </MenuItem>
        ) : null}
        {images.length ? (
          <MenuItem icon={Download} onSelect={download}>
            {images.length > 1
              ? t("canvas.nodes.menu.downloadMany", { count: images.length })
              : t("canvas.nodes.menu.download")}
          </MenuItem>
        ) : null}
        {error ? (
          <>
            <MenuItem icon={ClipboardCopy} onSelect={copyError}>
              {t("canvas.nodes.menu.copyError")}
            </MenuItem>
            <MenuItem icon={ScrollText} onSelect={() => navigate("/settings/help")}>
              {t("errors.errorLog")}
            </MenuItem>
          </>
        ) : null}
        <MenuItem icon={Copy} shortcut={toolKey("duplicate")} onSelect={() => actions.duplicateNodes([id])}>
          {t("canvas.nodes.menu.duplicate")}
        </MenuItem>
        <MenuItem
          icon={collapsed ? Maximize2 : Minimize2}
          onSelect={() => actions.apply([{ op: "setCollapsed", id, collapsed: !collapsed }])}
        >
          {collapsed ? t("canvas.nodes.menu.expand") : t("canvas.nodes.menu.collapse")}
        </MenuItem>
        <MenuItem icon={PencilLine} onSelect={() => actions.setUi({ renamingNodeId: id })}>
          {t("canvas.nodes.menu.rename")}
        </MenuItem>
        <MenuItem icon={locked ? LockOpen : Lock} shortcut={toolKey("lock")} onSelect={lock.toggle}>
          {locked ? t("canvas.nodes.menu.unlock") : t("canvas.nodes.menu.lock")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={Trash2}
          danger
          disabled={locked}
          className="data-disabled:text-danger data-disabled:opacity-40"
          onSelect={remove}
        >
          {t("canvas.nodes.menu.delete")}
        </MenuItem>
      </MenuContent>
    </Menu>,
    document.body,
  );
}
