import { t } from "@openfield/core";
import { IconButton, Surface } from "@openfield/ui";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCanvasActions, useNodeFrame } from "../store/context";
import { nodeRegistry } from "./registry";

// Canvas / Inspector (design AWQzm): a Surface / Panel / Side, 354 wide, with the node's icon and
// name, Close, and the type's own settings. The editor's drawer host places it; nodes without
// settings of their own never open it.

export function NodeInspector({ nodeId }: { nodeId: string }) {
  const frame = useNodeFrame(nodeId);
  const actions = useCanvasActions();
  const def = frame ? nodeRegistry.get(frame.type) : undefined;
  const panel = useRef<HTMLDivElement>(null);
  const shown = !!frame && !!def?.Inspector;
  // Focus comes into the drawer when it opens on a node, so the keyboard can reach its settings.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new node gets the focus again.
  useEffect(() => {
    if (shown) panel.current?.focus({ preventScroll: true });
  }, [shown, nodeId]);
  if (!frame || !def?.Inspector) return null;
  const Body = def.Inspector;
  const Icon = def.icon;
  const title = frame.title?.trim() || t(def.label);

  return (
    <Surface
      ref={panel}
      tabIndex={-1}
      variant="panel"
      role="complementary"
      aria-label={title}
      className="max-h-full w-354 overflow-y-auto outline-none"
      onKeyDown={(event) => {
        // Typing in the drawer never reaches the canvas shortcuts; Esc closes it.
        event.stopPropagation();
        if (event.key === "Escape") actions.closeDrawer();
      }}
    >
      <div className="flex w-full items-center gap-8 pt-2 pr-2 pl-6">
        <Icon size={16} aria-hidden className="shrink-0 text-text-secondary" />
        <h2 className="min-w-0 flex-1 truncate text-body-strong text-text-primary">{title}</h2>
        <IconButton
          icon={X}
          label={t("canvas.nodes.inspector.close")}
          onClick={() => actions.closeDrawer()}
        />
      </div>
      <Body nodeId={nodeId} />
    </Surface>
  );
}
