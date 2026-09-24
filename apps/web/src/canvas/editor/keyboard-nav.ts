import { nodeWrapper } from "../nodes/shell/focus";
import { type DocSlice, topoOrder } from "../store";
import { insideCollapsed } from "./flow/adapter";

// Keyboard access to the graph (§2.11): Tab moves between nodes in the order they run, Enter goes
// into a node's controls and Esc back out, ⌥↑/↓ moves between the ports of the focused node, and
// Enter on one port then another connects them. Screen readers get the live region; the pane
// itself isn't a reading surface.

export const nodeElement = nodeWrapper;

/** Run order first (upstream before downstream), then anything a loop left out; hidden nodes skipped. */
export function walkOrder(doc: DocSlice): string[] {
  const { order, cyclic } = topoOrder(doc);
  return [...order, ...cyclic].filter((id) => !insideCollapsed(doc, id));
}

/** The node after (or before) `from` in walk order; null past either end, so focus can move on. */
export function nextInWalk(doc: DocSlice, from: string | null, step: 1 | -1): string | null {
  const ids = walkOrder(doc);
  const at = from ? ids.indexOf(from) : -1;
  if (at < 0) return (step === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  return ids[at + step] ?? null;
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Past the last node (or before the first), focus leaves the canvas for what comes after it (or
 * before it) on the page, rather than falling into that node's own controls. False when there's
 * nothing there, so the browser does as it would.
 */
export function focusOutsidePane(step: 1 | -1): boolean {
  const pane = document.querySelector(".of-canvas:not(.of-capture) .react-flow");
  if (!pane) return false;
  const side = step === 1 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  const candidates = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      !pane.contains(el) &&
      el.tabIndex >= 0 &&
      !el.closest("[inert]") &&
      el.getClientRects().length > 0 &&
      pane.compareDocumentPosition(el) & side,
  );
  const target = step === 1 ? candidates[0] : candidates.at(-1);
  if (!target) return false;
  target.focus();
  return true;
}

export interface HandleRef {
  nodeId: string;
  handleId: string;
  type: "source" | "target";
}

export function handleRef(el: Element | null): HandleRef | null {
  const handle = el?.closest(".react-flow__handle");
  if (!(handle instanceof HTMLElement)) return null;
  const nodeId = handle.dataset.nodeid;
  const handleId = handle.dataset.handleid;
  if (!nodeId || !handleId) return null;
  return { nodeId, handleId, type: handle.classList.contains("source") ? "source" : "target" };
}

/** Moves focus to the next connectable data port of the node holding `from`. */
export function cyclePort(from: Element, step: 1 | -1): HandleRef | null {
  const node = from.closest(".react-flow__node");
  if (!node) return null;
  const ports = [
    ...node.querySelectorAll<HTMLElement>(".react-flow__handle.connectable:not(.of-arrow-handle)"),
  ];
  if (!ports.length) return null;
  const current = from.closest(".react-flow__handle");
  const at = current instanceof HTMLElement ? ports.indexOf(current) : -1;
  const next =
    ports[at < 0 ? (step === 1 ? 0 : ports.length - 1) : (at + step + ports.length) % ports.length]!;
  next.tabIndex = -1;
  next.focus();
  return handleRef(next);
}
