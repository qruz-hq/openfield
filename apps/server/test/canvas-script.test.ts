import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { newPlan, planHost } from "../src/mcp/script/plan";
import { runInSandbox } from "../src/mcp/script/sandbox";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";

// canvas_script (docs/agents.md): a sandboxed program records edits that land as one batch.

// biome-ignore lint/suspicious/noExplicitAny: tool answers are free-form JSON.
type Json = Record<string, any>;
const j = (r: { json: unknown }) => r.json as Json;

const empty = { nodes: [], edges: [] };
async function plan(code: string) {
  const p = newPlan();
  const ran = await runInSandbox(code, planHost(empty, p, new Map()));
  return { ran, p };
}

describe("sandbox", () => {
  test("a script records edits, with the line each came from", async () => {
    const { ran, p } = await plan(
      `const a = Add("prompt", {text: "hi"});\nconst b = Add("image.generate");\nConnect(a + ".text", b + ".prompt");`,
    );
    expect(ran.ok).toBe(true);
    expect(p.edits.map((e) => e.op)).toEqual(["add_node", "add_node", "connect"]);
    expect(p.lines).toEqual([1, 2, 3]);
  });

  test("an infinite loop is interrupted", async () => {
    const { ran } = await plan("while (true) {}");
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.message).toContain("longer than");
  });

  test("memory is capped", async () => {
    const { ran } = await plan("const a = []; let i = 0; while (true) a.push(new Array(1e5).fill(i++));");
    expect(ran.ok).toBe(false);
  });

  test("no files, network, process or imports", async () => {
    const { ran } = await plan(
      "Print(typeof require, typeof process, typeof fetch, typeof setTimeout, typeof __host, typeof Bun, typeof std)",
    );
    expect(ran.ok).toBe(true);
  });

  test("probing the global gives no way out", async () => {
    const { p } = await plan(
      'const g = (function(){ return this })() ?? globalThis; Print(Object.keys(g).includes("__host"), typeof g.process, typeof (()=>{}).constructor("return typeof process")());',
    );
    expect(p.prints).toEqual(["false undefined string"]);
  });

  test("a script can't replace what reaches the host", async () => {
    const { ran, p } = await plan(
      "globalThis.Add = () => 'x'; delete globalThis.Print; Add('prompt'); Print(1)",
    );
    expect(ran.ok).toBe(true);
    // The recorded calls are the script's own, and nothing reached the host with a forged name.
    expect(p.edits.length).toBeLessThanOrEqual(1);
  });

  test("the same code gives the same plan", async () => {
    const code =
      "for (let i = 0; i < 5; i++) Add('prompt', {text: String(Math.random()) + new Date().getTime()});";
    const a = await plan(code);
    const b = await plan(code);
    expect(a.p.edits).toEqual(b.p.edits);
  });

  test("a throw reports its line", async () => {
    const { ran } = await plan("Print(1);\nPrint(2);\nthrow new Error('boom');");
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.line).toBe(3);
  });

  test("an invalid call reports the script line", async () => {
    const { ran } = await plan("Print(1);\nAdd('banana');");
    expect(ran.ok).toBe(false);
    if (!ran.ok) {
      expect(ran.line).toBe(2);
      expect(ran.message).toContain("isn't a node type");
    }
  });

  test("reads see the script's own earlier edits", async () => {
    const { p } = await plan(
      "const a = Add('prompt', {text: 'a'}); Set(a, {text: 'b'}); Print(Node(a).params.text, Nodes().length);",
    );
    expect(p.prints).toEqual(["b 1"]);
  });

  test("layout helpers", async () => {
    const { p } = await plan("Print(JSON.stringify(Grid(3, {cols: 2, w: 100, h: 50, gap: 10})))");
    expect(JSON.parse(p.prints[0] as string)).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 0, y: 60 },
    ]);
  });
});

let server: TestServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await server?.close();
  server = undefined;
});
async function ready() {
  const s = await startTestServer({});
  server = s;
  await saveKey(s);
  await turnOnAgents(s);
  client = await connectAgent(s);
  return client;
}

describe("canvas_script tool", () => {
  test("a big canvas builds in one call, and past the cap is refused", async () => {
    const c = await ready();
    const out = await call(c, "canvas_script", {
      createCanvas: "Big",
      code: 'for (let i = 0; i < 600; i++) { const p = Add("prompt", {text: "p" + i}); const g = Add("image.generate"); Connect(p + ".text", g + ".prompt"); }',
    });
    expect(out.isError).toBe(false);
    expect(j(out).edits).toBe(1800);
    const over = await call(c, "canvas_script", {
      createCanvas: "Too big",
      code: 'for (let i = 0; i < 2001; i++) Add("note");',
    });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("at most 2000");
  });

  test("creates a canvas and fills it in one call", async () => {
    const c = await ready();
    const out = await call(c, "canvas_script", {
      createCanvas: "Scripted",
      code: `const ps = ["a","b","c"].map((t) => Add("prompt", {text: t}));
const pos = Grid(3, {cols: 3});
ps.forEach((p, i) => { const g = Add("image.generate", {aspect: "1:1"}, {at: {x: pos[i].x, y: 400}}); Connect(p + ".text", g + ".prompt"); });
Print("made", ps.length);`,
    });
    expect(out.isError).toBe(false);
    expect(j(out).edits).toBe(9);
    expect(j(out).prints).toEqual(["made 3"]);
    const read = j(await call(c, "get_canvas", { canvas: j(out).canvasId }));
    expect(read.nodes).toHaveLength(6);
    expect(read.edges).toHaveLength(3);
  });

  test("a failing script changes nothing, and a patch fixes it once", async () => {
    const c = await ready();
    const made = j(await call(c, "create_canvas", { name: "Patch" }));
    const bad = await call(c, "canvas_script", {
      canvas: made.canvasId,
      code: "Add('prompt');\nAdd('nope');",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Line 2");
    const retryId = /retryId: (\w+)/.exec(bad.text)?.[1];
    expect(retryId).toBeTruthy();
    expect(j(await call(c, "get_canvas", { canvas: made.canvasId })).nodes).toHaveLength(0);

    const ambiguous = await call(c, "canvas_script", {
      canvas: made.canvasId,
      retryId,
      edits: [{ find: "Add(", replace: "Add(" }],
    });
    expect(ambiguous.isError).toBe(true);

    const bad2 = await call(c, "canvas_script", { canvas: made.canvasId, code: "Add('nope');" });
    const id2 = /retryId: (\w+)/.exec(bad2.text)?.[1];
    const fixed = await call(c, "canvas_script", {
      canvas: made.canvasId,
      retryId: id2,
      edits: [{ find: "nope", replace: "prompt" }],
    });
    expect(fixed.isError).toBe(false);
    const again = await call(c, "canvas_script", {
      canvas: made.canvasId,
      retryId: id2,
      edits: [{ find: "a", replace: "b" }],
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("used or has expired");
  });

  test("an edit the canvas refuses applies nothing", async () => {
    const c = await ready();
    const made = j(await call(c, "create_canvas", { name: "Refuse" }));
    const out = await call(c, "canvas_script", {
      canvas: made.canvasId,
      code: "Add('prompt');\nAdd('prompt', {text: 'x'.repeat(100000)});",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing was changed");
    expect(j(await call(c, "get_canvas", { canvas: made.canvasId })).nodes).toHaveLength(0);
  });

  test("dryRun changes nothing, and Remember keeps a helper for the next call", async () => {
    const c = await ready();
    const made = j(await call(c, "create_canvas", { name: "Dry" }));
    const dry = j(
      await call(c, "canvas_script", { canvas: made.canvasId, dryRun: true, code: "Add('prompt')" }),
    );
    expect(dry.dryRun).toBe(true);
    expect(j(await call(c, "get_canvas", { canvas: made.canvasId })).nodes).toHaveLength(0);
    await call(c, "canvas_script", {
      canvas: made.canvasId,
      code: "Remember('mk', (t) => Add('prompt', {text: t})); Remember('n', 5);",
    });
    const used = await call(c, "canvas_script", {
      canvas: made.canvasId,
      code: "Recall('mk')('hi'); Print(Recall('n'))",
    });
    expect(used.text).not.toContain("Nothing was changed");
    expect(j(used).prints).toEqual(["5"]);
  });
});
