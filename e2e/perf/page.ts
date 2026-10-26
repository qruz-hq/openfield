// What the canvas benchmark runs inside the page. Playwright sends these functions as source, so
// each one stands alone: no imports, nothing from module scope.

export interface FrameStats {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames missed against 60 fps. */
  dropped: number;
  over50ms: number;
  /** Null where the browser doesn't report long tasks (WebKit). */
  longTasks: number | null;
  longTaskMs: number | null;
  longestTask: number | null;
  /** React commits while it ran. */
  commits: number;
}

export interface Counts {
  dom: number;
  nodes: number;
  edges: number;
  images: number;
  zoom: number;
}

export interface OpenStats {
  /** From navigation start, in ms. */
  firstNode: number | null;
  firstNodeCount: number;
  allImages: number | null;
  imageCount: number;
  longTasks: number | null;
  longTaskMs: number | null;
  longestTask: number | null;
  /** The longest gap between two frames in the first 10 s: the long-task stand-in for WebKit. */
  longestFrame: number;
}

interface BenchState {
  commits: number;
  tally: Record<string, number> | null;
  longTasks: { start: number; dur: number }[] | null;
  longestFrame: number;
  marks: { firstNode?: number; firstNodeCount?: number; allImages?: number; imageCount?: number };
}

interface Fiber {
  type: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: { value?: unknown } | null;
}

interface Store<S> {
  getState(): S;
}

interface FlowState {
  transform: [number, number, number];
  panZoom: { setViewport(v: { x: number; y: number; zoom: number }): Promise<boolean> } | null;
  nodeLookup: Map<
    string,
    {
      id: string;
      type?: string;
      internals: { positionAbsolute: { x: number; y: number } };
      measured: { width?: number; height?: number };
      width?: number;
      height?: number;
    }
  >;
}

interface CanvasState {
  selection: { nodeIds: string[] };
  actions: { setSelection(s: { nodeIds?: string[]; edgeIds?: string[] }): void };
}

export interface Box {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Helpers {
  setView(cx: number, cy: number, zoom: number): Promise<void>;
  densest(zoom: number): { cx: number; cy: number; inView: number };
  fitAll(): Promise<number>;
  select(ids: string[]): void;
  selectedCount(): number;
  zoomNow(): number;
  start(): void;
  stop(): Promise<FrameStats>;
  counts(): Counts;
  panLoop(frames: number): Promise<void>;
  zoomLoop(frames: number, around: number): Promise<void>;
  sweep(frames: number): Promise<void>;
  tally(on: boolean): Record<string, number> | null;
  /** Nodes to grab for a drag: the ones nearest the middle of the screen. */
  dragPick(n: number): { ids: string[]; x: number; y: number };
}

declare global {
  interface Window {
    __bench: BenchState;
    __benchHelpers: Helpers;
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
  }
}

/**
 * Before the app loads: counts React commits through the devtools hook (and, when asked, which
 * components rendered), logs long tasks, and notes when the first node and all its images show.
 */
export function pageInit(): void {
  const state: BenchState = { commits: 0, tally: null, longTasks: null, longestFrame: 0, marks: {} };
  window.__bench = state;
  const nameOf = (type: unknown): string | null => {
    if (typeof type === "function")
      return (type as { displayName?: string }).displayName || type.name || null;
    if (type && typeof type === "object") {
      const t = type as {
        displayName?: string;
        render?: { displayName?: string; name?: string };
        type?: unknown;
      };
      return t.displayName || t.render?.displayName || t.render?.name || (t.type ? nameOf(t.type) : null);
    }
    return null;
  };
  let previous = new WeakSet<Fiber>();
  const tallyTree = (root: Fiber, tally: Record<string, number>) => {
    const seen = new WeakSet<Fiber>();
    const stack = [root];
    while (stack.length) {
      const fiber = stack.pop()!;
      seen.add(fiber);
      // PerformedWork: it rendered in this commit.
      if (!previous.has(fiber) && fiber.flags & 1) {
        const name = nameOf(fiber.type);
        if (name) tally[name] = (tally[name] ?? 0) + 1;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    previous = seen;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(this: { renderers: Map<number, unknown> }, renderer: unknown) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    setStrictMode() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      state.commits++;
      if (state.tally) tallyTree(root.current, state.tally);
    },
  };
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    const tasks: { start: number; dur: number }[] = [];
    state.longTasks = tasks;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        tasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ type: "longtask", buffered: true });
  }
  let last = 0;
  const watch = (now: number) => {
    if (last) state.longestFrame = Math.max(state.longestFrame, now - last);
    last = now;
    const marks = state.marks;
    const nodes = document.querySelectorAll(".react-flow__node").length;
    if (nodes && !marks.firstNode) {
      marks.firstNode = Math.round(now);
      marks.firstNodeCount = nodes;
    }
    if (nodes && !marks.allImages) {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>(".react-flow__node img"));
      if (images.length && images.every((i) => i.complete && i.naturalWidth)) {
        marks.allImages = Math.round(now);
        marks.imageCount = images.length;
      }
    }
    if (now < 10_000) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

/**
 * After the canvas shows: reaches React Flow's store and the canvas store through the React tree
 * (the same in every build, so main and a branch measure alike), and adds the gestures.
 */
export function installHelpers(): boolean {
  const raf = () => new Promise<number>((done) => requestAnimationFrame(done));
  const root = document.querySelector(".react-flow");
  if (!root) return false;
  const key = Object.keys(root).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return false;
  function findStore<S>(match: (state: unknown) => boolean): Store<S> | null {
    for (let fiber = (root as unknown as Record<string, Fiber>)[key!] ?? null; fiber; fiber = fiber.return) {
      const value = fiber.memoizedProps?.value as Record<string, unknown> | undefined;
      for (const candidate of [value, value?.store, value?.canvas]) {
        const store = candidate as Store<unknown> | undefined;
        if (store && typeof store.getState === "function") {
          try {
            if (match(store.getState())) return store as Store<S>;
          } catch {}
        }
      }
    }
    return null;
  }
  const flow = findStore<FlowState>(
    (s) => !!s && typeof s === "object" && "panZoom" in s && "nodeLookup" in s,
  );
  const canvas = findStore<CanvasState>((s) => {
    const actions = (s as { actions?: { setSelection?: unknown } } | null)?.actions;
    return typeof actions?.setSelection === "function" && "doc" in (s as object);
  });
  if (!flow || !canvas) return false;

  const pane = () => document.querySelector<HTMLElement>(".react-flow__pane")!;
  const size = () => pane().getBoundingClientRect();
  const zoomNow = () => flow.getState().transform[2];
  const wheel = (dx: number, dy: number, ctrl: boolean) =>
    pane().dispatchEvent(
      new WheelEvent("wheel", {
        deltaX: dx,
        deltaY: dy,
        ctrlKey: ctrl,
        clientX: 720,
        clientY: 470,
        bubbles: true,
        cancelable: true,
        deltaMode: 0,
      }),
    );
  const boxes = (): Box[] =>
    [...flow.getState().nodeLookup.values()].map((n) => ({
      id: n.id,
      type: n.type ?? "",
      x: n.internals.positionAbsolute.x,
      y: n.internals.positionAbsolute.y,
      w: n.measured.width ?? n.width ?? 0,
      h: n.measured.height ?? n.height ?? 0,
    }));
  const setView = async (cx: number, cy: number, zoom: number) => {
    const { width, height } = size();
    await flow.getState().panZoom?.setViewport({ x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom });
    for (let i = 0; i < 3; i++) await raf();
  };

  let sampler: {
    deltas: number[];
    tasks: number[];
    stop: boolean;
    commits: number;
    t0: number;
    obs?: PerformanceObserver;
  } | null = null;
  const helpers: Helpers = {
    setView,
    zoomNow,
    // The spot with the most cards in one screen at this zoom: the worst case for the view.
    densest(zoom) {
      const all = boxes().filter((b) => b.type !== "frame");
      const { width, height } = size();
      const w = width / zoom;
      const h = height / zoom;
      let best = { cx: 0, cy: 0, inView: -1 };
      for (const c of all) {
        const cx = c.x + c.w / 2;
        const cy = c.y + c.h / 2;
        let n = 0;
        for (const o of all)
          if (o.x < cx + w / 2 && o.x + o.w > cx - w / 2 && o.y < cy + h / 2 && o.y + o.h > cy - h / 2) n++;
        if (n > best.inView) best = { cx, cy, inView: n };
      }
      return best;
    },
    async fitAll() {
      const all = boxes();
      const x0 = Math.min(...all.map((b) => b.x));
      const y0 = Math.min(...all.map((b) => b.y));
      const x1 = Math.max(...all.map((b) => b.x + b.w));
      const y1 = Math.max(...all.map((b) => b.y + b.h));
      const { width, height } = size();
      const zoom = Math.max(0.1, Math.min(width / (x1 - x0), height / (y1 - y0)) * 0.85);
      await setView((x0 + x1) / 2, (y0 + y1) / 2, zoom);
      return zoom;
    },
    select(ids) {
      canvas.getState().actions.setSelection({ nodeIds: ids, edgeIds: [] });
    },
    selectedCount: () => canvas.getState().selection.nodeIds.length,
    start() {
      const s = {
        deltas: [] as number[],
        tasks: [] as number[],
        stop: false,
        commits: window.__bench.commits,
        t0: performance.now(),
      } as NonNullable<typeof sampler>;
      if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        s.obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) s.tasks.push(e.duration);
        });
        s.obs.observe({ type: "longtask" });
      }
      void (async () => {
        let last = await raf();
        while (!s.stop) {
          const now = await raf();
          s.deltas.push(now - last);
          last = now;
        }
      })();
      sampler = s;
    },
    async stop() {
      const s = sampler!;
      s.stop = true;
      const total = performance.now() - s.t0;
      // Long tasks are reported a little after they end.
      await new Promise((done) => setTimeout(done, 60));
      s.obs?.disconnect();
      const sorted = [...s.deltas].sort((a, b) => a - b);
      const q = (p: number) =>
        +(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0).toFixed(1);
      return {
        frames: s.deltas.length,
        fps: +((s.deltas.length * 1000) / total).toFixed(1),
        p50: q(0.5),
        p95: q(0.95),
        p99: q(0.99),
        max: +(sorted.at(-1) ?? 0).toFixed(1),
        dropped: s.deltas.reduce((n, d) => n + Math.max(0, Math.round(d / 16.67) - 1), 0),
        over50ms: s.deltas.filter((d) => d > 50).length,
        longTasks: s.obs ? s.tasks.length : null,
        longTaskMs: s.obs ? Math.round(s.tasks.reduce((a, b) => a + b, 0)) : null,
        longestTask: s.obs ? Math.round(Math.max(0, ...s.tasks)) : null,
        commits: window.__bench.commits - s.commits,
      };
    },
    counts: () => ({
      dom: document.querySelectorAll("*").length,
      nodes: document.querySelectorAll(".react-flow__node").length,
      edges: document.querySelectorAll(".react-flow__edge").length,
      images: document.querySelectorAll(".react-flow__node img").length,
      zoom: +zoomNow().toFixed(3),
    }),
    // One input per frame, like a trackpad: pan in circles, zoom in and out around a level.
    async panLoop(frames) {
      for (let i = 0; i < frames; i++) {
        const a = (i / frames) * Math.PI * 4;
        wheel(Math.cos(a) * 48, Math.sin(a) * 48, false);
        await raf();
      }
    },
    async zoomLoop(frames, around) {
      for (let i = 0; i < frames; i++) {
        const target = around * Math.exp(0.35 * Math.sin((i / frames) * Math.PI * 4));
        wheel(0, Math.max(-60, Math.min(60, Math.log(zoomNow() / target) * 100)), true);
        await raf();
      }
    },
    async sweep(frames) {
      for (let i = 0; i < frames; i++) {
        const t = i < frames / 2 ? i / (frames / 2) : 2 - i / (frames / 2);
        const target = Math.exp(Math.log(0.1) * t);
        wheel(0, Math.max(-80, Math.min(80, Math.log(zoomNow() / target) * 100)), true);
        await raf();
      }
    },
    tally(on) {
      const out = window.__bench.tally;
      window.__bench.tally = on ? {} : null;
      return out;
    },
    dragPick(n) {
      const picked = Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node"))
        .filter((el) => !el.classList.contains("react-flow__node-frame"))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.id!, x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 4) };
        })
        .filter((p) => p.x > 60 && p.x < 1380 && p.y > 90 && p.y < 820)
        .sort((a, b) => Math.hypot(a.x - 720, a.y - 450) - Math.hypot(b.x - 720, b.y - 450))
        .slice(0, n);
      return { ids: picked.map((p) => p.id), x: picked[0]?.x ?? 720, y: picked[0]?.y ?? 450 };
    },
  };
  window.__benchHelpers = helpers;
  return true;
}

export function readOpen(): OpenStats {
  const { marks, longTasks, longestFrame } = window.__bench;
  return {
    firstNode: marks.firstNode ?? null,
    firstNodeCount: marks.firstNodeCount ?? 0,
    allImages: marks.allImages ?? null,
    imageCount: marks.imageCount ?? 0,
    longTasks: longTasks ? longTasks.length : null,
    longTaskMs: longTasks ? longTasks.reduce((a, t) => a + t.dur, 0) : null,
    longestTask: longTasks ? Math.max(0, ...longTasks.map((t) => t.dur)) : null,
    longestFrame: Math.round(longestFrame),
  };
}
