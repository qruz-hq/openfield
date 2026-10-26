import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getCanvas } from "@openfield/db";
import { libraryImages } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";

// export_canvas and import_canvas (docs/agents.md): an agent moves a canvas whole, with its images,
// through a file on this computer, and the person's tab opens an imported canvas fitted.

const servers: TestServer[] = [];
const clients: Client[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function ready() {
  const s = await startTestServer();
  servers.push(s);
  await saveKey(s);
  await turnOnAgents(s);
  // Exporting asks by default; these tests are about what it does once allowed.
  await s.json("/api/settings", {
    method: "PATCH",
    body: { agentPermissions: { export_canvases: "allow" } },
  });
  const c = await connectAgent(s);
  clients.push(c);
  return { s, c };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openfield-mcp-archive-"));
  scratch.push(dir);
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: tool answers are free-form JSON; each test checks what it needs.
type Json = Record<string, any>;
const j = (r: { json: unknown }) => r.json as Json;

/** A canvas with an Assets node showing two library images, built the way an agent would. */
async function boardWithImages(s: TestServer, c: Client) {
  const ids = await libraryImages(s, 2);
  const made = j(await call(c, "create_canvas", { name: "Mood board" }));
  const edited = await call(c, "edit_canvas", {
    canvas: made.canvasId,
    edits: [{ op: "add_node", type: "image.asset", params: { assetIds: ids } }],
  });
  expect(edited.isError).toBe(false);
  return { canvasId: made.canvasId as string, ids };
}

describe("export_canvas", () => {
  test("saves the archive into a folder under the canvas's name, never over another file", async () => {
    const { s, c } = await ready();
    const { canvasId } = await boardWithImages(s, c);
    const dir = tempDir();
    const first = j(await call(c, "export_canvas", { canvas: canvasId, path: dir }));
    expect(first).toMatchObject({
      finished: true,
      canvasId,
      name: "Mood board",
      path: join(dir, "Mood board.ofcanvas.zip"),
      images: 2,
    });
    expect(first.bytes).toBeGreaterThan(0);
    expect(first.missing).toBeUndefined();
    const second = j(await call(c, "export_canvas", { canvas: "Mood board", path: dir }));
    expect(second.path).toBe(join(dir, "Mood board 2.ofcanvas.zip"));
    // A file path without .zip gets the archive's extension; one that's taken is refused.
    const named = j(await call(c, "export_canvas", { canvas: canvasId, path: join(dir, "board") }));
    expect(named.path).toBe(join(dir, "board.ofcanvas.zip"));
    const taken = await call(c, "export_canvas", { canvas: canvasId, path: join(dir, "board.ofcanvas.zip") });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("There's already a file called board.ofcanvas.zip there.");
    expect(readdirSync(dir).sort()).toEqual(
      ["Mood board.ofcanvas.zip", "Mood board 2.ofcanvas.zip", "board.ofcanvas.zip"].sort(),
    );
    expect((await call(c, "export_canvas", { canvas: canvasId, path: "relative/out.zip" })).text).toContain(
      "isn't a full path",
    );
  });

  test("an answer that came back before the end hands over a job to wait on", async () => {
    const { s, c } = await ready();
    const { canvasId } = await boardWithImages(s, c);
    const path = join(tempDir(), "board.zip");
    const early = j(await call(c, "export_canvas", { canvas: canvasId, path, wait: 0 }));
    expect(early.finished).toBe(false);
    expect(early.note).toContain(early.job);
    const done = j(await call(c, "export_canvas", { job: early.job }));
    expect(done).toMatchObject({ finished: true, path, images: 2 });
    expect((await call(c, "export_canvas", { job: "01K6BQ8000000000000000NONE" })).text).toContain(
      "There's no export or import",
    );
  });
});

describe("import_canvas", () => {
  test("brings a canvas in with its images and opens it fitted in the person's tab", async () => {
    const one = await ready();
    const { canvasId, ids } = await boardWithImages(one.s, one.c);
    const path = join(tempDir(), "board.ofcanvas.zip");
    expect(j(await call(one.c, "export_canvas", { canvas: canvasId, path })).finished).toBe(true);

    const two = await ready();
    two.s.services.presence.connected("tab-0001-test");
    two.s.services.presence.report({
      tabId: "tab-0001-test",
      path: "/canvas",
      canvasId: null,
      selection: [],
      focused: true,
    });
    const result = j(await call(two.c, "import_canvas", { path, name: "Imported board", show: true }));
    expect(result).toMatchObject({
      finished: true,
      name: "Imported board",
      images: { imported: 2, reused: 0, missing: 0 },
      shown: true,
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].params.assetIds).toEqual(ids);
    expect(getCanvas(two.s.services.db, result.canvasId)!.folderId).toBe(result.folderId);
    const navigate = two.s.events.find((e) => e.event === "ui.navigate");
    expect(navigate?.data).toEqual({
      tabId: "tab-0001-test",
      to: { kind: "canvas", id: result.canvasId, fit: true },
    });
  });

  test("refuses what it can't read, in words the agent can pass on", async () => {
    const { c } = await ready();
    const dir = tempDir();
    const bad = join(dir, "bad.ofcanvas.json");
    writeFileSync(bad, "{}");
    expect((await call(c, "import_canvas", { path: bad })).text).toBe(
      "This isn't a canvas or a canvas export.",
    );
    expect((await call(c, "import_canvas", { path: "board.zip" })).text).toContain("isn't a full path");
    expect((await call(c, "import_canvas", {})).text).toContain("pass path");
    expect(existsSync(join(dir, "bad.ofcanvas.json"))).toBe(true);
  });
});
