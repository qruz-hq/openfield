import { t } from "@openfield/core";
import { cn, Tooltip } from "@openfield/ui";
import { Handle, Position } from "@xyflow/react";
import { Image, type LucideIcon, Palette, SquareDashed, Type } from "lucide-react";
import { memo } from "react";
import { PORT_SPACING, type PortSpec, type PortType, portFlow } from "../../engine/types";
import { useCanvas } from "../../store/context";
import { wouldCreateCycle } from "../../store/graph";
import type { CanvasState } from "../../store/types";

// Typed ports (§7.6, design pUPWt): 24 px circles centred on the node's edge, inputs on the left and
// outputs on the right, 36 apart around the vertical middle. While a connection is dragged, ports
// that take it brighten and the rest fade and refuse hover.

const ICONS: Partial<Record<PortType, LucideIcon>> = {
  text: Type,
  image: Image,
  mask: SquareDashed,
  preset: Palette,
};

type PortLook = "idle" | "ready" | "dimmed";

/** A selected link lights the ports at both of its ends (design vaCAK). */
function attachedToSelected(state: CanvasState, nodeId: string, port: PortSpec): boolean {
  for (const edgeId of state.selection.edgeIds) {
    const edge = state.doc.edges[edgeId];
    if (edge?.kind !== "data") continue;
    if (port.direction === "out" && edge.source === nodeId && edge.sourceHandle === port.id) return true;
    if (port.direction === "in" && edge.target === nodeId && edge.targetHandle === port.id) return true;
  }
  return false;
}

/** How a port looks while a connection is in flight. Cheap when nothing is being dragged. */
function lookFor(state: CanvasState, nodeId: string, port: PortSpec): PortLook {
  const pending = state.ui.connecting;
  if (!pending) return attachedToSelected(state, nodeId, port) ? "ready" : "idle";
  if (pending.nodeId === nodeId) return pending.handleId === port.id ? "idle" : "dimmed";
  if (pending.handleType === "source") {
    if (port.direction !== "in" || portFlow(pending.portType, port.type) === "no") return "dimmed";
    return wouldCreateCycle(state.doc, pending.nodeId, nodeId) ? "dimmed" : "ready";
  }
  if (port.direction !== "out" || portFlow(port.type, pending.portType) === "no") return "dimmed";
  return wouldCreateCycle(state.doc, nodeId, pending.nodeId) ? "dimmed" : "ready";
}

/** The port's name for its tooltip: "Reference images ×n" for inputs and outputs that carry many. */
export function portName(port: PortSpec): string {
  const name = port.label ? t(port.label) : port.id;
  return port.arity === "multi" || port.items === "list" ? t("canvas.nodes.ports.many", { name }) : name;
}

export interface PortProps {
  nodeId: string;
  port: PortSpec;
  /** Offset of the centre from the node's vertical middle. */
  offset: number;
  /** Greyed with a reason, e.g. a model that takes no reference images. The edge stays. */
  off?: string | null;
  /** Collapsed cards stack every handle on one spot and show only the first. */
  stacked?: boolean;
  connectable: boolean;
}

export const Port = memo(function Port({ nodeId, port, offset, off, stacked, connectable }: PortProps) {
  const look = useCanvas((s) => lookFor(s, nodeId, port));
  const Icon = ICONS[port.type] ?? Image;
  const name = portName(port);
  const input = port.direction === "in";
  return (
    <Tooltip content={off ?? name} side={input ? "left" : "right"}>
      <Handle
        id={port.id}
        type={input ? "target" : "source"}
        position={input ? Position.Left : Position.Right}
        isConnectable={connectable}
        tabIndex={stacked ? -1 : 0}
        aria-label={off ? `${name}. ${off}` : name}
        className={cn(
          "of-port",
          look === "ready" && "of-port-ready",
          look === "dimmed" && "of-port-dimmed",
          off && look === "idle" && "of-port-off",
          stacked && "of-port-stacked",
        )}
        style={{ top: `calc(50% + ${offset}px)` }}
      >
        <Icon size={12} aria-hidden />
      </Handle>
    </Tooltip>
  );
});

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

export interface PortRailsProps {
  nodeId: string;
  ports: readonly PortSpec[];
  connectable: boolean;
  /** Per input port id, why it's greyed. */
  off?: Readonly<Record<string, string | null>>;
  collapsed?: boolean;
}

/** Both rails of a node, visible ports only. */
export function PortRails({ nodeId, ports, connectable, off, collapsed = false }: PortRailsProps) {
  const rail = (direction: PortSpec["direction"]) =>
    railLayout(ports, direction).map(({ port, offset }, i) => (
      <Port
        key={`${port.direction}-${port.id}`}
        nodeId={nodeId}
        port={port}
        offset={collapsed ? 0 : offset}
        off={off?.[port.id] ?? null}
        stacked={collapsed && i > 0}
        connectable={connectable}
      />
    ));
  return (
    <>
      {rail("in")}
      {rail("out")}
    </>
  );
}
