import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentActor,
  type CanvasEditsResponse,
  type CanvasRunScopeResponse,
  type CanvasVersion,
  canvasDetailSchema,
  canvasEditsResponseSchema,
  type SseEventType,
  type SsePayload,
  sseEventSchema,
  TAB_HEADER,
} from "@openfield/core";
import type { CanvasEdit } from "@openfield/core/canvas";
import { finished, MODEL, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";

// Live canvases (§7.11): edits compiled on the server reach every open tab as the ops to replay, an
// agent's first change to a canvas saves a version first, a run can be asked for by scope with no
// tab open, and tabs say where they are.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const agent = (sessionId = "s-1", name = "Claude Code"): AgentActor => ({ kind: "agent", name, sessionId });

const chain: CanvasEdit[] = [
  { op: "add_node", as: "p", type: "prompt", params: { text: "A lighthouse at dusk" } },
  { op: "add_node", as: "g", type: "image.generate", params: { model: MODEL, batch: 2 } },
  { op: "connect", source: "p", target: "g" },
];

const eventsOf = <E extends SseEventType>(s: TestServer, name: E): SsePayload<E>[] =>
  s.events.filter((e) => e.event === name).map((e) => sseEventSchema.parse(e).data as SsePayload<E>);

async function detail(s: TestServer, id: string) {
  return canvasDetailSchema.parse((await s.json(`/api/canvases/${id}`)).body);
}

describe("POST /api/canvases/:id/edits", () => {
  test("saves the edits and sends their ops to every tab", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server, { name: "Live" });
    const res = await server.json<CanvasEditsResponse>(`/api/canvases/${canvas.id}/edits`, {
      method: "POST",
      headers: { [TAB_HEADER]: "tab-aaaaaaaa" },
      body: { edits: chain, graphVersion: canvas.graphVersion },
    });
    expect(res.status).toBe(200);
    const body = canvasEditsResponseSchema.parse(res.body);
    expect(body.graphVersion).toBe(canvas.graphVersion + 1);
    expect(Object.keys(body.aliases)).toEqual(["p", "g"]);
    expect(body.ops.map((o) => o.op)).toEqual(["addNode", "addNode", "addEdge"]);
    expect(body.versionId).toBeNull();

    const saved = await detail(server, canvas.id);
    expect(saved.graphVersion).toBe(body.graphVersion);
    expect(saved.graph.nodes.map((n) => n.type)).toEqual(["prompt", "image.generate"]);
    expect(saved.graph.edges).toHaveLength(1);

    const [frame] = eventsOf(server, "canvas.updated");
    expect(frame).toMatchObject({
      canvasId: canvas.id,
      fromVersion: canvas.graphVersion,
      graphVersion: body.graphVersion,
      actor: { kind: "tab", tabId: "tab-aaaaaaaa" },
      touched: [body.aliases.p, body.aliases.g],
    });
    // A tab's own edit isn't an agent at work.
    expect(eventsOf(server, "agent.activity")).toEqual([]);
  });

  test("a canvas that changed since is a 409, and an edit that doesn't fit is a 400 that says why", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const stale = await server.json(`/api/canvases/${canvas.id}/edits`, {
      method: "POST",
      body: { edits: [{ op: "rename_canvas", name: "Other" }], graphVersion: canvas.graphVersion + 3 },
    });
    expect(stale.status).toBe(409);

    const bad = await server.json<{ error: { field: string; userMessage: string } }>(
      `/api/canvases/${canvas.id}/edits`,
      { method: "POST", body: { edits: [{ op: "connect", source: "n_x", target: "n_y" }] } },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.field).toBe("edits.0");
    expect(bad.body.error.userMessage).toBe("There's no node n_x on this canvas.");
    // Nothing was saved.
    expect((await detail(server, canvas.id)).graphVersion).toBe(canvas.graphVersion);
    expect(eventsOf(server, "canvas.updated")).toEqual([]);
  });

  test("a rename renames the canvas, and nothing to do changes nothing", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server, { name: "Before" });
    const res = await server.json<CanvasEditsResponse>(`/api/canvases/${canvas.id}/edits`, {
      method: "POST",
      body: { edits: [{ op: "rename_canvas", name: "After" }] },
    });
    expect(res.status).toBe(200);
    const renamed = await detail(server, canvas.id);
    expect(renamed.name).toBe("After");
    expect(renamed.graph.name).toBe("After");

    await saveKey(server);
    const made = server.services.canvases.edit(canvas.id, chain, { kind: "tab", tabId: "tab-bbbbbbbb" });
    const frames = eventsOf(server, "canvas.updated").length;
    // Connecting what's already connected saves nothing and tells no one.
    const again = await server.json<CanvasEditsResponse>(`/api/canvases/${canvas.id}/edits`, {
      method: "POST",
      body: { edits: [{ op: "connect", source: made.aliases.p, target: made.aliases.g }] },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ops: [], graphVersion: made.graphVersion });
    expect(eventsOf(server, "canvas.updated")).toHaveLength(frames);
  });

  test("images given to an Upload node have to be in the library", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const res = await server.json<{ error: { userMessage: string } }>(`/api/canvases/${canvas.id}/edits`, {
      method: "POST",
      body: {
        edits: [
          { op: "add_node", type: "image.upload", params: { assetIds: ["01K6BQ80000000000000000000"] } },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.userMessage).toBe("There's no image 01K6BQ80000000000000000000 in your library.");
  });
});

describe("agent edits", () => {
  test("save a version before a session's first change to a canvas, once", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const svc = server.services.canvases;

    const first = svc.edit(canvas.id, chain, agent("s-1"));
    expect(first.versionId).not.toBeNull();
    const second = svc.edit(canvas.id, [{ op: "rename_canvas", name: "Two" }], agent("s-1"));
    expect(second.versionId).toBeNull();
    // Another connection of the same app is another session.
    const other = svc.edit(canvas.id, [{ op: "rename_canvas", name: "Three" }], agent("s-2"));
    expect(other.versionId).not.toBeNull();

    const versions = (await server.json<CanvasVersion[]>(`/api/canvases/${canvas.id}/versions`)).body;
    const mine = versions.filter((v) => v.label === "Before Claude Code");
    expect(mine).toHaveLength(2);
    expect(mine.every((v) => v.kind === "named")).toBe(true);
    // The first one is the canvas as it was: empty.
    const oldest = mine.find((v) => v.id === first.versionId)!;
    expect(oldest.nodeCount).toBe(0);

    const activity = eventsOf(server, "agent.activity");
    expect(activity).toHaveLength(3);
    expect(activity[0]).toMatchObject({
      canvasId: canvas.id,
      kind: "editing",
      actor: { name: "Claude Code" },
      nodeIds: first.touched,
      versionId: first.versionId,
    });
    const updated = eventsOf(server, "canvas.updated");
    expect(updated[0]).toMatchObject({ versionId: first.versionId, actor: { kind: "agent" } });
  });

  test("can't delete a node that's running", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const svc = server.services.canvases;
    const made = svc.edit(canvas.id, chain, agent());
    const generate = made.aliases.g!;
    server.services.canvasRuns.busyNodes = () => new Set([generate]);
    expect(() => svc.edit(canvas.id, [{ op: "remove_nodes", ids: [generate] }], agent())).toThrow(/running/);
    // Its settings can still change, as in the editor.
    expect(
      svc.edit(canvas.id, [{ op: "update_node", id: generate, params: { prompt: "x" } }], agent()).ops,
    ).toHaveLength(1);
  });
});

describe("runScope", () => {
  test("compiles the saved canvas, runs it with no tab open, and says what it did", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { aliases } = server.services.canvases.edit(canvas.id, chain, agent());
    const runs = server.services.canvasRuns;

    const dry = await runs.runScope(canvas.id, { scope: "all", dryRun: true }, agent());
    expect(dry).toMatchObject({ outcome: "plan", runId: null, planned: [aliases.g], jobs: 2 });
    expect(dry.estimate.max).toBeGreaterThan(0);
    // A dry run is not a change: no version, no activity.
    expect(eventsOf(server, "agent.activity").filter((a) => a.kind === "running")).toEqual([]);

    const run = await runs.runScope(canvas.id, { scope: "all" }, agent("s-run"));
    expect(run.outcome).toBe("plan");
    expect(run.runId).not.toBeNull();
    const [running] = eventsOf(server, "agent.activity").filter((a) => a.kind === "running");
    expect(running).toMatchObject({ nodeIds: [aliases.g], actor: { sessionId: "s-run" } });
    expect(running?.versionId).not.toBeNull();
    expect((await finished(server, run.runId!)).status).toBe("succeeded");

    // Nothing changed since, so nothing runs again.
    const again = await runs.runScope(canvas.id, { scope: "all", dryRun: true });
    expect(again.upToDate).toEqual([aliases.g!]);
    expect(again.jobs).toBe(0);
  });

  test("reports blocked nodes in the words the node shows, and asks before running upstream", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const svc = server.services.canvases;
    const { aliases } = svc.edit(
      canvas.id,
      [
        { op: "add_node", as: "g", type: "image.generate", params: { model: MODEL } },
        { op: "add_node", as: "v", type: "image.variations", params: { model: MODEL } },
        { op: "connect", source: "g", target: "v" },
      ],
      agent(),
    );
    const runs = server.services.canvasRuns;
    const g = aliases.g!;
    const v = aliases.v!;
    const blocked: CanvasRunScopeResponse = await runs.runScope(canvas.id, { scope: "all", dryRun: true });
    expect(blocked.blocked).toContainEqual({
      nodeId: g,
      reason: "no_prompt",
      message: expect.any(String),
    });

    svc.edit(canvas.id, [{ op: "update_node", id: g, params: { prompt: "a mug" } }], agent());
    const single = await runs.runScope(canvas.id, { scope: "node", nodeIds: [v], dryRun: true });
    expect(single).toMatchObject({ outcome: "needs_upstream", upstream: [g] });
    const both = await runs.runScope(canvas.id, {
      scope: "node",
      nodeIds: [v],
      includeUpstream: true,
      dryRun: true,
    });
    expect(both.planned).toEqual([g, v]);
  });
});

describe("presence", () => {
  const report = (s: TestServer, tabId: string, extra: Record<string, unknown> = {}) =>
    s.json("/api/presence", {
      method: "POST",
      body: { tabId, path: "/image", canvasId: null, selection: [], focused: false, ...extra },
    });

  test("the active tab is the one focused last, and navigate goes to it", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    expect(server.services.presence.active()).toBeNull();
    expect(server.services.presence.navigate({ kind: "path", path: "/assets" })).toBeNull();

    expect((await report(server, "tab-one-1111", { focused: true })).status).toBe(200);
    // Asks travel on the tab's event stream, so only tabs with one open can be asked.
    expect(server.services.presence.navigate({ kind: "path", path: "/assets" })).toBeNull();
    server.services.presence.connected("tab-one-1111");
    server.services.presence.connected("tab-two-2222");
    await Bun.sleep(5);
    await report(server, "tab-two-2222", {
      path: `/canvas/${canvas.id}`,
      canvasId: canvas.id,
      selection: ["n_a"],
      focused: true,
    });
    // A background tab changing route doesn't take over.
    await Bun.sleep(5);
    await report(server, "tab-one-1111", { path: "/assets", focused: false });
    expect(server.services.presence.active()).toMatchObject({
      tabId: "tab-two-2222",
      canvasId: canvas.id,
      selection: ["n_a"],
    });

    expect(server.services.presence.navigate({ kind: "asset", id: canvas.id })).toBe("tab-two-2222");
    expect(eventsOf(server, "ui.navigate")).toEqual([
      { tabId: "tab-two-2222", to: { kind: "asset", id: canvas.id } },
    ]);

    server.services.presence.drop("tab-two-2222");
    expect(server.services.presence.active()?.tabId).toBe("tab-one-1111");
  });

  test("a tab is forgotten when its event stream closes", async () => {
    server = await startTestServer();
    await report(server, "tab-gone-333", { focused: true });
    const controller = new AbortController();
    const res = await server.request("/api/events?tab=tab-gone-333", { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
    await res.body?.cancel().catch(() => {});
    await Bun.sleep(10);
    expect(server.services.presence.active()).toBeNull();
  });
});

describe("the dev agent routes", () => {
  test("exist in fake mode only", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const off = await server.json(`/api/dev/agent/canvases/${canvas.id}/edits`, {
      method: "POST",
      body: { edits: [{ op: "rename_canvas", name: "x" }] },
    });
    expect(off.status).toBe(404);
    await server.close();

    server = await startTestServer({ env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
    const fake = await newCanvas(server);
    const on = await server.json<CanvasEditsResponse>(`/api/dev/agent/canvases/${fake.id}/edits`, {
      method: "POST",
      body: { edits: [{ op: "add_node", type: "note" }], agent: { name: "Test agent" } },
    });
    expect(on.status).toBe(200);
    expect(on.body.versionId).not.toBeNull();
    expect(eventsOf(server, "agent.activity")[0]).toMatchObject({ actor: { name: "Test agent" } });
  });
});
