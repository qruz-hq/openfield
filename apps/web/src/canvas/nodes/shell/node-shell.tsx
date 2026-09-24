import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { AnnotationHandles } from "../../editor/annotation-handles";
import { CanvasNodeResizer } from "../../editor/node-resizer";
import { useCanvasActions, useReadOnly } from "../../store/context";
import type { NodeSpec } from "../params";
import type { NodeComponentProps } from "../registry";
import { CollapsedCard } from "./collapsed-card";
import { NodeLabel } from "./node-label";
import { NodeMenu } from "./node-menu";
import { PortRails } from "./ports";
import { AssetImage } from "./thumb";
import "../nodes.css";

// NodeShell (§7.2 node chrome): what every data node shares. The label above the frame, the frame
// with its selection outline, typed port rails, resize handles, the arrow handles, the right-click
// menu, the collapsed card and the far-zoom levels of detail. Nodes draw only their body.

/** The parts of a node type the shell draws from. */
export type ShellSpec = Pick<NodeSpec<object>, "label" | "ports" | "resizable" | "minSize" | "runnable">;

export interface NodeShellProps extends NodeComponentProps {
  spec: ShellSpec;
  title: string | null;
  collapsed: boolean;
  /** Inputs changed since its images were made: the label's accent dot. */
  changed?: boolean;
  fanOut?: number;
  /** Per input port, why it's greyed (the model can't use it). */
  portOff?: Readonly<Record<string, string | null>>;
  /** Double-click opens the settings drawer. */
  inspectable?: boolean;
  /** What the collapsed card says: the model, or a line of text. */
  collapsedMeta: ReactNode;
  /** The collapsed card's state line (running, blocked, changed…), for nodes that run. */
  collapsedStatus?: ReactNode;
  /** Images for the collapsed card and the far-zoom card. */
  thumbs: readonly string[];
  /** Classes for the frame (padding; width and a minimum height for nodes sized by their content). */
  frameClassName?: string;
  /** A node sized by its content gets the design's 320 when collapsed; others keep their width. */
  contentSized?: boolean;
  children: ReactNode;
}

/** Clicks on fields and buttons are theirs, not the node's. */
const isControl = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, button, select, a, [contenteditable]");

export function NodeShell({
  id,
  selected,
  lod,
  spec,
  title,
  collapsed,
  changed = false,
  fanOut = 1,
  portOff,
  inspectable = false,
  collapsedMeta,
  collapsedStatus,
  thumbs,
  frameClassName,
  contentSized = false,
  children,
}: NodeShellProps) {
  const actions = useCanvasActions();
  const readOnly = useReadOnly();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const name = title?.trim() || t(spec.label);

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!readOnly) setMenuAt({ x: event.clientX, y: event.clientY });
  };
  // Keyboard focus sits on React Flow's wrapper around this, so its keys are heard there: the menu
  // key or ⇧F10 opens the node menu, ⌥↵ the settings drawer. Keys from the node's own controls
  // are theirs.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrapper = root.current?.closest<HTMLElement>(".react-flow__node");
    if (!wrapper || readOnly) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.target !== wrapper || event.metaKey || event.ctrlKey) return;
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        const box = wrapper.getBoundingClientRect();
        setMenuAt({ x: box.left, y: box.bottom });
      } else if (event.key === "Enter" && event.altKey && inspectable) {
        actions.openInspector(id);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    wrapper.addEventListener("keydown", onKey);
    return () => wrapper.removeEventListener("keydown", onKey);
  }, [actions, id, inspectable, readOnly]);
  const onDoubleClick = (event: MouseEvent) => {
    if (!inspectable || isControl(event.target)) return;
    event.stopPropagation();
    actions.openInspector(id);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: React Flow's node wrapper is the focusable element; this only listens.
    <div
      ref={root}
      className="relative size-full"
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      {lod === "rect" ? null : (
        <NodeLabel id={id} title={title} fallback={t(spec.label)} changed={changed} fanOut={fanOut} />
      )}
      <div
        className={cn(
          "relative flex size-full flex-col overflow-hidden rounded-14",
          lod === "rect" ? "bg-elevated-2" : "bg-elevated",
          !collapsed && frameClassName,
          collapsed && contentSized && "w-320",
        )}
      >
        {collapsed ? (
          <CollapsedCard id={id} name={name} meta={collapsedMeta} status={collapsedStatus} thumbs={thumbs} />
        ) : lod === "card" ? (
          thumbs[0] ? (
            <AssetImage assetId={thumbs[0]} height={320} className="absolute inset-0" />
          ) : null
        ) : lod === "rect" ? (
          <span className="m-auto max-w-[calc(100%-24px)] truncate text-caption font-medium text-text-secondary">
            {name}
          </span>
        ) : (
          children
        )}
      </div>
      {/* Drawn over the body, so a full-bleed image never covers it. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-14",
          selected ? "inset-ring-2 inset-ring-accent" : "inset-ring inset-ring-border",
        )}
      />
      {/* Arrow handles first: the data ports sit on top where the two share an edge. */}
      <AnnotationHandles />
      <PortRails nodeId={id} ports={spec.ports} connectable={!readOnly} off={portOff} collapsed={collapsed} />
      {spec.resizable && !collapsed ? <CanvasNodeResizer selected={selected} minSize={spec.minSize} /> : null}
      <NodeMenu
        id={id}
        name={name}
        at={menuAt}
        onClose={() => setMenuAt(null)}
        runnable={spec.runnable}
        collapsed={collapsed}
        inspectable={inspectable}
      />
    </div>
  );
}
