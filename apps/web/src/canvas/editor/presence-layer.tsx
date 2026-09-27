import { nodeRect } from "@openfield/canvas/edits/place";
import { specRegistry } from "@openfield/canvas/nodes/specs";
import {
  useInternalNode,
  useOnViewportChange,
  useReactFlow,
  useStore,
  useStoreApi,
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

/**
 * Moves the view to fit these nodes, at 100% at most, and marks the move as ours. Bounds come from
 * the measured node, else from the document: a node off screen isn't drawn, so isn't measured.
 */
function useMoveTo(session: EditorSession) {
  const rf = useReactFlow();
  const flow = useStoreApi();
  const ours = useRef(0);
  const moveTo = useCallback(
    (ids: readonly string[]) => {
      const doc = session.main.getState().doc;
      const rects = ids.flatMap((id) => {
        const node = rf.getInternalNode(id);
        const w = node?.measured.width;
        const h = node?.measured.height;
        if (node && w && h) return [{ ...node.internals.positionAbsolute, w, h }];
        const rect = nodeRect(doc, specRegistry, id);
        return rect ? [rect] : [];
      });
      if (!rects.length) return;
      const left = Math.min(...rects.map((r) => r.x));
      const top = Math.min(...rects.map((r) => r.y));
      const w = Math.max(...rects.map((r) => r.x + r.w)) - left;
      const h = Math.max(...rects.map((r) => r.y + r.h)) - top;
      const { width, height, minZoom } = flow.getState();
      if (!width || !height) return;
      const room = 1 + FIT_PADDING * 2;
      const zoom = Math.max(minZoom, Math.min(1, width / (w * room), height / (h * room)));
      const duration = reducedMotion() ? 0 : MOVE_MS;
      ours.current = Date.now() + duration + MOVE_SLACK_MS;
      void rf.setViewport(
        { x: width / 2 - (left + w / 2) * zoom, y: height / 2 - (top + h / 2) * zoom, zoom },
        { duration },
      );
    },
    [rf, flow, session],
  );
  return { moveTo, ours };
}

/** Follow: each thing the agent works on comes into view; the person's own pan or zoom ends it. */
function useFollow(session: EditorSession) {
  const following = useEditorUi((s) => s.following);
  const agent = useEditorUi((s) => s.agent);
  const dom = useStore((s) => s.domNode);
  const { moveTo, ours } = useMoveTo(session);

  useEffect(() => {
    if (!following || !agent?.nodeIds.length) return;
    // New nodes are drawn and measured a frame after they land.
    const timer = setTimeout(() => moveTo(agent.nodeIds), 50);
    return () => clearTimeout(timer);
  }, [following, agent, moveTo]);

  const stop = useCallback(() => {
    if (session.ui.getState().following) session.ui.setState({ following: false });
  }, [session]);

  // Scrolling, pinching or dragging the pane is the person taking the view back.
  useEffect(() => {
    if (!dom || !following) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".react-flow__pane")) stop();
    };
    // Capture: the pane's own zoom handler stops these from bubbling.
    dom.addEventListener("wheel", stop, { passive: true, capture: true });
    dom.addEventListener("pointerdown", onPointer, { capture: true });
    return () => {
      dom.removeEventListener("wheel", stop, { capture: true });
      dom.removeEventListener("pointerdown", onPointer, { capture: true });
    };
  }, [dom, following, stop]);

  // Anything else that moves it (zoom keys, the minimap, Zoom to fit) does too.
  useOnViewportChange({
    onStart: useCallback(() => {
      if (Date.now() > ours.current) stop();
    }, [ours, stop]),
  });
}

/** An agent's show: the nodes it named, in view once the pane is ready. */
function useShow(session: EditorSession) {
  const nodes = useEditorUi((s) => s.focusNodes);
  const { viewportInitialized } = useReactFlow();
  const { moveTo } = useMoveTo(session);
  useEffect(() => {
    if (!nodes || !viewportInitialized) return;
    // Cleared in the frame, not before it: clearing re-runs this effect, which would cancel it.
    const frame = requestAnimationFrame(() => {
      session.ui.setState({ focusNodes: null });
      moveTo(nodes);
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes, viewportInitialized, moveTo, session]);
}
