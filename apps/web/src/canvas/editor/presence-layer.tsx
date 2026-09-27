import {
  useInternalNode,
  useNodesInitialized,
  useOnViewportChange,
  useReactFlow,
  ViewportPortal,
} from "@xyflow/react";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./agents.css";
import { FIT_PADDING } from "./flow/view-controller";
import { type EditorSession, useEditorUi, useSessionOptional } from "./session";

// Agents on the canvas (§7.11), drawn in the pane (design "Canvas · Agent editing"): a ring and a
// name tag on the nodes an agent just added or changed, and Follow, which keeps what it works on in
// view until the person moves the view themselves. Also brings an agent's show into view. This was
// the multiplayer seam; an agent is the first other party to use it.

/** How long a touched node keeps its ring and tag. */
export const TOUCH_MS = 3_000;
const MOVE_MS = 240;
/** A view move of ours finishes within this; a move starting after it is the person's. */
const MOVE_SLACK_MS = 150;
/** Each node type's corner, so the ring follows its shape. Data nodes are 14. */
const RADIUS: Readonly<Record<string, number>> = { note: 8, shape: 8, frame: 16, text: 4 };
const DATA_RADIUS = 14;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function PresenceLayer() {
  const session = useSessionOptional();
  return session ? <Presence session={session} /> : null;
}

function Presence({ session }: { session: EditorSession }) {
  const previewing = useEditorUi((s) => s.preview !== null);
  const touch = useEditorUi((s) => s.agentTouch);
  const [, rerender] = useState(0);
  useFollow(session);
  useShow(session);

  // Gone once its time is up.
  useEffect(() => {
    if (!touch) return;
    const left = touch.at + TOUCH_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [touch]);

  if (previewing || !touch || Date.now() - touch.at >= TOUCH_MS) return null;
  return (
    <ViewportPortal>
      {touch.nodeIds.map((id) => (
        <Touched key={`${id}:${touch.at}`} id={id} name={touch.name} />
      ))}
    </ViewportPortal>
  );
}

/** Design sgH49 (Canvas / Node / Agent tag) above the node's right edge, and a 4 px $accent-line ring. */
function Touched({ id, name }: { id: string; name: string }) {
  const node = useInternalNode(id);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  const radius = RADIUS[node.type ?? ""] ?? DATA_RADIUS;
  return (
    <div
      aria-hidden
      data-agent-touch={id}
      className="of-agent-touch pointer-events-none absolute top-0 left-0"
      style={{ transform: `translate(${x}px, ${y}px)`, width, height }}
    >
      <div
        className="absolute inset-0"
        style={{ borderRadius: radius, boxShadow: "0 0 0 4px var(--color-accent-line)" }}
      />
      <div className="absolute right-0 bottom-[calc(100%+8px)] flex h-22 items-center gap-5 rounded-6 bg-accent pr-8 pl-6">
        <Bot size={12} aria-hidden className="shrink-0 text-accent-fg" />
        <span className="text-caption font-semibold whitespace-nowrap text-accent-fg">{name}</span>
      </div>
    </div>
  );
}

/** Moves the view to fit these nodes, marking the move as ours. */
function useFitNodes() {
  const rf = useReactFlow();
  const ours = useRef(0);
  const fit = useCallback(
    (ids: readonly string[]) => {
      const present = ids.filter((id) => rf.getInternalNode(id));
      if (!present.length) return;
      const duration = reducedMotion() ? 0 : MOVE_MS;
      ours.current = Date.now() + duration + MOVE_SLACK_MS;
      void rf.fitView({ nodes: present.map((id) => ({ id })), padding: FIT_PADDING, duration, maxZoom: 1 });
    },
    [rf],
  );
  return { fit, ours };
}

/** Follow: each thing the agent works on comes into view; the person's own pan or zoom ends it. */
function useFollow(session: EditorSession) {
  const following = useEditorUi((s) => s.following);
  const agent = useEditorUi((s) => s.agent);
  const { fit, ours } = useFitNodes();

  useEffect(() => {
    if (!following || !agent?.nodeIds.length) return;
    // New nodes are drawn and measured a frame after they land.
    const timer = setTimeout(() => fit(agent.nodeIds), 50);
    return () => clearTimeout(timer);
  }, [following, agent, fit]);

  useOnViewportChange({
    onStart: useCallback(() => {
      if (session.ui.getState().following && Date.now() > ours.current)
        session.ui.setState({ following: false });
    }, [session, ours]),
  });
}

/** An agent's show: the nodes it named, in view once the pane has measured them. */
function useShow(session: EditorSession) {
  const nodes = useEditorUi((s) => s.focusNodes);
  const ready = useNodesInitialized();
  const { fit } = useFitNodes();
  useEffect(() => {
    if (!nodes || !ready) return;
    session.ui.setState({ focusNodes: null });
    const frame = requestAnimationFrame(() => fit(nodes));
    return () => cancelAnimationFrame(frame);
  }, [nodes, ready, fit, session]);
}
