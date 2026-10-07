import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { saveKey, startTestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";

// Not a test: `bun apps/server/test/bench-canvas.bench.ts` times canvas building through /mcp.
// biome-ignore lint/suspicious/noExplicitAny: free-form tool answers.
type Json = Record<string, any>;

const server = await startTestServer({});
await saveKey(server);
await turnOnAgents(server);
const c: Client = await connectAgent(server);

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(34)} ${(performance.now() - t).toFixed(0)} ms`);
  return r;
}

const N = Number(process.env.NODES ?? 30);
const made = (await call(c, "create_canvas", { name: "Bench" })).json as Json;
const canvas = made.canvasId as string;

const edits: Json[] = [];
for (let i = 0; i < N; i++) {
  edits.push({ op: "add_node", as: `p${i}`, type: "prompt", params: { text: `Prompt ${i}` } });
  edits.push({ op: "add_node", as: `g${i}`, type: "image.generate", params: { aspect: "1:1" } });
  edits.push({ connect: `p${i}.text`, to: `g${i}.prompt` });
}
await time(`one batch (${N} prompt+generate)`, () => call(c, "edit_canvas", { canvas, edits }));
const next = await call(c, "get_canvas", { canvas });
await time("get_canvas (big canvas)", () => call(c, "get_canvas", { canvas }));
const ids = ((next.json as Json).nodes as Json[]).map((n) => n.id as string);
await time("1 tiny update on big canvas", () =>
  call(c, "update_node", { canvas, id: ids[0], params: { text: "x" } }),
);
await time("5 tiny updates on big canvas", async () => {
  for (let i = 0; i < 5; i++)
    await call(c, "update_node", { canvas, id: ids[i * 2], params: { text: `y${i}` } });
});
const small = (await call(c, "create_canvas", { name: "Small" })).json as Json;
await time("1 add_node on empty canvas", () =>
  call(c, "add_nodes", { canvas: small.canvasId, nodes: [{ type: "prompt" }] }),
);
// Same job as a script: what the model would write, and what it costs the server.
const code = `for (let i = 0; i < ${N}; i++) {
  const p = Add("prompt", { text: "Prompt " + i });
  const g = Add("image.generate", { aspect: "1:1" });
  Connect(p + ".text", g + ".prompt");
}`;
const sc = (await call(c, "canvas_script", { createCanvas: "Script bench", code })).json as Json;
await time(`canvas_script (${N} prompt+generate)`, async () =>
  call(c, "canvas_script", { createCanvas: "Script bench 2", code }),
);
const approx = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);
console.log(
  `\nmodel output, about tokens: edit_canvas ${approx({ canvas, edits })}, canvas_script ${approx({ createCanvas: "x", code })}`,
);
console.log(`reply, about tokens: script ${approx(sc)}`);
await c.close();
await server.close();
