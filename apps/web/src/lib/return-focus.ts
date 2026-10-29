import { useLayoutEffect, useRef } from "react";

// Radix hands focus back to a dialog's trigger when it closes. A dialog opened by code has none, so
// focus would fall to the page, where the keys of the view behind it no longer reach.

const canTakeFocus = (el: HTMLElement) =>
  el.isConnected && !el.matches(":disabled") && !el.closest("[inert]");

/**
 * For a dialog with no trigger: what had focus when it opened gets it back when it closes. When
 * that's gone or can't take focus any more (a button that turned itself off), the dialog it sat in
 * takes it instead. Returns the handler for Radix's onCloseAutoFocus.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const from = useRef<{ el: HTMLElement; within: HTMLElement | null } | null>(null);
  // Layout effects run before the dialog moves focus into itself (Radix does it later).
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.activeElement;
    from.current =
      el instanceof HTMLElement && el !== document.body
        ? { el, within: el.closest<HTMLElement>("[role='dialog']") }
        : null;
  }, [open]);
  return (event) => {
    const saved = from.current;
    from.current = null;
    if (!saved) return;
    const target = canTakeFocus(saved.el) ? saved.el : saved.within?.isConnected ? saved.within : null;
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
}
