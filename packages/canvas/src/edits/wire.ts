import type { CanvasWireOp } from "@openfield/core/canvas";
import type { CanvasOp } from "../store/ops";

// canvas.updated carries document ops as JSON (§7.11). A params patch removes a key by setting it to
// undefined, which JSON would silently drop, so on the wire those keys travel in `unset` instead.

export function toWireOps(ops: readonly CanvasOp[]): CanvasWireOp[] {
  return ops.map((op): CanvasWireOp => {
    if (op.op !== "setParams") return op as CanvasWireOp;
    const patch: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(op.patch)) {
      if (value === undefined) unset.push(key);
      else patch[key] = value;
    }
    return { op: "setParams", id: op.id, patch, ...(unset.length && { unset }) };
  });
}

export function fromWireOps(ops: readonly CanvasWireOp[]): CanvasOp[] {
  return ops.map((op): CanvasOp => {
    if (op.op !== "setParams") return op as CanvasOp;
    const patch: Record<string, unknown> = { ...op.patch };
    for (const key of op.unset ?? []) patch[key] = undefined;
    return { op: "setParams", id: op.id, patch };
  });
}
