import { useLayoutEffect, useRef } from "react";

// Keyboard focus around a node (§2.11): Enter moves from the node into its controls, Esc and the
// band's actions hand focus back to the node, so it's never dropped on the page.

const NODE = ".of-canvas:not(.of-capture) .react-flow__node";

/** The node's own focusable wrapper (React Flow's), in the live pane. */
export function nodeWrapper(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${NODE}[data-id="${CSS.escape(id)}"]`);
}

/** Leaves a field inside a node for the node itself. */
export function leaveField(field: HTMLElement): void {
  const node = field.closest<HTMLElement>(".react-flow__node");
  if (node) node.focus();
  else field.blur();
}

const WATCH_MS = 3000;
const STEP_MS = 50;

/**
 * After a band's action, the band (and the button in it) is replaced once the run starts. If focus
 * falls to the page then, it goes to the node instead. If anything else takes it first, like the
 * run preview, that wins.
 */
export function focusNodeSoon(id: string): void {
  const pressed = document.activeElement;
  const started = Date.now();
  const timer = setInterval(() => {
    const now = document.activeElement;
    const dropped = !now || now === document.body;
    if (dropped) nodeWrapper(id)?.focus({ preventScroll: true });
    if (dropped || now !== pressed || Date.now() - started > WATCH_MS) clearInterval(timer);
  }, STEP_MS);
}

/**
 * For panels opened by a key rather than a trigger (the add-node menu, the shortcuts sheet): what
 * had focus when it opened gets it back when it closes, so the keyboard keeps its place. Returns
 * the handler for Radix's onCloseAutoFocus; call it yourself for panels that aren't Radix.
 */
export function useReturnFocus(open: boolean): (event?: Event) => void {
  const from = useRef<Element | null>(null);
  // Layout effects run before the panel's own focus moves (Radix and autoFocus do it later).
  useLayoutEffect(() => {
    if (open) from.current = document.activeElement;
  }, [open]);
  return (event) => {
    const el = from.current;
    from.current = null;
    if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) return;
    event?.preventDefault();
    el.focus({ preventScroll: true });
  };
}
