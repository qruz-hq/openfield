import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentPermissions } from "@openfield/core";
import { getCanvas, listJobSets } from "@openfield/db";
import { actionsFor } from "../src/mcp/permissions";
import { ORIGIN, saveKey, startTestServer, type TestServer } from "./helpers";
import { appFetch, call, connectAgent, turnOnAgents } from "./mcp-helpers";

// Allow, Ask and Default per action (Settings > Agents). An app that can show a prompt (MCP
// elicitation) is asked there; one that can't is refused until the agent asked in its chat and
// says so with confirm: true.

let server: TestServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await server?.close();
  server = undefined;
});

async function ready() {
  const s = await startTestServer();
  server = s;
  await saveKey(s);
  await turnOnAgents(s);
  return s;
}

const permissions = (s: TestServer, agentPermissions: AgentPermissions) =>
  s.json("/api/settings", { method: "PATCH", body: { agentPermissions } });

/** An app that shows prompts, answering them as told and keeping what they said. */
async function promptingApp(s: TestServer, answer: "accept" | "decline") {
  const prompts: string[] = [];
  const client = new Client({ name: "cursor-vscode", version: "1" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    prompts.push(String(request.params.message));
    return { action: answer };
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: appFetch(s),
      requestInit: { headers: { authorization: `Bearer ${s.services.agents.key}` } },
    }),
  );
  clients.push(client);
  return { client, prompts };
}

async function plainApp(s: TestServer) {
  const client = await connectAgent(s);
  clients.push(client);
  return client;
}

async function canvasWithNote(c: Client) {
  const made = (await call(c, "create_canvas", { name: "Board" })).json as { canvasId: string };
  const edited = await call(c, "edit_canvas", {
    canvas: made.canvasId,
    edits: [{ op: "add_node", as: "n", type: "note", params: { text: "hi" } }],
  });
  return { canvasId: made.canvasId, note: (edited.json.created as { n: string }).n };
}

describe("which actions a call is", () => {
  test("tools map to their action, and a batch that removes nodes is a removal too", () => {
    expect(actionsFor("get_canvas", {})).toEqual(["read_canvases"]);
    expect(actionsFor("edit_canvas", { edits: [{ op: "add_node" }] })).toEqual(["change_canvases"]);
    expect(actionsFor("canvas_script", { code: 'Add("prompt")' })).toEqual(["change_canvases"]);
    expect(actionsFor("canvas_script", { code: "Remove(Nodes().map((n) => n.id))" })).toEqual([
      "change_canvases",
      "remove_nodes",
    ]);
    expect(actionsFor("canvas_script", { createCanvas: "New", code: "" })).toEqual([
      "change_canvases",
      "make_canvases",
    ]);
    expect(actionsFor("edit_canvas", { edits: [{ op: "remove_nodes" }] })).toEqual([
      "change_canvases",
      "remove_nodes",
    ]);
    expect(actionsFor("update_assets", { trash: true })).toEqual(["trash_images"]);
    expect(actionsFor("update_assets", { favourite: true, trash: true })).toEqual([
      "file_images",
      "trash_images",
    ]);
    expect(actionsFor("update_assets", { restore: true })).toEqual(["file_images"]);
    expect(actionsFor("delete_canvas", {})).toEqual(["delete_canvases"]);
  });

  test("the setting takes only known actions and Allow, Ask or Default", async () => {
    const s = await ready();
    expect((await permissions(s, { read_canvases: "ask" })).status).toBe(200);
    const bad = await s.json("/api/settings", {
      method: "PATCH",
      body: { agentPermissions: { fly: "ask" } },
    });
    expect(bad.status).toBe(400);
    const wrong = await s.json("/api/settings", {
      method: "PATCH",
      body: { agentPermissions: { show: "never" } },
    });
    expect(wrong.status).toBe(400);
  });
});

describe("Ask", () => {
  test("an app that can't show a prompt is refused until the agent asked in chat", async () => {
    const s = await ready();
    const c = await plainApp(s);
    await permissions(s, { read_canvases: "ask" });
    const refused = await call(c, "list_canvases");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("read your canvases");
    expect(refused.text).toContain("confirm: true");
    expect((await call(c, "list_canvases", { confirm: true })).isError).toBe(false);
    // Other actions are untouched.
    expect((await call(c, "list_folders")).isError).toBe(false);
  });

  test("an app that shows prompts asks the person, and a no changes nothing", async () => {
    const s = await ready();
    const { canvasId, note } = await canvasWithNote(await plainApp(s));
    await permissions(s, { remove_nodes: "ask" });

    const no = await promptingApp(s, "decline");
    // confirm can't stand in for the person when the app can ask them.
    const declined = await call(no.client, "edit_canvas", {
      canvas: canvasId,
      edits: [{ op: "remove_nodes", ids: [note] }],
      confirm: true,
    });
    expect(declined.text).toContain("The person said no in Cursor");
    expect(no.prompts).toEqual(["Cursor wants to remove nodes from a canvas. Allow it?"]);
    expect(getCanvas(s.services.db, canvasId)?.nodeCount).toBe(1);

    const yes = await promptingApp(s, "accept");
    const accepted = await call(yes.client, "delete_nodes", { canvas: canvasId, ids: [note] });
    expect(accepted.isError).toBe(false);
    expect(getCanvas(s.services.db, canvasId)?.nodeCount).toBe(0);
    // A change that removes nothing doesn't ask.
    await call(yes.client, "edit_canvas", { canvas: canvasId, edits: [{ op: "add_node", type: "note" }] });
    expect(yes.prompts).toHaveLength(1);
  });

  test("making images set to Ask asks every time, with the price", async () => {
    const s = await ready();
    await permissions(s, { make_images: "ask" });
    const plain = await plainApp(s);
    const refused = await call(plain, "generate_image", { prompt: "cheap" });
    expect(refused.text).toContain("check with them before every run like this");
    expect(refused.text).toContain("confirmCost: 0.134");

    const yes = await promptingApp(s, "accept");
    const made = await call(yes.client, "generate_image", { prompt: "asked" });
    expect(made.json).toMatchObject({ status: "succeeded" });
    expect(yes.prompts).toEqual(["Cursor wants to make an image for about $0.13. Allow it?"]);

    const no = await promptingApp(s, "decline");
    const declined = await call(no.client, "generate_image", { prompt: "no" });
    expect(declined.text).toContain("said no");
    expect(listJobSets(s.services.db, { status: "all" }).items).toHaveLength(1);
  });

  test("reading a resource set to Ask checks first too", async () => {
    const s = await ready();
    const c = await plainApp(s);
    const { canvasId } = await canvasWithNote(c);
    await permissions(s, { read_canvases: "ask" });
    await expect(c.readResource({ uri: `openfield://canvas/${canvasId}` })).rejects.toThrow(
      /check with them/,
    );
    const yes = await promptingApp(s, "accept");
    const read = await yes.client.readResource({ uri: `openfield://canvas/${canvasId}` });
    expect(read.contents).toHaveLength(1);
  });
});

describe("Allow and Default", () => {
  test("Default asks above the amount; Allow never asks, but the daily limit still holds", async () => {
    const s = await ready();
    const c = await plainApp(s);
    await s.json("/api/settings", {
      method: "PATCH",
      body: { agentAskAboveUsd: 0.1, agentDailyCapUsd: 0.2 },
    });
    expect((await call(c, "generate_image", { prompt: "default" })).text).toContain("confirmCost");
    await permissions(s, { make_images: "allow" });
    expect((await call(c, "generate_image", { prompt: "allowed" })).json).toMatchObject({
      status: "succeeded",
    });
    expect((await call(c, "generate_image", { prompt: "past the limit" })).text).toContain("daily limit");
  });

  test("Allow lets an agent delete a canvas without asking", async () => {
    const s = await ready();
    const c = await plainApp(s);
    const { canvasId } = await canvasWithNote(c);
    expect((await call(c, "delete_canvas", { canvas: canvasId })).isError).toBe(true);
    await permissions(s, { delete_canvases: "allow" });
    expect((await call(c, "delete_canvas", { canvas: canvasId })).isError).toBe(false);
  });

  test("trash set to Ask stops a trash, but not a favourite", async () => {
    const s = await ready();
    const c = await plainApp(s);
    const made = await call(c, "generate_image", { prompt: "keep" });
    const id = (made.json.images as { assetId: string }[])[0]!.assetId;
    await permissions(s, { trash_images: "ask" });
    expect((await call(c, "update_assets", { assetIds: [id], trash: true })).text).toContain(
      "move images to the Trash",
    );
    expect((await call(c, "update_assets", { assetIds: [id], favourite: true })).isError).toBe(false);
  });
});
