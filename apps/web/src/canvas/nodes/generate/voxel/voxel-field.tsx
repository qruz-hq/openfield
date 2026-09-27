import { GENERATE_PORTS } from "@openfield/canvas/nodes/generate/spec";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useReducedMotion } from "../../../editor/flow/edges";
import { clockAt, PULSE } from "../../../editor/flow/pulse";
import { useCanvas, useNodeRuntime } from "../../../store/context";
import { railLayout } from "../../shell/ports";
import { attachVoxels, CELL, type VoxelHandle, type VoxelParams } from "./renderer";

// The Generate card's voxel swarm while it generates or waits (design wKzQJ, motion spec oQ27O):
// 4 px cells over the whole card, clouds of particles that churn in place, and a puff of new cloud
// at each connected input port every time its link's pulse lands. Waiting idles the swarm. Each run
// gets its own sky from its id. Under reduced motion it holds one still frame.

interface VoxelFieldProps {
  nodeId: string;
  mode: "active" | "idle";
  /** Over the last image (a re-run): a dark cell under each lit one. */
  backing: boolean;
  width: number;
  height: number;
}

export function VoxelField({ nodeId, mode, backing, width, height }: VoxelFieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<VoxelHandle | null>(null);
  const still = useReducedMotion();
  const runId = useNodeRuntime(nodeId)?.runId ?? null;
  const ports = useConnectedPorts(nodeId, height);
  const seed = useMemo(() => seedOf(`${runId ?? ""}:${nodeId}`), [runId, nodeId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new run waits for its own first pulse.
  const firstMs = useMemo(() => (mode === "active" ? firstLanding(performance.now()) : null), [mode, runId]);

  // Whole cells over the card, centred on it; the part rows at the top and bottom are clipped.
  const cols = Math.max(1, Math.ceil(width / CELL));
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
        left: (width - cols * CELL) / 2,
        top: (height - rows * CELL) / 2,
      }}
    />
  );
}

/** The shares of the card's height where connected input ports sit, top first. */
function useConnectedPorts(nodeId: string, height: number): number[] {
  const handles = useCanvas((s) => {
    const into: string[] = [];
    for (const edge of Object.values(s.doc.edges)) {
      if (edge.kind === "data" && edge.target === nodeId && edge.targetHandle) into.push(edge.targetHandle);
    }
    return into.sort().join(",");
  });
  return useMemo(() => {
    const connected = new Set(handles.split(","));
    return railLayout(GENERATE_PORTS, "in")
      .filter(({ port }) => connected.has(port.id))
      .map(({ offset }) => (height / 2 + offset) / height);
  }, [handles, height]);
}

/**
 * A link that lights up starts pulsing on the next cycle of the shared clock (pulse-clock.ts), so
 * the first puff waits for that pulse to land.
 */
function firstLanding(now: number): number {
  const { cycle, phase } = clockAt(now);
  const from = phase < 50 ? cycle : cycle + 1;
  return from * PULSE.cycleMs + PULSE.travelMs;
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
