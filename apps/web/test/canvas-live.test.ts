// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { toWireOps } from "@openfield/canvas/edits/wire";
import type { CanvasOp } from "@openfield/canvas/store/ops";
import type { CanvasActor, CanvasDetail, CanvasUpdated } from "@openfield/core";
import type { CanvasDocument, CanvasNode } from "@openfield/core/canvas";
import { applyEvent } from "../src/api/events";
import { createAutosave, type SaveOutcome } from "../src/canvas/editor/autosave";
import { type LiveSync, startLiveSync } from "../src/canvas/editor/live-sync";
import { createEditorUi, type EditorSession } from "../src/canvas/editor/session";
import { createCanvasStore, emptyDocument } from "../src/canvas/store";
import { pathFor } from "../src/lib/presence";

// Live canvases in the tab (§7.11): canvas.updated frames replay into the open copy, in version
// order, outside undo; a save that meets them retries on top instead of raising the conflict banner.

const CANVAS_ID = "01K6BQ8000000000000000CNVS";
const AT = "2026-09-27T10:00:00.000Z";
const agent: CanvasActor = { kind: "agent", name: "Claude Code", sessionId: "s-1" };

const note = (id: string, x = 0): CanvasNode => ({
  id,
  type: "note",
  typeVersion: 1,
  position: { x, y: 0 },
  size: { w: 240, h: 240 },
  parentId: null,
  collapsed: false,
  title: null,
  params: { text: "", tint: 0 },
  presetLocks: [],
  result: null,
});

function detail(nodes: CanvasNode[], graphVersion = 3): CanvasDetail {
  const graph: CanvasDocument = { ...emptyDocument(CANVAS_ID, "Live", AT), nodes };
  return { id: CANVAS_ID, name: "Live", graph, graphVersion, updatedAt: AT };
}

function harness(opts: { fetch?: () => Promise<CanvasDetail> } = {}) {
  const main = createCanvasStore(detail([note("a")]));
  const reloads: CanvasDetail[] = [];
  const timers: (() => void)[] = [];
  const session = {
    canvasId: CANVAS_ID,
    main,
    ui: createEditorUi(),
    reloadFrom: (next: CanvasDetail) => {
      reloads.push(next);
      main.getState().actions.loadDetail(next);
    },
  } as unknown as EditorSession;
  const sync: LiveSync = startLiveSync(session, {
    fetch: opts.fetch ?? (() => Promise.reject(new Error("offline"))),
    setTimer: (fn) => {
      timers.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  });
  const frame = (fromVersion: number, ops: CanvasOp[], actor: CanvasActor = agent): CanvasUpdated => ({
    canvasId: CANVAS_ID,
    fromVersion,
    graphVersion: fromVersion + 1,
    updatedAt: AT,
    ops: toWireOps(ops),
    touched: ops.flatMap((op) => (op.op === "addNode" ? [op.node.id] : "id" in op ? [op.id] : [])),
    actor,
    versionId: null,
  });
  const send = (f: CanvasUpdated) => applyEvent({ event: "canvas.updated", data: f });
  const runTimers = async () => {
    for (const fn of timers.splice(0)) fn();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { main, session, sync, frame, send, reloads, runTimers };
}

describe("live sync", () => {
  test("a clean tab replays an edit and holds exactly what the server holds", () => {
    const h = harness();
    h.send(h.frame(3, [{ op: "addNode", node: note("b", 400) }]));
    const { doc, persist, history } = h.main.getState();
    expect(doc.order).toEqual(["a", "b"]);
    expect(persist).toMatchObject({ graphVersion: 4, status: "saved" });
    expect(persist.revision).toBe(persist.savedRevision);
    // Not the person's own change, so not theirs to undo.
    expect(history.past).toHaveLength(0);
    // The agent's nodes are ringed and tagged.
    expect(h.session.ui.getState().agentTouch).toMatchObject({ nodeIds: ["b"], name: "Claude Code" });
    h.sync.stop();
  });

  test("unsaved changes stay, on top of the replayed edit, and still need saving", () => {
    const h = harness();
    h.main.getState().actions.apply([{ op: "moveNode", id: "a", position: { x: 50, y: 50 } }]);
    h.send(h.frame(3, [{ op: "setParams", id: "a", patch: { text: "from the agent" } }]));
    const { doc, persist } = h.main.getState();
    expect(doc.nodes.a!.position).toEqual({ x: 50, y: 50 });
    expect(doc.params.a).toMatchObject({ text: "from the agent" });
    expect(persist.graphVersion).toBe(4);
    expect(persist.revision).not.toBe(persist.savedRevision);
    h.sync.stop();
  });

  test("an op on a node this tab deleted is skipped, the rest land", () => {
    const h = harness();
    h.main.getState().actions.deleteNodes(["a"]);
    h.send(
      h.frame(3, [
        { op: "setParams", id: "a", patch: { text: "gone" } },
        { op: "addNode", node: note("c") },
      ]),
    );
    expect(h.main.getState().doc.order).toEqual(["c"]);
    h.sync.stop();
  });

  test("frames wait for the version before them, and replay in order", () => {
    const h = harness();
    // This tab's own save is on its way and will make version 4; the agent's edit leads from it.
    h.send(h.frame(4, [{ op: "addNode", node: note("late") }]));
    expect(h.main.getState().doc.order).toEqual(["a"]);
    const { actions, persist } = h.main.getState();
    actions.markSaved({ graphVersion: 4, updatedAt: AT, revision: persist.revision, viewRevision: 0 });
    expect(h.main.getState().doc.order).toEqual(["a", "late"]);
    expect(h.main.getState().persist.graphVersion).toBe(5);
    // A repeat of an old frame changes nothing.
    h.send(h.frame(3, [{ op: "addNode", node: note("dup") }]));
    expect(h.main.getState().doc.order).toEqual(["a", "late"]);
    h.sync.stop();
  });

  test("a version that never comes means another tab saved: catch up from the server", async () => {
    const server = detail([note("a"), note("other", 400)], 7);
    const h = harness({ fetch: () => Promise.resolve(server) });
    h.send(h.frame(6, [{ op: "addNode", node: note("z") }]));
    await h.runTimers();
    // Nothing unsaved here, so it simply reloads.
    expect(h.reloads).toHaveLength(1);
    expect(h.main.getState().doc.order).toEqual(["a", "other"]);

    const dirty = harness({ fetch: () => Promise.resolve(server) });
    dirty.main.getState().actions.apply([{ op: "moveNode", id: "a", position: { x: 9, y: 9 } }]);
    dirty.send(dirty.frame(6, [{ op: "addNode", node: note("z") }]));
    await dirty.runTimers();
    // Unsaved work here: the person picks, as with any other tab's save.
    expect(dirty.reloads).toHaveLength(0);
    expect(dirty.main.getState().persist.status).toBe("conflict");
    h.sync.stop();
    dirty.sync.stop();
  });

  test("an agent's activity raises the pill, and reading keeps it up without raising one", () => {
    const h = harness();
    applyEvent({
      event: "agent.activity",
      data: { canvasId: CANVAS_ID, actor: agent, nodeIds: [], kind: "reading", at: AT },
    });
    expect(h.session.ui.getState().agent).toBeNull();
    applyEvent({
      event: "agent.activity",
      data: { canvasId: CANVAS_ID, actor: agent, nodeIds: ["a"], kind: "running", at: AT },
    });
    expect(h.session.ui.getState().agent).toMatchObject({
      name: "Claude Code",
      kind: "running",
      nodeIds: ["a"],
    });
    h.sync.stop();
  });

  test("caughtUp resolves once the tab holds the version, or false after waiting", async () => {
    const h = harness();
    const waiting = h.sync.caughtUp(4, 1000);
    h.send(h.frame(3, [{ op: "addNode", node: note("b") }]));
    expect(await waiting).toBe(true);
    expect(await h.sync.caughtUp(9, 5)).toBe(false);
    h.sync.stop();
  });
});

describe("autosave meets a live edit", () => {
  test("a 409 for edits this tab replays goes again on top, with no banner", async () => {
    const h = harness();
    const saves: { graphVersion: number }[] = [];
    const outcomes: SaveOutcome[] = [{ kind: "conflict", server: detail([note("a"), note("b")], 4) }];
    const autosave = createAutosave(h.main, {
      setTimer: () => 0,
      clearTimer: () => {},
      save: async (body) => {
        saves.push(body);
        // The agent's edit lands while the save is on its way.
        if (saves.length === 1) h.send(h.frame(3, [{ op: "addNode", node: note("b", 400) }]));
        return outcomes.shift() ?? { kind: "saved", graphVersion: 5, updatedAt: AT };
      },
      caughtUp: (v) => h.sync.caughtUp(v, 100),
    });
    h.main.getState().actions.apply([{ op: "moveNode", id: "a", position: { x: 10, y: 0 } }]);
    await autosave.flush();
    expect(h.main.getState().persist.status).toBe("dirty");
    await autosave.flush();
    expect(saves.map((s) => s.graphVersion)).toEqual([3, 4]);
    const { persist, doc } = h.main.getState();
    expect(persist).toMatchObject({ status: "saved", graphVersion: 5 });
    expect(doc.order).toEqual(["a", "b"]);
    expect(doc.nodes.a!.position.x).toBe(10);
    autosave.dispose();
    h.sync.stop();
  });

  test("a 409 from another tab's save still shows the banner", async () => {
    const h = harness();
    const autosave = createAutosave(h.main, {
      setTimer: () => 0,
      clearTimer: () => {},
      save: async () => ({ kind: "conflict", server: detail([note("a")], 8) }),
      caughtUp: (v) => h.sync.caughtUp(v, 5),
    });
    h.main.getState().actions.apply([{ op: "moveNode", id: "a", position: { x: 10, y: 0 } }]);
    await autosave.flush();
    expect(h.main.getState().persist.status).toBe("conflict");
    autosave.dispose();
    h.sync.stop();
  });
});

describe("navigate targets", () => {
  test("open the canvas, its nodes, an image or a path", () => {
    expect(pathFor({ kind: "canvas", id: CANVAS_ID })).toBe(`/canvas/${CANVAS_ID}`);
    expect(pathFor({ kind: "canvas", id: CANVAS_ID, nodeIds: ["n_a", "n_b"] })).toBe(
      `/canvas/${CANVAS_ID}?focus=n_a%2Cn_b`,
    );
    expect(pathFor({ kind: "asset", id: CANVAS_ID })).toBe(`/assets?asset=${CANVAS_ID}`);
    expect(pathFor({ kind: "path", path: "/settings/spending" })).toBe("/settings/spending");
  });
});
