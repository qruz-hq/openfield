import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_KEY_PREFIX, agentsStatusSchema } from "@openfield/core";
import { getAsset, getJobSet, listJobSets } from "@openfield/db";
import sharp from "sharp";
import { Bridge, notRunning } from "../src/mcp/stdio";
import { gatedFetch, saveKey, startTestServer, TEST_KEY, type TestServer } from "./helpers";
import { appFetch, call, connectAgent, turnOnAgents } from "./mcp-helpers";
import { keptOutside, quarterMask, texture } from "./pixels";

// Agent apps at /mcp (docs/agents.md), driven with the MCP SDK's own client, against a real server
// with fake companies: who gets in, what each tool does, and the spending limits.

let server: TestServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  setSystemTime();
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

const initialize = (s: TestServer, headers: Record<string, string> = {}) =>
  s.request("/mcp", {
    method: "POST",
    session: false,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    }),
  });

async function png(file: string, color = "#c0392b") {
  await sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .png()
    .toFile(file);
  return file;
}

type Answer = {
  id?: unknown;
  result?: { isError?: boolean; tools?: unknown[]; content?: { text: string }[] };
  error?: { message: string };
};

describe("who gets in", () => {
  test("nothing is at /mcp until agents are turned on", async () => {
    server = await startTestServer();
    const off = await initialize(server);
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: { message: string } }).error.message).toContain("turned off");

    const key = await turnOnAgents(server);
    expect(key.startsWith(AGENT_KEY_PREFIX)).toBe(true);
    expect((await initialize(server, { authorization: `Bearer ${key}` })).status).toBe(200);
  });

  test("a missing or wrong key is refused, and the page guards still apply", async () => {
    server = await startTestServer();
    const key = await turnOnAgents(server);
    expect((await initialize(server)).status).toBe(401);
    expect((await initialize(server, { authorization: `Bearer ${key}x` })).status).toBe(401);
    expect((await initialize(server, { authorization: key })).status).toBe(401);
    // The session token isn't a way in, and the browser's guards still run first.
    expect((await initialize(server, { "x-openfield-session": server.token })).status).toBe(401);
    const otherSite = await initialize(server, {
      authorization: `Bearer ${key}`,
      origin: "https://evil.example",
    });
    expect(otherSite.status).toBe(403);
    const rebound = await initialize(server, { authorization: `Bearer ${key}`, host: "evil.example:4317" });
    expect(rebound.status).toBe(403);
  });

  test("the Settings pane's routes need the session token, like every /api route", async () => {
    server = await startTestServer();
    expect((await server.request("/api/agents", { session: false })).status).toBe(403);
  });

  test("apps looking for a sign-in find none, instead of the web app", async () => {
    server = await startTestServer();
    const res = await server.request("/.well-known/oauth-protected-resource", { session: false });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("the key lives in config.json, private, and a replaced one never stays in the backup", async () => {
    server = await startTestServer();
    const first = await turnOnAgents(server);
    const config = join(server.home, "config.json");
    expect(JSON.parse(readFileSync(config, "utf8")).agents).toEqual({ enabled: true, key: first });
    expect(statSync(config).mode & 0o777).toBe(0o600);

    const renewed = agentsStatusSchema.parse((await server.json("/api/agents/key", { method: "POST" })).body);
    expect(renewed.key).not.toBe(first);
    expect(readFileSync(join(server.home, "config.json.bak"), "utf8")).not.toContain(first);
    // Turning off keeps the key for next time.
    await server.json("/api/agents", { method: "PUT", body: { enabled: false } });
    expect(JSON.parse(readFileSync(config, "utf8")).agents).toEqual({ enabled: false, key: renewed.key });
  });

  test("a new key or turning agents off ends every connection", async () => {
    const { server: s, client: c } = await ready();
    expect(s.services.mcp.count).toBe(1);
    await s.json("/api/agents/key", { method: "POST" });
    expect(s.services.mcp.count).toBe(0);
    await expect(c.listTools()).rejects.toThrow();

    client = await connectAgent(s);
    expect(s.services.mcp.count).toBe(1);
    await s.json("/api/agents", { method: "PUT", body: { enabled: false } });
    expect(s.services.mcp.count).toBe(0);
  });

  test("a session idle for half an hour ends, and the app is told to connect again", async () => {
    const { server: s, client: c } = await ready();
    setSystemTime(new Date(Date.now() + 31 * 60_000));
    s.services.mcp.sweep();
    expect(s.services.mcp.count).toBe(0);
    await expect(c.listTools()).rejects.toThrow(/connection to Openfield ended/);
  });
});

describe("the connection", () => {
  test("the app gets instructions and every tool, and Settings sees it by name", async () => {
    const { server: s, client: c } = await ready();
    expect(c.getInstructions()).toContain("Price first");
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "cancel_job",
        "canvas_script",
        "create_folder",
        "delete_folder",
        "estimate",
        "generate_image",
        "get_asset",
        "get_job",
        "get_settings",
        "get_usage",
        "import_image",
        "list_folders",
        "list_models",
        "recreate",
        "search_assets",
        "update_assets",
        "update_folder",
        "view_asset",
        "wait_for",
        // Canvases
        "list_canvases",
        "create_canvas",
        "get_canvas",
        "rename_canvas",
        "duplicate_canvas",
        "delete_canvas",
        "export_canvas",
        "import_canvas",
        "list_versions",
        "save_version",
        "restore_version",
        "list_node_types",
        "edit_canvas",
        "add_nodes",
        "connect",
        "update_node",
        "delete_nodes",
        "move_node",
        "run_canvas",
        "get_run",
        "stop_run",
        "get_active_canvas",
        "show",
      ].sort(),
    );
    await call(c, "list_folders");
    const status = agentsStatusSchema.parse((await s.json("/api/agents")).body);
    expect(status.clients).toMatchObject([{ name: "Claude Code", active: true }]);
    expect(status.endpoint).toBe("http://127.0.0.1:4317/mcp");
    expect(status.launch.args).toEqual(["run", "--silent", "--cwd", expect.any(String), "mcp"]);
    expect(status.launch.env.OPENFIELD_HOME).toBe(s.home);
  });
});

describe("making images", () => {
  test("generate_image makes it, answers with a preview, the file and a link, and names the app", async () => {
    const { server: s, client: c } = await ready();
    const made = await call(c, "generate_image", { prompt: "a lighthouse at dusk", aspect: "3:4" });
    expect(made.isError).toBe(false);
    expect(made.json).toMatchObject({ status: "succeeded", finished: true, waiting: 0 });
    const image = (made.json.images as unknown as { assetId: string; file: string; url: string }[])[0]!;
    expect(existsSync(image.file)).toBe(true);
    expect(image.url).toBe(`http://127.0.0.1:4317/image?asset=${image.assetId}`);
    expect(made.images).toHaveLength(1);
    expect(made.images[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const run = getJobSet(s.services.db, made.json.runId as unknown as string)!;
    expect(run).toMatchObject({ agent: "Claude Code", source: "api" });
  });

  test("dryRun prices it and makes nothing", async () => {
    const { server: s, client: c } = await ready();
    const priced = await call(c, "generate_image", { prompt: "x", count: 2, dryRun: true });
    expect(priced.json).toMatchObject({ dryRun: true, needsConfirmCost: false, price: { usd: 0.268 } });
    const estimated = await call(c, "estimate", { prompt: "x", count: 2 });
    expect(estimated.json).toMatchObject({ count: 2, price: { usd: 0.268 } });
    expect(listJobSets(s.services.db, { status: "all" }).items).toHaveLength(0);
  });

  test("above the ask-first amount it waits for confirmCost", async () => {
    const { server: s, client: c } = await ready();
    await s.json("/api/settings", { method: "PATCH", body: { agentAskAboveUsd: 0.1 } });
    const refused = await call(c, "generate_image", { prompt: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("confirmCost: 0.134");
    expect(listJobSets(s.services.db, { status: "all" }).items).toHaveLength(0);
    expect((await call(c, "generate_image", { prompt: "x", confirmCost: 0.1 })).isError).toBe(true);
    const agreed = await call(c, "generate_image", { prompt: "x", confirmCost: 0.134 });
    expect(agreed.json).toMatchObject({ status: "succeeded" });
  });

  test("the daily limit stops agents, counting what they spent and what's still running", async () => {
    const { server: s, client: c } = await ready();
    await s.json("/api/settings", { method: "PATCH", body: { agentDailyCapUsd: 0.2 } });
    expect((await call(c, "generate_image", { prompt: "one" })).json).toMatchObject({ status: "succeeded" });
    const second = await call(c, "generate_image", { prompt: "two" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("daily limit");
    const status = agentsStatusSchema.parse((await s.json("/api/agents")).body);
    expect(status.today).toEqual({ usd: 0.134, images: 1 });
    expect(status.clients[0]?.today).toEqual({ usd: 0.134, images: 1 });
  });

  test("a run not done in time is handed back, progress comes on the way, and wait_for picks it up", async () => {
    const gate = gatedFetch();
    const { client: c } = await ready({ fetch: gate.fetch });
    const early = await call(c, "generate_image", { prompt: "slow", count: 2, wait: 0 });
    expect(early.json).toMatchObject({ finished: false, waiting: 2 });
    expect(early.json.next).toContain("wait_for");
    const runId = early.json.runId as unknown as string;

    const progress: number[] = [];
    const waiting = c.callTool(
      { name: "wait_for", arguments: { runIds: [runId], wait: 30 } },
      CallToolResultSchema,
      {
        onprogress: (p) => progress.push(p.progress),
      },
    );
    await Bun.sleep(50);
    gate.release();
    const result = (await waiting) as CallToolResult;
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    expect(summary.finished).toBe(true);
    expect(summary.runs[0].images).toHaveLength(2);
    expect(result.content.filter((b) => b.type === "image")).toHaveLength(2);
    expect(progress.at(-1)).toBe(2);
  });

  test("get_job and cancel_job see and stop a run", async () => {
    const gate = gatedFetch();
    const { client: c } = await ready({ fetch: gate.fetch });
    const started = await call(c, "generate_image", { prompt: "stop me", wait: 0 });
    const runId = started.json.runId as unknown as string;
    expect((await call(c, "get_job", { runId })).json).toMatchObject({ runId, finished: false });
    const stopped = await call(c, "cancel_job", { runId });
    expect(stopped.json.note).toContain("may still be charged");
    gate.release();
    const after = await call(c, "wait_for", { runIds: [runId], wait: 5 });
    expect(after.json.runs).toMatchObject([{ status: "canceled" }]);
  });

  test("recreate runs the same request again as the agent's own run", async () => {
    const { server: s, client: c } = await ready();
    const first = await call(c, "generate_image", { prompt: "again" });
    const again = await call(c, "recreate", { runId: first.json.runId });
    expect(again.json).toMatchObject({
      status: "succeeded",
      prompt: "again",
      recreatedFrom: first.json.runId,
    });
    expect(getJobSet(s.services.db, again.json.runId as unknown as string)?.agent).toBe("Claude Code");
  });

  test("references and edits take a library id, a file path or a web address", async () => {
    const { server: s, client: c } = await ready();
    const file = await png(join(s.home, "tmp", "ref.png"));
    const bytes = readFileSync(file);
    const site = Bun.serve({
      port: 0,
      fetch: () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    });
    try {
      const imported = await call(c, "import_image", { source: file });
      expect(imported.json).toMatchObject({ kind: "uploaded", width: 64, height: 48 });
      expect(imported.images).toHaveLength(1);
      // The same bytes from the web are the same image.
      const fromWeb = await call(c, "import_image", { source: `http://127.0.0.1:${site.port}/a.png` });
      expect(fromWeb.json.assetId).toBe(imported.json.assetId);

      const made = await call(c, "generate_image", { prompt: "like this", references: [file] });
      expect(made.json).toMatchObject({ status: "succeeded" });
      const edited = await call(c, "generate_image", {
        prompt: "make it blue",
        edit: { image: imported.json.assetId },
      });
      expect(edited.json).toMatchObject({ status: "succeeded" });
      expect(getJobSet(s.services.db, edited.json.runId as unknown as string)?.op).toBe("edit");
    } finally {
      site.stop(true);
    }
  });

  test("mistakes come back as words the agent can act on", async () => {
    const { server: s, client: c } = await ready();
    const unknownModel = await call(c, "generate_image", { prompt: "x", model: "nope" });
    expect(unknownModel).toMatchObject({ isError: true });
    expect(unknownModel.text).toContain("list_models");
    const missing = await call(c, "generate_image", { prompt: "x", references: ["/no/such/file.png"] });
    expect(missing.text).toContain("There's no file at /no/such/file.png");
    const notAnImage = join(s.home, "tmp", "notes.txt");
    writeFileSync(notAnImage, "hello");
    expect((await call(c, "import_image", { source: notAnImage })).isError).toBe(true);
    expect((await call(c, "get_job", { runId: "01K6BQ7Y2M8N4P0R3S5T7V9W1X" })).text).toContain("no run");
  });

  test("list_models says what each model can do and costs, and models can be named", async () => {
    const { client: c } = await ready();
    const listed = await call(c, "list_models", { readyOnly: true });
    const models = listed.json.models as unknown as { key: string; name: string; price: string }[];
    expect(models.map((m) => m.name)).toContain("Nano Banana Pro");
    expect(models.find((m) => m.name === "Nano Banana Pro")?.price).toBe("About $0.13");
    const byName = await call(c, "estimate", { prompt: "x", model: "Nano Banana 2" });
    expect(byName.json.model).toBe("google:gemini-3.1-flash-image");
  });
});

describe("editing part of an image", () => {
  const OPENAI = "openai:gpt-image-2";

  async function withOpenAI(s: TestServer) {
    const res = await s.json("/api/settings/keys/openai", {
      method: "PUT",
      body: { apiKey: "sk-test-0123456789abcdefghijklmnop" },
    });
    expect(res.status).toBe(200);
  }

  /** A textured photo and a mask for its top-left quarter, as files an agent would pass. */
  async function files(s: TestServer, width = 640, height = 480) {
    const image = join(s.home, "tmp", "photo.png");
    const mask = join(s.home, "tmp", "mask.png");
    writeFileSync(image, await texture(width, height));
    writeFileSync(mask, await quarterMask(width, height));
    return { image, mask };
  }

  type Made = { assetId: string; file: string; width: number; height: number; keptOutsideMask?: boolean };
  const imagesOf = (json: Record<string, unknown>) => json.images as unknown as Made[];
  const editOf = (json: Record<string, unknown>) => json.edit as unknown as { image: string; mask: string };

  test("a mask from a file is saved as a mask, and only its area changes", async () => {
    const { server: s, client: c } = await ready();
    await withOpenAI(s);
    const { image, mask } = await files(s);
    const made = await call(c, "generate_image", {
      prompt: "a red door",
      model: OPENAI,
      edit: { image, mask },
    });
    expect(made.isError).toBe(false);
    expect(made.json).toMatchObject({
      status: "succeeded",
      op: "inpaint",
      edit: {
        composite: true,
        expandPx: 4,
        featherPx: 8,
        note: "Only the masked area changes: Openfield puts back the original everywhere else.",
      },
    });
    const edit = editOf(made.json);
    expect(made.json.edit).not.toHaveProperty("wholeImage");
    expect(getAsset(s.services.db, edit.mask)).toMatchObject({
      kind: "mask",
      parentAssetId: edit.image,
      width: 640,
      height: 480,
    });
    const [result] = imagesOf(made.json);
    expect(result).toMatchObject({ width: 640, height: 480, keptOutsideMask: true });
    const base = s.services.ingest.fileOf(getAsset(s.services.db, edit.image)!.path);
    const kept = await keptOutside(base, result!.file, 12);
    expect(kept).toMatchObject({ sameShape: true, outside: 0 });
    expect(kept.inside).toBeGreaterThan(kept.quarter * 0.9);

    // Masks stay out of the library, and the same mask again is the one already saved.
    const found = (await call(c, "search_assets", {})).json.images as unknown as { assetId: string }[];
    expect(found.map((i) => i.assetId)).toContain(result!.assetId);
    expect(found.map((i) => i.assetId)).not.toContain(edit.mask);
    const again = await call(c, "estimate", { prompt: "a red door", model: OPENAI, edit: { image, mask } });
    expect(again.json).toMatchObject({ op: "inpaint", edit: { image: edit.image, mask: edit.mask } });
    const details = await call(c, "get_asset", { assetId: result!.assetId, preview: false });
    expect(details.json).toMatchObject({ mask: edit.mask, keptOutsideMask: true });
  });

  test("a model without a mask input edits the whole image, keeps the rest, and says so", async () => {
    const { server: s, client: c } = await ready();
    // An edit keeps its image's shape, whatever the person's default.
    await s.json("/api/settings", { method: "PATCH", body: { defaultAspect: "1:1" } });
    const { image, mask } = await files(s);
    const made = await call(c, "generate_image", {
      prompt: "a red door",
      edit: { image, mask, expandPx: 12, featherPx: 0 },
    });
    expect(made.json).toMatchObject({
      status: "succeeded",
      op: "edit",
      modelName: "Nano Banana Pro",
      edit: { wholeImage: true, composite: true, expandPx: 12, featherPx: 0 },
    });
    expect((made.json.edit as unknown as { note: string }).note).toBe(
      "Nano Banana Pro can't take a mask, so it edits the whole image. Openfield then puts back everything outside the mask, so only the masked area changes.",
    );
    const run = getJobSet(s.services.db, made.json.runId as unknown as string)!;
    expect(run.requestJson).toMatchObject({ size: { aspect: "4:3" } });
    const [result] = imagesOf(made.json);
    expect(result).toMatchObject({ width: 640, height: 480, keptOutsideMask: true });
    const base = s.services.ingest.fileOf(getAsset(s.services.db, editOf(made.json).image)!.path);
    expect(await keptOutside(base, result!.file, 12)).toMatchObject({ sameShape: true, outside: 0 });

    // Composite off keeps the model's whole result, and says it did.
    const raw = await call(c, "generate_image", {
      prompt: "a red door",
      edit: { image, mask, composite: false },
    });
    expect(imagesOf(raw.json)[0]).toMatchObject({
      keptOutsideMask: false,
      why: "Composite was off, so this is the model's whole result.",
    });
    expect((raw.json.edit as unknown as { note: string }).note).toContain("all of it may change");
    expect(getJobSet(s.services.db, raw.json.runId as unknown as string)!.requestJson.mask).toMatchObject({
      composite: false,
      expandPx: 4,
      featherPx: 8,
    });
  });

  test("list_models says which models take a mask themselves", async () => {
    const { server: s, client: c } = await ready();
    await withOpenAI(s);
    const models = (await call(c, "list_models", { readyOnly: true })).json.models as unknown as {
      key: string;
      masks: boolean;
    }[];
    expect(models.find((m) => m.key === OPENAI)?.masks).toBe(true);
    expect(models.find((m) => m.key === "google:gemini-3-pro-image")?.masks).toBe(false);
  });

  test("a mask that can't be used is refused before anything is made", async () => {
    const { server: s, client: c } = await ready();
    const { image } = await files(s);
    const small = join(s.home, "tmp", "small-mask.png");
    writeFileSync(small, await quarterMask(320, 240));
    const wrongSize = await call(c, "generate_image", { prompt: "x", edit: { image, mask: small } });
    expect(wrongSize.isError).toBe(true);
    expect(wrongSize.text).toBe(
      "This mask is 320 × 240 and the image is 640 × 480. Draw the mask over the image itself, then try again. " +
        "A mask is the image's exact size and transparent where the image should change. In a mask with no transparency, white changes and black stays.",
    );
    const blank = join(s.home, "tmp", "blank-mask.png");
    await sharp({ create: { width: 640, height: 480, channels: 4, background: "#000000ff" } })
      .png()
      .toFile(blank);
    expect((await call(c, "generate_image", { prompt: "x", edit: { image, mask: blank } })).text).toContain(
      "Paint the area to change first.",
    );
    const noMask = await call(c, "generate_image", { prompt: "x", edit: { image, featherPx: 4 } });
    expect(noMask.text).toBe("composite, expandPx and featherPx only apply to an edit with a mask.");
    expect(listJobSets(s.services.db, { status: "all" }).items).toHaveLength(0);
  });
});

describe("the library", () => {
  test("search, look, favourite, file, trash and restore", async () => {
    const { server: s, client: c } = await ready();
    const made = await call(c, "generate_image", { prompt: "a red bicycle", count: 2 });
    const ids = (made.json.images as unknown as { assetId: string }[]).map((i) => i.assetId);

    const found = await call(c, "search_assets", { query: "bicycle", previews: true });
    expect(found.json.total).toBe(2);
    expect(found.images).toHaveLength(2);

    const folderId = (await call(c, "create_folder", { name: "Bikes" })).json.folderId as unknown as string;
    const changed = await call(c, "update_assets", { assetIds: ids, favourite: true, addToFolder: folderId });
    expect(changed.json.changed).toEqual({ favourited: 2, addedToFolder: 2 });
    expect((await call(c, "search_assets", { folderId })).json.total).toBe(2);

    const details = await call(c, "get_asset", { assetId: ids[0] });
    expect(details.json).toMatchObject({ favourite: true, folders: [{ folderId, name: "Bikes" }] });
    expect(details.images).toHaveLength(1);
    expect((await call(c, "view_asset", { assetId: ids[0], large: true })).images).toHaveLength(1);

    await call(c, "update_assets", { assetIds: [ids[0]], trash: true });
    expect((await call(c, "search_assets", { trash: true })).json.total).toBe(1);
    await call(c, "update_assets", { assetIds: [ids[0]], restore: true });
    expect((await call(c, "search_assets", { query: "bicycle" })).json.total).toBe(2);
    expect(s.events.some((e) => e.event === "asset.deleted")).toBe(true);
  });

  test("folders nest, move, rename and go, and a loop is refused", async () => {
    const { server: s, client: c } = await ready();
    const outer = (await call(c, "create_folder", { name: "Work" })).json.folderId;
    const inner = (await call(c, "create_folder", { name: "Mugs", parentId: outer })).json.folderId;
    const listed = await call(c, "list_folders");
    expect(listed.json.folders).toContainEqual(expect.objectContaining({ path: "Work / Mugs" }));
    const loop = await call(c, "update_folder", { folderId: outer, parentId: inner });
    expect(loop.text).toContain("can't go inside itself");
    const moved = await call(c, "update_folder", { folderId: inner, name: "Cups", parentId: null });
    expect(moved.json).toMatchObject({ path: "Cups", parentId: null });
    expect((await call(c, "delete_folder", { folderId: outer })).text).toContain("check with them");
    const gone = await call(c, "delete_folder", { folderId: outer, confirm: true });
    expect(gone.json.deletedFolderIds).toEqual([outer]);
    expect(s.events.some((e) => e.event === "folder.updated")).toBe(true);
  });

  test("images are resources too", async () => {
    const { client: c } = await ready();
    const made = await call(c, "generate_image", { prompt: "resource" });
    const id = (made.json.images as unknown as { assetId: string }[])[0]!.assetId;
    const listed = await c.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain(`openfield://asset/${id}`);
    const read = await c.readResource({ uri: `openfield://asset/${id}` });
    expect(read.contents.map((content) => content.mimeType)).toEqual(["image/jpeg", "application/json"]);
  });
});

describe("spending and settings", () => {
  test("get_usage splits spend by app, and get_settings never shows a key", async () => {
    const { server: s, client: c } = await ready();
    await call(c, "generate_image", { prompt: "counted" });
    const usage = await call(c, "get_usage", { groupBy: "place" });
    expect(usage.json.groups).toMatchObject([{ place: "agent", agent: "Claude Code", usd: 0.134 }]);
    expect(usage.json.agentsToday).toEqual({ usd: 0.134, images: 1 });

    const settings = await call(c, "get_settings");
    expect(settings.text).not.toContain(TEST_KEY);
    expect(settings.text).not.toContain(s.services.agents.key!);
    expect(settings.json).toMatchObject({
      agents: { askBeforeSpendingAboveUsd: 0.5, dailyLimitUsd: 5 },
      companies: expect.arrayContaining([expect.objectContaining({ id: "google", hasKey: true, on: true })]),
    });
  });
});

describe("the stdio bridge", () => {
  const collect = () => {
    const answers: Answer[] = [];
    const answer = async (id: number) => {
      for (let i = 0; i < 300; i++) {
        const hit = answers.find((a) => a.id === id);
        if (hit) return hit;
        await Bun.sleep(10);
      }
      throw new Error(`No answer to ${id}`);
    };
    return { answers, answer, reply: async (m: unknown) => void answers.push(m as Answer) };
  };
  const hello = (id: number, name: string) => ({
    jsonrpc: "2.0" as const,
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
  });

  test("passes messages through, and connects again when Openfield's sessions are gone", async () => {
    server = await startTestServer();
    await saveKey(server);
    await turnOnAgents(server);
    const { answer, reply } = collect();
    const bridge = new Bridge(reply, { env: { OPENFIELD_HOME: server.home }, fetch: appFetch(server) });
    await bridge.receive(hello(1, "claude-ai"));
    expect((await answer(1)).result).toBeDefined();
    await bridge.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await bridge.receive({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await answer(2)).result?.tools?.length).toBeGreaterThan(10);

    // As after a restart: the session is gone. The next call still works.
    server.services.mcp.closeAll();
    await bridge.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_folders", arguments: {} },
    });
    expect((await answer(3)).result?.isError).toBeUndefined();
    const status = agentsStatusSchema.parse((await server.json("/api/agents")).body);
    expect(status.clients.map((c) => c.name)).toContain("Claude Desktop");
    await bridge.close();
  });

  test("says how to start Openfield when it isn't running, and never starts it", async () => {
    server = await startTestServer();
    await turnOnAgents(server);
    const { answers, reply } = collect();
    const down = () => Promise.reject(new TypeError("Unable to connect"));
    const bridge = new Bridge(reply, {
      env: { OPENFIELD_HOME: server.home },
      fetch: down,
      handshakeTimeoutMs: 20,
    });
    await bridge.receive(hello(1, "codex-mcp-client"));
    await bridge.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_folders" } });
    expect(answers[0]?.error?.message).toBe(notRunning());
    expect(answers[1]?.result).toMatchObject({ isError: true, content: [{ text: notRunning() }] });
    expect(notRunning()).toContain("bun start");
    // The failed reconnect's handshake timer mustn't go off later as an unhandled rejection.
    await Bun.sleep(60);
    await bridge.close();
  });

  test("with agents off, the bridge says so in plain words", async () => {
    server = await startTestServer();
    const { answers, reply } = collect();
    const bridge = new Bridge(reply, { env: { OPENFIELD_HOME: server.home }, fetch: appFetch(server) });
    await bridge.receive(hello(1, "claude-ai"));
    expect(answers[0]?.error?.message).toContain("Settings > Agents");
    // Turned on, then off again: Openfield itself says so.
    await turnOnAgents(server);
    await server.json("/api/agents", { method: "PUT", body: { enabled: false } });
    await bridge.receive(hello(2, "claude-ai"));
    expect(answers[1]?.error?.message).toContain("turned off");
    await bridge.close();
  });
});

describe("app names", () => {
  test("known apps get the name people know, others a tidy one", async () => {
    const { clientDisplayName } = await import("../src/mcp/names");
    expect(clientDisplayName("claude-code")).toBe("Claude Code");
    expect(clientDisplayName("claude-ai")).toBe("Claude Desktop");
    expect(clientDisplayName("cursor-vscode")).toBe("Cursor");
    expect(clientDisplayName("codex-mcp-client")).toBe("Codex");
    expect(clientDisplayName("my_agent-thing")).toBe("My Agent Thing");
    expect(clientDisplayName("\u0000")).toBe("An agent");
    expect(clientDisplayName(undefined)).toBe("An agent");
  });
});
