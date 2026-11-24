import { PORT_SPACING, type PortSpec } from "@openfield/canvas/engine/types";

// Where a node's ports sit on its sides: 36 apart around the vertical middle (§7.6, design pUPWt).
// Plain math, shared by the port rails and the handles React Flow gets with each node.

/** Offsets from the vertical middle for a rail of `count` ports (the rail rule of railOffsets). */
export const railOffset = (index: number, count: number): number => (index - (count - 1) / 2) * PORT_SPACING;

/**
 * One rail's visible ports with their offsets from the vertical middle. A hidden port that keeps
 * its slot leaves a gap where it will go (PortSpec.keepSlot). A port placed by its own `top` (a
 * Layers node's, one per row) sits there instead and takes no slot.
 */
export function railLayout(
  ports: readonly PortSpec[],
  direction: PortSpec["direction"],
): { port: PortSpec; offset: number }[] {
  const spread = ports.filter(
    (p) => p.direction === direction && p.top === undefined && (!p.hidden || p.keepSlot),
  );
  const placed = ports.filter((p) => p.direction === direction && p.top !== undefined && !p.hidden);
  return [
    ...spread.flatMap((port, i) => (port.hidden ? [] : [{ port, offset: railOffset(i, spread.length) }])),
    ...placed.map((port) => ({ port, offset: 0 })),
  ];
}

/** A port's centre from the top of a node `height` tall: its own `top`, else round the middle. */
export const portY = (entry: { port: PortSpec; offset: number }, height: number): number =>
  entry.port.top ?? height / 2 + entry.offset;
