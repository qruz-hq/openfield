import { CANVAS_PREVIEW_THEMES, type CanvasDetail, type CanvasPreviewTheme } from "@openfield/core";
import { TooltipProvider } from "@openfield/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  getViewportForBounds,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { toBlob } from "html-to-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { queryClient } from "../../api/client";
import { putCanvasPreview } from "../../api/hooks/canvas-doc";
import { useEngineStore } from "../engine/engine-store";
import { nodeRegistry } from "../nodes/registry";
import { type CanvasStore, CanvasStoreProvider, createCanvasStore } from "../store";
import {
  type CaptureShape,
  captureShape,
  createCaptureScheduler,
  docBounds,
  openingCapture,
  outlineChanged,
} from "./capture-schedule";
import { boxesFor, createEdgeCache, createNodeCache } from "./flow/adapter";
import { edgeTypes } from "./flow/edges";
import { buildNodeTypes, ForcedLodContext } from "./flow/node-types";

// The index card picture (M4-15, §7.3). When capture-schedule says one is due, a second React Flow
// renders the whole graph off screen at full detail, and html-to-image turns it into a PNG for
// PUT /api/canvases/:id/preview, once in each theme (the tokens follow the theme switch, so the
// same render repaints), so the index shows the card in the theme it's in. Above 150 nodes it's
// skipped and the index falls back to the newest image. Never an image in the library.
//
// It renders in a React root of its own, not inside the editor, so a picture due when the editor
// closes is still taken after it's gone. The copy is inert: nothing in it can be focused or clicked.

export { docBounds, outlineChanged };

const WIDTH = 800;
const HEIGHT = 450;
/** How long images inside nodes get to load before the picture is taken anyway. */
const IMAGE_WAIT_MS = 2_500;
/** Node labels sit this far above their frames (design JXox3); the fit leaves room for them. */
const LABEL_BAND = 22;
/** Space around the graph, in pane units, so nothing touches the card's edge. */
const FIT_MARGIN = 24;
const GIVE_UP_MS = 15_000;

interface CaptureJob {
  detail: CanvasDetail;
  fingerprints: Readonly<Record<string, string>>;
  shape: CaptureShape;
}

export interface PreviewCapture {
  state: StoreApi<{ job: CaptureJob | null }>;
  /** Called after each save. Takes a picture when it's worth one. */
  request(): void;
  finish(job: CaptureJob, ok: boolean): void;
  /** The editor is open (again). */
  resume(): void;
  /** The editor closed: a picture that's due is taken now. */
  leave(): void;
}

export function createPreviewCapture(
  store: CanvasStore,
  { previewAt = null }: { previewAt?: string | null } = {},
): PreviewCapture {
  const state = createStore<{ job: CaptureJob | null }>()(() => ({ job: null }));
  let host: { root: Root; el: HTMLElement } | null = null;

  const mount = () => {
    if (host || typeof document === "undefined") return;
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.inert = true;
    el.className = "of-canvas of-capture fixed top-0 -left-[10000px] overflow-hidden bg-canvas";
    el.style.width = `${WIDTH}px`;
    el.style.height = `${HEIGHT}px`;
    document.body.append(el);
    const root = createRoot(el);
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {/* Nothing in the copy navigates; bands that could just need a router to render. */}
          <MemoryRouter>
            <CaptureHost capture={capture} canvasId={store.getState().canvasId} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    host = { root, el };
  };
  const unmount = () => {
    const was = host;
    host = null;
    if (!was) return;
    was.root.unmount();
    was.el.remove();
  };

  const scheduler = createCaptureScheduler({
    initial: openingCapture(store.getState().doc, previewAt),
    shape: () => captureShape(store.getState().doc),
    start: (shape) => {
      mount();
      const { doc, persist, fingerprints, canvasId: id, actions } = store.getState();
      const { document: graph } = actions.snapshot();
      state.setState({
        job: {
          detail: {
            id,
            name: doc.name,
            graph,
            graphVersion: persist.graphVersion,
            updatedAt: graph.updatedAt,
          },
          fingerprints,
          shape,
        },
      });
    },
    idle: unmount,
  });

  const capture: PreviewCapture = {
    state,
    request: scheduler.request,
    finish(job, ok) {
      if (state.getState().job !== job) return;
      state.setState({ job: null });
      scheduler.finished(ok);
    },
    resume: scheduler.resume,
    leave: scheduler.leave,
  };
  return capture;
}

const NODE_TYPES = buildNodeTypes(nodeRegistry);

/**
 * Repaints a subtree in one theme (editor.css). The tokens are light-dark() pairs, which the build
 * rewrites into variables that a `color-scheme` rule switches, so the switch has to be a CSS rule,
 * not an inline style.
 */
function paintIn(el: HTMLElement, theme: CanvasPreviewTheme) {
  el.dataset.paint = theme;
}

function CaptureHost({ capture, canvasId }: { capture: PreviewCapture; canvasId: string }) {
  const job = useStore(capture.state, (s) => s.job);
  if (!job) return null;
  return (
    <CaptureFlow
      key={job.detail.updatedAt}
      job={job}
      onDone={(shots) => {
        const upload = shots
          ? Promise.all(shots.map(({ theme, blob }) => putCanvasPreview(canvasId, blob, theme)))
          : Promise.reject(new Error("empty"));
        upload.then(
          () => capture.finish(job, true),
          () => capture.finish(job, false),
        );
      }}
    />
  );
}

function CaptureFlow({ job, onDone }: { job: CaptureJob; onDone: (shots: Shot[] | null) => void }) {
  const [store] = useState(() => {
    const s = createCanvasStore(job.detail, { readOnly: true });
    s.getState().actions.setFingerprints(job.fingerprints);
    return s;
  });
  return (
    <CanvasStoreProvider store={store}>
      <ForcedLodContext.Provider value="full">
        <ReactFlowProvider>
          <CaptureRender store={store} onDone={onDone} />
        </ReactFlowProvider>
      </ForcedLodContext.Provider>
    </CanvasStoreProvider>
  );
}

type Shot = { theme: CanvasPreviewTheme; blob: Blob };

function CaptureRender({ store, onDone }: { store: CanvasStore; onDone: (shots: Shot[] | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const report = useRef(onDone);
  report.current = onDone;
  const settled = useRef(false);
  const settle = useRef((shots: Shot[] | null) => {
    if (settled.current) return;
    settled.current = true;
    report.current(shots);
  }).current;
  const ready = useNodesInitialized();
  const initial = useMemo(() => {
    const { doc, selection } = store.getState();
    const definition = (type: string) => nodeRegistry.get(type);
    return {
      nodes: createNodeCache()({
        doc,
        selection,
        readOnly: true,
        tool: "select",
        measured: new Map(),
        findHit: null,
        definition,
        boxOf: boxesFor(doc, definition, useEngineStore.getState().ctx),
      }),
      edges: createEdgeCache()({
        doc,
        selection,
        readOnly: true,
        portType: (type, handle) => nodeRegistry.port(type, handle)?.type,
      }),
    };
  }, [store]);
  // React Flow measures nodes sized by their content; keep those sizes so it knows it's done.
  const [nodes, , onNodesChange] = useNodesState(initial.nodes);
  const edges = initial.edges;

  useEffect(() => {
    // A graph that never finishes laying out (a node that fails to render) gives up quietly.
    const timer = setTimeout(() => settle(null), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [settle]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const shoot = async () => {
      // Fitted to the nodes and their labels, with a margin, never past 100%.
      const bounds = rf.getNodesBounds(rf.getNodes());
      const view = getViewportForBounds(
        {
          x: bounds.x - FIT_MARGIN,
          y: bounds.y - LABEL_BAND - FIT_MARGIN,
          width: bounds.width + FIT_MARGIN * 2,
          height: bounds.height + LABEL_BAND + FIT_MARGIN * 2,
        },
        WIDTH,
        HEIGHT,
        0.02,
        1,
        0,
      );
      await rf.setViewport(view);
      // Give the node images a moment; take the picture regardless once the wait is up.
      const until = Date.now() + IMAGE_WAIT_MS;
      while (Date.now() < until) {
        const pending = [...(ref.current?.querySelectorAll("img") ?? [])].some((img) => !img.complete);
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const shots: Shot[] = [];
      for (const theme of CANVAS_PREVIEW_THEMES) {
        const pane = ref.current?.parentElement;
        if (cancelled || !ref.current || !pane) return;
        paintIn(pane, theme);
        await frame();
        await frame();
        const blob = await toBlob(ref.current, {
          width: WIDTH,
          height: HEIGHT,
          pixelRatio: 1,
          backgroundColor: getComputedStyle(pane).backgroundColor,
        }).catch(() => null);
        if (blob) shots.push({ theme, blob });
      }
      if (!cancelled) settle(shots.length ? shots : null);
    };
    void shoot();
    return () => {
      cancelled = true;
    };
  }, [ready, rf, settle]);

  return (
    <div ref={ref} style={{ width: WIDTH, height: HEIGHT }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={edgeTypes}
        minZoom={0.02}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        onlyRenderVisibleElements={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} offset={1} />
      </ReactFlow>
    </div>
  );
}
