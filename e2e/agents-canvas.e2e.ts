import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, sessionToken } from "./support";

// An agent app, the MCP SDK's own client over HTTP, builds and runs a canvas while the person has it
// open: the nodes appear live, the pill and tags say who did it, and the run's image lands on the
// card. Fake models answer every call.

test.describe.configure({ mode: "serial" });

const pane = (page: Page) => page.locator(".of-canvas:not(.of-capture)");
const pill = (page: Page) => page.getByRole("status").filter({ hasText: /Claude Code/ });

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  expect(result.isError, text).not.toBe(true);
  return { json: JSON.parse(text), images: result.content.filter((b) => b.type === "image") };
}

test("an agent builds and runs a canvas while the person watches", async ({ page, request, baseURL }) => {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });
  const { key } = await api<{ key: string }>(request, token, "PUT", "/api/agents", { enabled: true });

  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );

  // The person opens a new canvas; the agent finds it as the active one.
  const canvas = (await tool(client, "create_canvas", { name: "Mug shoot" })).json;
  await page.goto(`/canvas/${canvas.canvasId}`);
  await expect(page.getByRole("button", { name: "Canvas menu" })).toBeVisible();
  await expect
    .poll(async () => (await tool(client, "get_active_canvas")).json.canvas?.canvasId)
    .toBe(canvas.canvasId);

  const edited = (
    await tool(client, "edit_canvas", {
      canvas: "active",
      edits: [
        { op: "add_node", as: "p", type: "prompt", params: { text: "A stoneware mug on linen" } },
        { op: "add_node", as: "g", type: "image.generate", params: { aspect: "1:1" } },
        { connect: "p.text", to: "g.prompt" },
      ],
    })
  ).json;
  const g = edited.created.g as string;

  // Live in the tab: the nodes, the connection, who's editing and what they touched.
  await expect(pane(page).locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Prompt text" })).toHaveValue("A stoneware mug on linen");
  await expect(pane(page).locator(".react-flow__edge")).toHaveCount(1);
  await expect(pill(page)).toHaveText(/Claude Code is editing/);
  await expect(pane(page).locator(`[data-agent-touch="${g}"]`)).toHaveCount(1);

  // Priced first, then run; the tab follows the run and the image lands on the card.
  const priced = (await tool(client, "run_canvas", { canvas: "active", dryRun: true })).json;
  expect(priced).toMatchObject({ dryRun: true, images: 1, runs: [g] });
  const ran = await tool(client, "run_canvas", { canvas: "active" });
  expect(ran.json).toMatchObject({ status: "succeeded", nodes: [{ nodeId: g, state: "done" }] });
  expect(ran.images).toHaveLength(1);
  const node = pane(page).locator(`.react-flow__node[data-id="${g}"]`);
  await expect(node.locator("img")).toHaveCount(1, { timeout: 20_000 });

  // The agent reads back what the person sees.
  const read = (await tool(client, "get_canvas", { canvas: "active" })).json;
  expect(read.nodes.find((n: { id: string }) => n.id === g)).toMatchObject({ state: "done" });
  expect(read.openInTabs).toBe(1);

  // And the run counts as the agent's, in Settings > Agents.
  const status = await api<{ clients: { name: string; today: { images: number } }[] }>(
    request,
    token,
    "GET",
    "/api/agents",
  );
  expect(status.clients.find((c) => c.name === "Claude Code")?.today.images).toBe(1);
  await client.close();
});

test("an agent builds a grid with canvas_script while the person watches", async ({
  page,
  request,
  baseURL,
}) => {
  const token = await sessionToken(request);
  const { key } = await api<{ key: string }>(request, token, "PUT", "/api/agents", { enabled: true });
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );

  const canvas = (await tool(client, "create_canvas", { name: "Mug grid" })).json;
  await page.goto(`/canvas/${canvas.canvasId}`);
  await expect(page.getByRole("button", { name: "Canvas menu" })).toBeVisible();

  const code = [
    'const colors = ["sage", "rust", "cobalt"];',
    "const spots = Grid(colors.length, { cols: 3 });",
    "colors.forEach((c, i) => {",
    '  const p = Add("prompt", { text: "A " + c + " stoneware mug on linen" }, { at: spots[i] });',
    '  const g = Add("image.generate", { aspect: "1:1" }, { near: p });',
    '  Connect(p + ".text", g + ".prompt");',
    "});",
    "Print(Nodes().length);",
  ].join("\n");

  // A dry run says what it would do and leaves the open tab alone.
  const dry = (await tool(client, "canvas_script", { canvas: canvas.canvasId, dryRun: true, code })).json;
  expect(dry).toMatchObject({ dryRun: true, edits: 9, ops: { add_node: 6, connect: 3 }, prints: ["6"] });
  await expect(pane(page).locator(".react-flow__node")).toHaveCount(0);

  // A broken script changes nothing and hands back a retryId to patch it with.
  const broken = (await client.callTool({
    name: "canvas_script",
    arguments: { canvas: canvas.canvasId, code: code.replace('"image.generate"', '"image.banana"') },
  })) as CallToolResult;
  expect(broken.isError).toBe(true);
  const text = broken.content[0]?.type === "text" ? broken.content[0].text : "";
  expect(text).toContain("Nothing was changed");
  const retryId = /retryId: (\w+)/.exec(text)?.[1];
  expect(retryId).toBeTruthy();
  await expect(pane(page).locator(".react-flow__node")).toHaveCount(0);

  // The patched script lands as one batch, live in the tab.
  const done = (
    await tool(client, "canvas_script", {
      canvas: canvas.canvasId,
      retryId,
      edits: [{ find: '"image.banana"', replace: '"image.generate"' }],
    })
  ).json;
  expect(done).toMatchObject({ canvasId: canvas.canvasId, edits: 9, prints: ["6"] });
  // The canvas only draws nodes in view, so count the wires; get_canvas has every node.
  await expect(pane(page).locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.getByRole("textbox", { name: "Prompt text" }).first()).toHaveValue(
    /stoneware mug on linen/,
  );
  await expect(pill(page)).toHaveText(/Claude Code is editing/);

  const read = (await tool(client, "get_canvas", { canvas: canvas.canvasId })).json;
  expect(read.nodes).toHaveLength(6);
  await client.close();
});
