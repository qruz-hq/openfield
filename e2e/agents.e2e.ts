import { type APIRequestContext, expect, test } from "@playwright/test";
import { api, FAKE_KEY, sessionToken } from "./support";

// Settings > Agents end to end: turn agents on, copy the key, connect an app over MCP the way
// Claude Code does (raw Streamable HTTP, no SDK), watch it show up with what it made, set the
// limits, make a new key and turn agents off. Fake models answer every call.

test.describe.configure({ mode: "serial" });

const PROTOCOL = "2025-06-18";

/** One MCP app: initialize, then calls on the session it was given. Answers come as JSON or SSE. */
async function connect(request: APIRequestContext, key: string, name = "claude-code") {
  let session = "";
  let id = 0;
  const send = async (method: string, params: unknown = {}) => {
    const res = await request.post("/mcp", {
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL,
        ...(session && { "mcp-session-id": session }),
      },
      data: { jsonrpc: "2.0", id: ++id, method, params },
    });
    session ||= res.headers()["mcp-session-id"] ?? "";
    const text = await res.text();
    const body = res.headers()["content-type"]?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((message) => message.id === id)
      : JSON.parse(text);
    return { status: res.status(), body };
  };
  const hello = await send("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name, version: "1.0.0" },
  });
  expect(hello.status).toBe(200);
  await request.post("/mcp", {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
      "mcp-session-id": session,
    },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  return {
    hello: hello.body,
    call: async (tool: string, args: Record<string, unknown> = {}) => {
      const answer = await send("tools/call", { name: tool, arguments: args });
      const text = answer.body?.result?.content?.[0]?.text ?? "";
      return { isError: answer.body?.result?.isError === true, text, json: safeJson(text) };
    },
  };
}

const safeJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

test("agents are off until turned on, and say what they could do", async ({ page, request }) => {
  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("What agents can do")).toBeVisible();
  await expect(page.getByText("Never your keys")).toBeVisible();
  expect((await request.post("/mcp", { data: {} })).status()).toBe(404);
});

test("turn on, copy the key, and an app connects and makes images", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });

  await page.goto("/settings/agents");
  await page.getByRole("switch", { name: "Let agents use Openfield" }).click();
  await expect(page.getByText("Add to an app")).toBeVisible();

  const status = await api<{ key: string; endpoint: string }>(request, token, "GET", "/api/agents");
  expect(status.key).toMatch(/^of_ag_/);
  // Shown hidden but for its end; copied whole.
  await expect(page.getByText(`of_ag_••••••••${status.key.slice(-4)}`, { exact: true })).toBeVisible();
  await expect(page.getByText(status.key)).toHaveCount(0);
  await page.getByRole("button", { name: "Copy access key" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(status.key);

  // The Claude Code snippet copies with the key in it.
  await page.getByRole("tabpanel").getByRole("button", { name: "Copy" }).click();
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  expect(snippet).toContain(`claude mcp add --transport http --scope user openfield ${status.endpoint}`);
  expect(snippet).toContain(`Bearer ${status.key}`);
  await page.getByRole("tab", { name: "Claude Desktop" }).click();
  await expect(page.getByRole("tabpanel")).toContainText('"mcpServers"');
  await expect(page.getByRole("tabpanel")).toContainText("Nothing to paste");

  const app = await connect(request, status.key);
  expect(app.hello.result.serverInfo.name).toBe("openfield");
  const made = await app.call("generate_image", { prompt: "a stoneware mug on linen", count: 2 });
  expect(made.isError).toBe(false);
  expect(made.json).toMatchObject({ status: "succeeded", finished: true });
  expect(made.json.images).toHaveLength(2);

  await page.reload();
  const row = page.getByText("Claude Code", { exact: true }).last();
  await expect(row).toBeVisible();
  await expect(page.getByText("Connected now")).toBeVisible();
  await expect(page.getByText("2 images · $0.00 today")).toBeVisible();
});

test("the agents' limits save, and their spending opens in Spending", async ({ page, request }) => {
  const token = await sessionToken(request);
  await page.goto("/settings/agents");
  const cap = page.getByRole("textbox", { name: "Daily limit" });
  await cap.fill("2");
  await cap.press("Enter");
  await expect(cap).toHaveValue("$2.00");
  await expect
    .poll(
      async () =>
        (await api<{ agentDailyCapUsd: number }>(request, token, "GET", "/api/settings")).agentDailyCapUsd,
    )
    .toBe(2);
  await expect(page.getByText("$0.00 of $2.00")).toBeVisible();
  await page.getByRole("link", { name: /Spent by agents today/ }).click();
  await expect(page).toHaveURL(/\/settings\/spending$/);
});

test("a new key cuts off the old one, and turning agents off closes /mcp", async ({ page, request }) => {
  const token = await sessionToken(request);
  const before = (await api<{ key: string }>(request, token, "GET", "/api/agents")).key;
  await page.goto("/settings/agents");
  await page.getByRole("button", { name: "Make a new key" }).click();
  await expect(page.getByText("Made a new key.")).toBeVisible();
  const after = (await api<{ key: string }>(request, token, "GET", "/api/agents")).key;
  expect(after).not.toBe(before);
  await expect(page.getByText(`of_ag_••••••••${after.slice(-4)}`, { exact: true })).toBeVisible();
  const refused = await request.post("/mcp", {
    headers: { authorization: `Bearer ${before}`, "content-type": "application/json" },
    data: {},
  });
  expect(refused.status()).toBe(401);

  await page.getByRole("switch", { name: "Let agents use Openfield" }).click();
  await expect(page.getByText("What agents can do")).toBeVisible();
  expect(
    (await request.post("/mcp", { headers: { authorization: `Bearer ${after}` }, data: {} })).status(),
  ).toBe(404);
});
