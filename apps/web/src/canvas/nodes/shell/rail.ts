import { PORT_SPACING, type PortSpec } from "@openfield/canvas/engine/types";

// Where a node's ports sit on its sides: 36 apart around the vertical middle (§7.6, design pUPWt).
// Plain math, shared by the port rails and the handles React Flow gets with each node.

/** Offsets from the vertical middle for a rail of `count` ports (the rail rule of railOffsets). */
export const railOffset = (index: number, count: number): number => (index - (count - 1) / 2) * PORT_SPACING;

/**
 * One rail's visible ports with their offsets from the vertical middle. A hidden port that keeps
 * its slot leaves a gap where it will go (PortSpec.keepSlot).
 */
export function railLayout(
  ports: readonly PortSpec[],
  direction: PortSpec["direction"],
): { port: PortSpec; offset: number }[] {
  const rail = ports.filter((p) => p.direction === direction && (!p.hidden || p.keepSlot));
  return rail.flatMap((port, i) => (port.hidden ? [] : [{ port, offset: railOffset(i, rail.length) }]));
}
