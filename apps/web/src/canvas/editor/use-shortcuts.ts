import { t } from "@openfield/core";
import { useEffect } from "react";
import { announce } from "../../lib/live";
import { nodeRegistry } from "../nodes/registry";
import { useCanvasStoreApi } from "../store";
import { FRAGMENT_MIME } from "./clipboard";
import {
  cyclePort,
  focusOutsidePane,
  type HandleRef,
  handleRef,
  nextInWalk,
  nodeElement,
} from "./keyboard-nav";
import { useSession } from "./session";
import { isMac, matchShortcut, type ShortcutId } from "./shortcuts";
import type { EditorCommands } from "./use-commands";

// The editor is the only place that listens for global keys (§7.9). Text fields keep
// their keys, except the few that make sense while typing (⌘⏎, ⌘S, Esc...). Undo inside a node's
// text goes to the canvas history, which already holds every keystroke. Dialogs and menus handle
// their own keys. Copy, cut and paste use the clipboard events so no permission prompt is needed.

const NUDGE = 1;
const NUDGE_BIG = 10;

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
  );
}

const inOverlay = (el: Element | null) =>
  !!el?.closest("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]");

/**
 * Where Enter takes the keyboard in a node: its first text field, else its first button. Not its
 * ports, and not the label's rename (double-click and the node menu do that).
 */
function firstControl(node: HTMLElement): HTMLElement | null {
  const usable = (el: HTMLElement) =>
    !el.closest(".react-flow__handle") &&
    !(el as HTMLButtonElement).disabled &&
    el.tabIndex >= 0 &&
    el.getClientRects().length > 0;
  for (const selector of [
    "textarea, input:not([type=hidden]):not([hidden]), [contenteditable=true]",
    "button, select",
  ]) {
    const found = [...node.querySelectorAll<HTMLElement>(selector)].find(usable);
    if (found) return found;
  }
  return null;
}

export function useShortcuts(commands: EditorCommands) {
  const store = useCanvasStoreApi();
  const session = useSession();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof Element ? e.target : null;
      if (inOverlay(target)) return;
      const editable = isEditable(target);
      const inNode = !!target?.closest(".react-flow__node");
      let id = matchShortcut(e, isMac(), editable);
      if (!id && editable && inNode && (e.metaKey || e.ctrlKey)) {
        // Undo and redo in a node's text field walk the canvas history.
        const key = matchShortcut(e, isMac(), false);
        if (key === "undo" || key === "redo") id = key;
      }
      if (!id) return;

      const state = store.getState();
      const { actions, ui } = state;
      const hasSelection = state.selection.nodeIds.length > 0 || state.selection.edgeIds.length > 0;
      const nudge = (dx: number, dy: number) => {
        // A focused node moves itself (React Flow's keyboard support).
        if (inNode || !state.selection.nodeIds.length) return false;
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        commands.nudge(dx * step, dy * step);
      };

      // Tab walks the nodes in run order while focus is on the pane or a node; at either end it
      // lets go, so focus can leave the canvas. Inside a node (after Enter) Tab moves through that
      // node's controls, the browser's own way.
      const walk = (step: 1 | -1) => {
        // Nothing focused (the page or the app's main region) counts as the pane.
        const inPane =
          !target ||
          target === document.body ||
          target.id === "main" ||
          !!target.closest(".of-canvas .react-flow");
        if (!inPane || editable) return false;
        const holder = target?.closest(".react-flow__node");
        if (holder && holder !== target) return false;
        const from = target?.closest<HTMLElement>(".react-flow__node")?.dataset.id ?? null;
        const next = nextInWalk(state.doc, from, step);
        // At either end it lets go of the canvas, not into the last node's own controls.
        if (!next) return from ? focusOutsidePane(step) : false;
        actions.setSelection({ nodeIds: [next], edgeIds: [] });
        const focus = () => nodeElement(next)?.focus();
        if (!state.viewController.isNodeVisible(next)) {
          state.viewController.focusNode(next);
          // Off-screen nodes aren't rendered until the pane gets there.
          setTimeout(focus, 300);
        } else focus();
      };

      // Enter on a port picks it; Enter on a port of the other kind connects the two.
      const connectFrom = (port: HandleRef) => {
        const pending = session.ui.getState().keyboardConnect;
        if (!pending || pending.type === port.type || pending.nodeId === port.nodeId) {
          session.ui.setState({ keyboardConnect: port });
          announce(t("canvas.editor.a11y.pickTarget"));
          return;
        }
        const [source, target2] = pending.type === "source" ? [pending, port] : [port, pending];
        session.ui.setState({ keyboardConnect: null });
        commands.connect({
          source: source.nodeId,
          sourceHandle: source.handleId,
          target: target2.nodeId,
          targetHandle: target2.handleId,
        });
      };

      // Each handler returns false when there was nothing to do, so the key keeps its usual job.
      const handlers: Record<ShortcutId, () => unknown> = {
        "tool.select": () => commands.setTool("select"),
        "tool.pan": () => commands.setTool("pan"),
        "tool.note": () => commands.setTool("note"),
        "tool.shape": () => commands.setTool("shape"),
        "tool.text": () => commands.setTool("text"),
        "tool.frame": () => commands.setTool("frame"),
        find: () => actions.setUi({ findOpen: true }),
        add: () => commands.openAddMenu(),
        "run.node": () => commands.run("node"),
        "run.downstream": () => commands.run("downstream", e.altKey),
        "run.all": () => commands.run("all"),
        "zoom.fit": () => commands.fit(),
        "zoom.selection": () => commands.zoomToSelection(),
        "zoom.reset": () => commands.zoomTo(1),
        "zoom.in": () => commands.zoomIn(),
        "zoom.out": () => commands.zoomOut(),
        undo: () => commands.undo(),
        redo: () => commands.redo(),
        duplicate: () => commands.duplicateSelection(),
        selectAll: () => commands.selectAll(),
        group: () => commands.group(),
        ungroup: () => commands.ungroup(),
        delete: () => (hasSelection ? commands.deleteSelection() : false),
        save: () => void session.autosave.flush(),
        saveVersion: () => (ui.readOnly ? false : session.ui.setState({ saveVersionOpen: true })),
        help: () => session.main.getState().actions.setUi({ shortcutsOpen: true }),
        // Enter on one selected note, text, shape or frame edits its words, like a double-click.
        // Enter on a focused data node moves into its controls; Esc comes back out.
        edit: () => {
          const port = handleRef(target);
          if (port) return connectFrom(port);
          const wrapper = target?.classList.contains("react-flow__node") ? (target as HTMLElement) : null;
          const own = wrapper && state.doc.nodes[wrapper.dataset.id ?? ""];
          if (wrapper && own && !nodeRegistry.get(own.type)?.annotation) {
            const first = firstControl(wrapper);
            if (!first) return false;
            return first.focus();
          }
          const [only, ...rest] = state.selection.nodeIds;
          const node = only && !rest.length ? state.doc.nodes[only] : undefined;
          if (!node || ui.readOnly || !nodeRegistry.get(node.type)?.annotation) return false;
          actions.setUi({ renamingNodeId: node.id });
        },
        // Innermost first: menu, text field or control in a node, find, tool, node settings, then
        // the selection.
        escape: () => {
          if (session.ui.getState().keyboardConnect) return session.ui.setState({ keyboardConnect: null });
          if (ui.addMenu) return actions.closeAddMenu();
          const node = target?.closest<HTMLElement>(".react-flow__node");
          if (node && target !== node) return node.focus();
          if (editable) return (target as HTMLElement).blur();
          if (ui.findOpen) return actions.setUi({ findOpen: false });
          if (ui.tool !== "select") return commands.setTool("select");
          const main = session.main.getState();
          if (main.ui.drawer?.panel === "inspector") return main.actions.closeDrawer();
          if (hasSelection) return actions.clearSelection();
          return false;
        },
        "focus.next": () => walk(1),
        "focus.prev": () => walk(-1),
        // Handled in the capture phase below, before React Flow moves the node instead.
        "port.next": () => false,
        "port.prev": () => false,
        "nudge.left": () => nudge(-1, 0),
        "nudge.right": () => nudge(1, 0),
        "nudge.up": () => nudge(0, -1),
        "nudge.down": () => nudge(0, 1),
      };
      if (handlers[id]() !== false) e.preventDefault();
    };

    const textSelected = () => (window.getSelection()?.toString() ?? "").length > 0;

    const onCopy = (e: ClipboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (isEditable(target) || inOverlay(target) || textSelected()) return;
      const text = commands.copyText();
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData(FRAGMENT_MIME, text);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      const before = e.defaultPrevented;
      onCopy(e);
      if (!before && e.defaultPrevented) commands.deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (isEditable(target) || inOverlay(target) || !e.clipboardData) return;
      const text = e.clipboardData.getData(FRAGMENT_MIME) || e.clipboardData.getData("text/plain");
      if (commands.paste(text)) e.preventDefault();
    };

    // Keys that React Flow also reacts to when a node has focus: ⌥↑/↓ (it would move the node) and
    // the run keys (holding ⌘ or ⇧, its Enter handling would unselect the node first). These are
    // handled before it sees them.
    const onNodeKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(".of-canvas .react-flow__node") || isEditable(target)) return;
      const id = matchShortcut(e, isMac(), false);
      if (id === "port.next" || id === "port.prev") {
        if (!cyclePort(target, id === "port.next" ? 1 : -1)) return;
      } else if (id === "run.node") commands.run("node");
      else if (id === "run.downstream") commands.run("downstream", e.altKey);
      else if (id === "run.all") commands.run("all");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener("keydown", onNodeKey, true);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onNodeKey, true);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [commands, session, store]);
}
