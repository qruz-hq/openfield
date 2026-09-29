import type { PortSpec } from "@openfield/canvas/engine/types";
import { GENERATE_PORTS } from "@openfield/canvas/nodes/generate/spec";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "../../../editor/flow/motion-state";
import { firstLanding } from "../../../editor/flow/pulse";
import { useCanvas, useNodeRuntime } from "../../../store/context";
import { railLayout } from "../../shell/ports";
import { attachVoxels, CELL, type VoxelHandle, type VoxelParams } from "./renderer";

// The voxel swarm over a node while it generates or waits (design wKzQJ, motion spec oQ27O): 4 px
// cells over the whole card, clouds of particles that churn in place, and a puff of new cloud at each
// connected input port every time its link's pulse lands. Waiting idles the swarm. Each run gets its
// own sky from its id. Under reduced motion it holds one still frame. The Generate card passes its
// box; Variations lets it fill each of its image areas.

interface VoxelFieldProps {
  nodeId: string;
  mode: "active" | "idle";
  /** Over the last image (a re-run): a dark cell under each lit one. */
  backing: boolean;
  /** The field's box in canvas units. Without one it fills its parent, measured. */
  width?: number;
  height?: number;
  /**
   * Where puffs come in: the node's ports, and the middle of their rail in canvas units from the
   * field's top. Generate's own ports on the card's middle by default; null for none.
   */
  rail?: { ports: readonly PortSpec[]; middle: number } | null;
}

export function VoxelField({ nodeId, mode, backing, width, height: fixedHeight, rail }: VoxelFieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<VoxelHandle | null>(null);
  const measured = useParentBox(ref, width === undefined || fixedHeight === undefined);
  const w = width ?? measured.w;
  const height = fixedHeight ?? measured.h;
  const still = useReducedMotion();
  const runId = useNodeRuntime(nodeId)?.runId ?? null;
  const ports = useConnectedPorts(
    nodeId,
    height,
    rail === undefined ? GENERATE_PORTS : (rail?.ports ?? null),
    rail?.middle ?? height / 2,
  );
  const seed = useMemo(() => seedOf(`${runId ?? ""}:${nodeId}`), [runId, nodeId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new run waits for its own first pulse.
  const firstMs = useMemo(() => (mode === "active" ? firstLanding(performance.now()) : null), [mode, runId]);

  // Whole cells over the card, centred on it; the part rows at the top and bottom are clipped.
  const cols = Math.max(1, Math.ceil(w / CELL));
  const rows = Math.max(1, Math.ceil(height / CELL));
  const params: VoxelParams = { mode, seed, ports, backing, firstMs, still };

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cell = Math.max(1, Math.round(CELL * dpr));
    canvas.width = cols * cell;
    canvas.height = rows * cell;
  }, [cols, rows]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (handle.current) handle.current.update(params, cols, rows);
    else handle.current = attachVoxels(canvas, params, cols, rows);
  });

  useEffect(
    () => () => {
      handle.current?.remove();
      handle.current = null;
    },
    [],
  );

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="of-card-voxels"
      style={{
        width: cols * CELL,
        height: rows * CELL,
        left: (w - cols * CELL) / 2,
        top: (height - rows * CELL) / 2,
      }}
    />
  );
}

/** The parent's box in canvas units (offsetWidth ignores the canvas's zoom), kept up to date. */
function useParentBox(ref: RefObject<HTMLCanvasElement | null>, on: boolean): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!on || !parent) return;
    const read = () =>
      setBox((prev) =>
        prev.w === parent.offsetWidth && prev.h === parent.offsetHeight
          ? prev
          : { w: parent.offsetWidth, h: parent.offsetHeight },
      );
    read();
    const observer = new ResizeObserver(read);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref, on]);
  return box;
}

/** The shares of the field's height where connected input ports sit, top first. */
function useConnectedPorts(
  nodeId: string,
  height: number,
  ports: readonly PortSpec[] | null,
  middle: number,
): number[] {
  const handles = useCanvas((s) => {
    const into: string[] = [];
    for (const edge of Object.values(s.doc.edges)) {
      if (edge.kind === "data" && edge.target === nodeId && edge.targetHandle) into.push(edge.targetHandle);
    }
    return into.sort().join(",");
  });
  return useMemo(() => {
    if (!ports || height <= 0) return [];
    const connected = new Set(handles.split(","));
    // A port beside the field but outside it (under Variations' images) puffs nothing.
    return railLayout(ports, "in")
      .filter(({ port }) => connected.has(port.id))
      .map(({ offset }) => (middle + offset) / height)
      .filter((share) => share >= 0 && share <= 1);
  }, [handles, height, ports, middle]);
}

/** A run's own sky: its id hashed to a whole number, 0 to 999 (FNV-1a). */
export function seedOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 1000;
}
