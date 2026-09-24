// Canvases made from a template or a file carry a view picked for some other screen, so they open
// fitted to their nodes instead. The index marks them here; the editor takes the mark once. A
// reload keeps the view the person left, which is why this isn't saved anywhere.

const pending = new Set<string>();

export function fitOnOpen(canvasId: string): void {
  pending.add(canvasId);
}

/** True once for a marked canvas. */
export function takeFitOnOpen(canvasId: string): boolean {
  return pending.delete(canvasId);
}
