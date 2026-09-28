import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { canvasRunStateSchema, canvasUpdatedSchema } from "@openfield/core";
import { getCanvas, jobSetsOfRun } from "@openfield/db";
import { gatedFetch, saveKey, startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";

// Canvases through /mcp (docs/agents.md): an agent builds, changes, runs and reads canvases with the
// SDK's own client, as the person watches in an open tab. Fake companies answer every call.

let server: TestServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await server?.close();
  server = undefined;
});

async function ready(opts: Parameters<typeof startTestServer>[0] = {}) {
  const s = await startTestServer(opts);
  server = s;
  await saveKey(s);
  await turnOnAgents(s);
  const c = await connectAgent(s);
  client = c;
  return { server: s, client: c };
}

// biome-ignore lint/suspicious/noExplicitAny: tool answers are free-form JSON; each test checks what it needs.
type Json = Record<string, any>;
const j = (r: { json: unknown }) => r.json as Json;

/** A canvas with a prompt feeding a Generate node, built through edit_canvas. */
async function promptToGenerate(c: Client, name = "Mugs", prompt = "A stoneware mug on linen") {
  const made = j(await call(c, "create_canvas", { name }));
  const edited = await call(c, "edit_canvas", {
    canvas: made.canvasId,
    edits: [
      { op: "add_node", as: "p", type: "prompt", params: { text: prompt } },
      { op: "add_node", as: "g", type: "image.generate", params: { aspect: "1:1" } },
      { connect: "p.text", to: "g.prompt" },
    ],
  });
  expect(edited.isError).toBe(false);
  const created = j(edited).created as { p: string; g: string };
  return { canvasId: made.canvasId as string, ...created };
}

/** A tab showing a canvas, with its event stream open, as the web app reports itself. */
function openTab(s: TestServer, canvasId: string | null, tabId = "tab-0001-test", selection: string[] = []) {
  s.services.presence.connected(tabId);
  s.services.presence.report({
    tabId,
    path: canvasId ? `/canvas/${canvasId}` : "/image",
    canvasId,
    selection,
    focused: true,
  });
  return tabId;
}

describe("canvases", () => {
  test("list, make, read and name canvases, and templates", async () => {
    const { client: c } = await ready();
    const listed = j(await call(c, "list_canvases", { templates: true }));
    expect(listed.canvases).toEqual([]);
    expect(listed.templates.length).toBeGreaterThan(0);

    const blank = j(await call(c, "create_canvas", { name: "Moodboard" }));
    expect(blank).toMatchObject({ name: "Moodboard", graphVersion: 1, nodes: [], edges: [] });
    expect(blank.url).toBe(`http://127.0.0.1:4317/canvas/${blank.canvasId}`);

    const fromTemplate = j(await call(c, "create_canvas", { templateId: listed.templates[0].templateId }));
    expect(fromTemplate.nodes.length).toBeGreaterThan(0);

    const renamed = await call(c, "rename_canvas", { canvas: blank.canvasId, name: "Mood board" });
    expect(renamed.isError).toBe(false);
    // By exact name too.
    expect(j(await call(c, "get_canvas", { canvas: "Mood board" })).canvasId).toBe(blank.canvasId);

    const copy = j(await call(c, "duplicate_canvas", { canvas: blank.canvasId, name: "Mood board 2" }));
    expect(copy).toMatchObject({ name: "Mood board 2" });
    // Deleting a canvas asks first by default. This app can't show a prompt, so the agent asks in
    // its chat and says so with confirm.
    const asks = await call(c, "delete_canvas", { canvas: copy.canvasId });
    expect(asks.isError).toBe(true);
    expect(asks.text).toContain("confirm: true");
    const gone = j(await call(c, "delete_canvas", { canvas: copy.canvasId, confirm: true }));
    expect(gone.deleted).toBe(copy.canvasId);
    const missing = await call(c, "get_canvas", { canvas: copy.canvasId });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("list_canvases");
  });

  test("edit_canvas builds a graph in one batch, and get_canvas reads it back compactly", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, p, g } = await promptToGenerate(c);
    const read = j(await call(c, "get_canvas", { canvas: canvasId }));
    expect(read.nodes).toMatchObject([
      { id: p, type: "prompt", title: "Prompt", params: { text: "A stoneware mug on linen" } },
      {
        id: g,
        type: "image.generate",
        title: "Generate",
        state: "idle",
        params: { size: { kind: "aspect", ratio: "1:1" } },
      },
    ]);
    expect(read.edges).toMatchObject([{ from: `${p}.text`, to: `${g}.prompt` }]);
    // The saved canvas has them too, and every tab heard the edits as ops to replay.
    expect(getCanvas(s.services.db, canvasId)?.nodeCount).toBe(2);
    const updated = s.events
      .filter((e) => e.event === "canvas.updated")
      .map((e) => canvasUpdatedSchema.parse(e.data));
    expect(updated.at(-1)).toMatchObject({ canvasId, actor: { kind: "agent", name: "Claude Code" } });
  });

  test("a refused edit names the edit and why, and changes nothing", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, g } = await promptToGenerate(c);
    const before = getCanvas(s.services.db, canvasId)!.graphVersion;
    const refused = await call(c, "edit_canvas", {
      canvas: canvasId,
      edits: [
        { op: "add_node", as: "n", type: "note", params: { text: "ok" } },
        { op: "connect", source: g, target: "nowhere" },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toStartWith("edit 1: ");
    expect(refused.text).toContain("Nothing was changed.");
    expect(getCanvas(s.services.db, canvasId)!.graphVersion).toBe(before);

    const labelled = await call(c, "add_nodes", {
      canvas: canvasId,
      nodes: [{ as: "q", type: "prompt" }],
      connections: [{ from: "q.text", to: "missing.prompt" }],
    });
    expect(labelled.text).toStartWith("connections[0]: ");

    const stale = await call(c, "edit_canvas", {
      canvas: canvasId,
      graphVersion: 1,
      edits: [{ op: "rename_canvas", name: "Other" }],
    });
    expect(stale.isError).toBe(true);
  });

  test("an edit past a node's limits is refused and says which; a long prompt line still runs", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, p } = await promptToGenerate(c);
    const before = getCanvas(s.services.db, canvasId)!.graphVersion;
    const nine = Array.from({ length: 9 }, (_, i) => `Take ${i + 1}`);
    const tooMany = await call(c, "edit_canvas", {
      canvas: canvasId,
      edits: [
        { op: "add_node", type: "image.variations", params: { strategy: "prompt-list", prompts: nine } },
      ],
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("at most 8 prompts");
    const tooLong = await call(c, "edit_canvas", {
      canvas: canvasId,
      edits: [{ op: "add_node", type: "prompt", params: { text: "x".repeat(4001) } }],
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toMatch(/at most 4,?000 characters/);
    expect(getCanvas(s.services.db, canvasId)!.graphVersion).toBe(before);

    // A prompt line longer than a run's captions (the error an agent's canvas once hit) is fine:
    // the edit lands, and the run plan carries the line whole.
    const line = `A perfume bottle on wet black stone, ${"soft rim light from the left, ".repeat(9)}`.trim();
    expect(line.length).toBeGreaterThan(200);
    const made = await call(c, "edit_canvas", {
      canvas: canvasId,
      edits: [
        {
          op: "add_node",
          as: "v",
          type: "image.variations",
          params: { strategy: "prompt-list", prompts: [line, "Morning light"] },
        },
        { op: "connect", source: p, target: "v" },
      ],
    });
    expect(made.isError).toBe(false);
    const dry = await call(c, "run_canvas", { canvas: canvasId, scope: "all", dryRun: true });
    expect(dry.isError).toBe(false);

    // The limits are there to read before writing.
    const types = j(await call(c, "list_node_types")).types as Json[];
    expect(types.find((t) => t.type === "image.variations")?.limits).toMatchObject({
      prompts: { maxItems: 8, maxChars: 4000 },
      count: { min: 2, max: 8 },
    });
  });

  test("the thin tools add, connect, change, move and remove nodes", async () => {
    const { client: c } = await ready();
    const { canvasId, g } = await promptToGenerate(c);
    const added = j(
      await call(c, "add_nodes", {
        canvas: canvasId,
        nodes: [
          { as: "p2", type: "prompt", params: { text: "warm light" } },
          { as: "v", type: "image.variations", near: g },
        ],
        connections: [{ from: `${g}.images`, to: "v.image" }],
      }),
    );
    const v = added.created.v as string;
    expect(added.changed.map((n: Json) => n.id)).toContain(v);

    const joined = await call(c, "connect", { canvas: canvasId, from: added.created.p2, to: `${v}.prompt` });
    expect(joined.isError).toBe(false);
    const changed = j(
      await call(c, "update_node", { canvas: canvasId, id: g, params: { batch: 2 }, title: "Hero" }),
    );
    expect(changed.changed).toMatchObject([{ id: g, title: "Hero", params: { batch: 2 } }]);
    const moved = j(await call(c, "move_node", { canvas: canvasId, id: v, position: { x: 900, y: 40 } }));
    expect(moved.changed).toMatchObject([{ id: v, position: { x: 900, y: 40 } }]);
    await call(c, "delete_nodes", { canvas: canvasId, ids: [v] });
    const read = j(await call(c, "get_canvas", { canvas: canvasId }));
    expect(read.nodes.map((n: Json) => n.id)).not.toContain(v);
  });

  test("list_node_types gives ports, settings and defaults", async () => {
    const { client: c } = await ready();
    const types = j(await call(c, "list_node_types")).types as Json[];
    const generate = types.find((t) => t.type === "image.generate")!;
    expect(generate).toMatchObject({ name: "Generate", makesImages: true });
    expect(generate.inputs.map((p: Json) => p.port)).toEqual(["prompt", "input_images"]);
    expect(generate.outputs).toEqual([{ port: "images", gives: "image" }]);
    expect(generate.defaults.model).toBe("google:gemini-3-pro-image");
    expect(Object.keys(generate.settings)).toContain("prompt");
    expect(types.find((t) => t.type === "note")).toMatchObject({ forLayout: true, makesImages: false });
  });

  test("versions: saved before the agent's first change, listed, saved and restored live", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId } = await promptToGenerate(c);
    const versions = j(await call(c, "list_versions", { canvas: canvasId })).versions as Json[];
    expect(versions.map((v) => v.label)).toContain("Before Claude Code");
    const saved = j(await call(c, "save_version", { canvas: canvasId, label: "Two nodes" }));
    await call(c, "edit_canvas", { canvas: canvasId, edits: [{ op: "add_node", type: "note" }] });
    expect(j(await call(c, "get_canvas", { canvas: canvasId })).nodes).toHaveLength(3);

    const restored = j(await call(c, "restore_version", { canvas: canvasId, versionId: saved.versionId }));
    expect(restored.canvas.nodes).toHaveLength(2);
    // Sent live like any other change, so an open tab replays it.
    const last = canvasUpdatedSchema.parse(s.events.filter((e) => e.event === "canvas.updated").at(-1)!.data);
    expect(last.ops.some((op) => op.op === "deleteNode")).toBe(true);
    // What was there before the restore is kept.
    const after = j(await call(c, "list_versions", { canvas: canvasId })).versions as Json[];
    expect(after.length).toBeGreaterThan(versions.length + 1);
  });
});

describe("running canvases", () => {
  test("run_canvas runs it, names the agent on its job sets, and a second run is free", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, g } = await promptToGenerate(c);
    const priced = j(await call(c, "run_canvas", { canvas: canvasId, dryRun: true }));
    expect(priced).toMatchObject({
      dryRun: true,
      images: 1,
      runs: [g],
      price: { usd: 0.134 },
      needsConfirmCost: false,
    });

    const ran = await call(c, "run_canvas", { canvas: canvasId });
    expect(ran.isError).toBe(false);
    expect(j(ran)).toMatchObject({
      status: "succeeded",
      finished: true,
      nodes: [{ nodeId: g, state: "done" }],
    });
    expect(ran.images).toHaveLength(1);
    const image = j(ran).nodes[0].images[0];
    expect(image.url).toBe(`http://127.0.0.1:4317/image?asset=${image.assetId}`);
    for (const set of jobSetsOfRun(s.services.db, j(ran).runId))
      expect(set).toMatchObject({ agent: "Claude Code", source: "canvas" });
    // Spent by an agent, so it counts toward the daily limit.
    expect(s.services.agents.today().usd).toBe(0.134);

    const read = j(await call(c, "get_canvas", { canvas: canvasId }));
    expect(read.nodes.find((n: Json) => n.id === g)).toMatchObject({
      state: "done",
      images: [image.assetId],
    });
    const again = j(await call(c, "run_canvas", { canvas: canvasId }));
    expect(again).toMatchObject({ ran: false, upToDate: [g] });
  });

  test("run_canvas goes through the agents' limits", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, g } = await promptToGenerate(c);
    await call(c, "update_node", { canvas: canvasId, id: g, params: { batch: 4 } });
    await s.json("/api/settings", { method: "PATCH", body: { agentAskAboveUsd: 0.5 } });
    const ask = await call(c, "run_canvas", { canvas: canvasId });
    expect(ask.isError).toBe(true);
    expect(ask.text).toContain("confirmCost: 0.536");
    await s.json("/api/settings", { method: "PATCH", body: { agentDailyCapUsd: 0.4 } });
    const capped = await call(c, "run_canvas", { canvas: canvasId, confirmCost: 0.536 });
    expect(capped.text).toContain("daily limit");
    expect(s.services.canvasRuns.list(canvasId, "1970-01-01T00:00:00.000Z")).toHaveLength(0);
  });

  test("a blocked node says why, and a node needing earlier ones says so", async () => {
    const { client: c } = await ready();
    const made = j(await call(c, "create_canvas", { name: "Empty prompt" }));
    const built = j(
      await call(c, "edit_canvas", {
        canvas: made.canvasId,
        edits: [{ op: "add_node", as: "g", type: "image.generate" }],
      }),
    );
    const read = j(await call(c, "get_canvas", { canvas: made.canvasId }));
    expect(read.nodes[0].needs).toBeString();
    const blocked = await call(c, "run_canvas", { canvas: made.canvasId });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toStartWith("Nothing can run yet.");
    expect(blocked.text).toContain(built.created.g);
  });

  test("a slow run is handed back, progress arrives, get_run waits for it, and stop_run stops one", async () => {
    const gate = gatedFetch();
    const { client: c } = await ready({ fetch: gate.fetch });
    const { canvasId, g } = await promptToGenerate(c);
    const early = j(await call(c, "run_canvas", { canvas: canvasId, wait: 0 }));
    expect(early).toMatchObject({ finished: false });
    expect(early.next).toContain("get_run");

    const progress: number[] = [];
    const waiting = c.callTool(
      { name: "get_run", arguments: { canvas: canvasId, wait: 30 } },
      CallToolResultSchema,
      { onprogress: (p) => progress.push(p.progress) },
    );
    await Bun.sleep(50);
    gate.release();
    const result = (await waiting) as CallToolResult;
    const view = JSON.parse((result.content[0] as { text: string }).text);
    expect(view).toMatchObject({ runId: early.runId, finished: true, nodes: [{ nodeId: g, state: "done" }] });
    expect(progress.at(-1)).toBe(1);

    const gate2 = gatedFetch();
    await server!.close();
    ({ client: client } = await ready({ fetch: gate2.fetch }));
    const second = await promptToGenerate(client!, "Stop me");
    const running = j(await call(client!, "run_canvas", { canvas: second.canvasId, wait: 0 }));
    const stopped = await call(client!, "stop_run", { canvas: second.canvasId, runId: running.runId });
    expect(stopped.text).toContain("may still be charged");
    gate2.release();
    const after = j(
      await call(client!, "get_run", { canvas: second.canvasId, runId: running.runId, wait: 10 }),
    );
    expect(after.status).toBe("canceled");
  });
});

describe("the person's tab", () => {
  test('"active" is the canvas open in the tab used last, with its selection', async () => {
    const { server: s, client: c } = await ready();
    const none = await call(c, "get_canvas", { canvas: "active" });
    expect(none.text).toContain("No Openfield tab is open");
    const { canvasId, g } = await promptToGenerate(c);
    const first = openTab(s, null);
    expect((await call(c, "get_canvas", { canvas: "active" })).text).toContain("isn't showing a canvas");

    // The person moves to another tab: the first one loses focus as the second takes it.
    s.services.presence.report({
      tabId: first,
      path: "/image",
      canvasId: null,
      selection: [],
      focused: false,
    });
    await Bun.sleep(2);
    openTab(s, canvasId, "tab-0002-test", [g]);
    const active = j(await call(c, "get_active_canvas"));
    expect(active).toMatchObject({ open: true, canvas: { canvasId }, selected: [g] });
    expect(j(await call(c, "get_canvas", { canvas: "active" }))).toMatchObject({ canvasId, openInTabs: 1 });
    // Reading keeps the agent's pill alive in that tab, without raising one.
    const readings = s.events.filter(
      (e) => e.event === "agent.activity" && (e.data as Json).kind === "reading",
    );
    expect(readings.length).toBeGreaterThan(0);
    const edited = await call(c, "update_node", { canvas: "active", id: g, params: { batch: 2 } });
    expect(edited.isError).toBe(false);
  });

  test("show opens a canvas, an image or a page in the tab, or gives the link when none is open", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, g } = await promptToGenerate(c);
    const noTab = j(await call(c, "show", { canvas: canvasId }));
    expect(noTab).toMatchObject({ shown: false, url: `http://127.0.0.1:4317/canvas/${canvasId}` });

    const tabId = openTab(s, null);
    const shown = j(await call(c, "show", { canvas: canvasId, nodeIds: [g] }));
    expect(shown.shown).toBe(true);
    const navigate = s.events.filter((e) => e.event === "ui.navigate").at(-1)!.data as Json;
    expect(navigate).toEqual({ tabId, to: { kind: "canvas", id: canvasId, nodeIds: [g] } });
    expect(j(await call(c, "show", { page: "spending" })).shown).toBe(true);
    expect((s.events.filter((e) => e.event === "ui.navigate").at(-1)!.data as Json).to).toEqual({
      kind: "path",
      path: "/settings/spending",
    });
    expect((await call(c, "show", {})).isError).toBe(true);
  });

  test("canvases are resources too", async () => {
    const { client: c } = await ready();
    const { canvasId } = await promptToGenerate(c);
    const listed = await c.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain(`openfield://canvas/${canvasId}`);
    const read = await c.readResource({ uri: `openfield://canvas/${canvasId}` });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toMatchObject({
      canvasId,
      nodes: [{}, {}],
    });
  });
});

describe("the daily limit under pressure", () => {
  test("two calls at once can't both slip under the limit", async () => {
    const gate = gatedFetch();
    const { server: s, client: c } = await ready({ fetch: gate.fetch });
    await s.json("/api/settings", { method: "PATCH", body: { agentDailyCapUsd: 0.2 } });
    const results = await Promise.all([
      call(c, "generate_image", { prompt: "one", wait: 0 }),
      call(c, "generate_image", { prompt: "two", wait: 0 }),
    ]);
    gate.release();
    expect(results.filter((r) => r.isError)).toHaveLength(1);
    expect(results.find((r) => r.isError)?.text).toContain("daily limit");
  });

  test("a canvas run holds its whole estimate until it ends", async () => {
    const gate = gatedFetch();
    const { server: s, client: c } = await ready({ fetch: gate.fetch });
    const { canvasId, g } = await promptToGenerate(c);
    // A second Generate after the first: its job set only exists once the first finishes.
    await call(c, "add_nodes", {
      canvas: canvasId,
      nodes: [{ as: "g2", type: "image.generate", params: { prompt: "again" } }],
      connections: [{ from: `${g}.images`, to: "g2.input_images" }],
    });
    const run = j(await call(c, "run_canvas", { canvas: canvasId, wait: 0 }));
    expect(run.finished).toBe(false);
    // Both nodes count now, though only the first has a job set yet: an image each at $0.134, and
    // the second card reads the first card's image, 560 tokens at Nano Banana Pro's $2 per 1M.
    const whole = 0.268 + (560 * 2) / 1e6;
    expect(s.services.agents.today().usd).toBeCloseTo(whole, 6);
    await s.json("/api/settings", { method: "PATCH", body: { agentDailyCapUsd: 0.3 } });
    const more = await call(c, "generate_image", { prompt: "more", wait: 0 });
    expect(more.text).toContain("daily limit");
    gate.release();
    await call(c, "get_run", { canvas: canvasId, runId: run.runId, wait: 20 });
    const state = canvasRunStateSchema.parse(s.services.canvasRuns.state(canvasId, run.runId));
    expect(state.status).toBe("succeeded");
    expect(s.services.agents.today().usd).toBeCloseTo(whole, 6);
  });

  test("with the limit reached, a model whose price is unknown is refused too", async () => {
    const { server: s, client: c } = await ready();
    const { checkSpend } = await import("../src/mcp/guard");
    const ctx = { svc: s.services, session: { id: "s", client: "Claude Code" } };
    const unknown = {
      currency: "USD",
      min: 0,
      max: 0,
      confidence: "unknown" as const,
      basis: "",
      pricedAt: "",
    };
    await s.json("/api/settings", { method: "PATCH", body: { agentDailyCapUsd: 0.1 } });
    // Under the limit: it's up to the person (confirmCost), not the limit.
    expect(checkSpend(ctx, unknown, { confirmCost: 1 })).toBeNull();
    await call(c, "generate_image", { prompt: "spend", model: "Nano Banana 2 Lite", count: 2 });
    // Spent 0.0672: the limit comes down to meet it.
    await s.json("/api/settings", { method: "PATCH", body: { agentDailyCapUsd: 0.05 } });
    const refused = checkSpend(ctx, unknown, { confirmCost: 1 });
    expect(refused).not.toBeNull();
    expect((refused!.content[0] as { text: string }).text).toContain("daily limit");
  });
});
