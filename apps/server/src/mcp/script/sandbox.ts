import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";

// Runs an agent's script in QuickJS compiled to WebAssembly: no files, network, timers or imports.
// The only way out is one host function that takes and returns JSON text, so nothing the script
// does can reach the host's objects. Same code on the same snapshot gives the same plan: Math.random
// is seeded and Date is frozen.

export const LIMITS = { cpuMs: 3000, memoryBytes: 64 * 1024 * 1024, stackBytes: 1024 * 1024 } as const;

/** What the sandbox shows the script, defined inside it. Closes over the host function and drops it. */
const PRELUDE = `(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const lineOf = () => {
    const m = /script\\.js:(\\d+)/.exec(new Error().stack || "");
    return m ? Number(m[1]) : 0;
  };
  const call = (name, ...args) => {
    const out = host(name, JSON.stringify(args), lineOf());
    const res = out === undefined ? undefined : JSON.parse(out);
    if (res && res.__error) throw new Error(res.__error);
    return res;
  };
  let seed = 0x9e3779b9;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { a.length ? super(...a) : super(0); }
    static now() { return 0; }
  };
  const def = (name, fn) => Object.defineProperty(globalThis, name, { value: fn, enumerable: true });
  def("Print", (...v) => call("print", [v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")]));
  def("Nodes", (filter) => call("nodes", filter));
  def("Node", (id) => call("node", id));
  def("Edges", () => call("edges"));
  def("NodeTypes", () => call("nodeTypes"));
  def("Add", (type, params, opts) => call("add", type, params, opts));
  def("Set", (id, params, opts) => call("set", id, params, opts));
  def("Move", (id, to, opts) => call("move", id, to, opts));
  def("Remove", (...ids) => call("remove", ids.flat()));
  def("Connect", (from, to, kind) => call("connect", from, to, kind));
  def("Disconnect", (from, to) => call("disconnect", from, to));
  def("Rename", (name) => call("rename", name));
  def("Remember", (name, value) => call("remember", name, typeof value === "function" ? { fn: String(value) } : { value }));
  def("Recall", (name) => {
    const r = call("recall", name);
    if (r && r.fn) return (0, eval)("(" + r.fn + ")");
    return r ? r.value : undefined;
  });
  // Layout: top-left corners for n things of a given size, in canvas coordinates.
  const cells = (n, o) => Array.from({ length: n }, (_, i) => o(i));
  def("Grid", (n, o = {}) => {
    const { cols = 4, x = 0, y = 0, w = 360, h = 360, gap = 40 } = o;
    return cells(n, (i) => ({ x: x + (i % cols) * (w + gap), y: y + Math.floor(i / cols) * (h + gap) }));
  });
  def("Row", (n, o = {}) => Grid(n, { ...o, cols: Math.max(1, n) }));
  def("Column", (n, o = {}) => Grid(n, { ...o, cols: 1 }));
})()`;

export type Host = (name: string, args: unknown[], line: number) => unknown;

export type SandboxResult = { ok: true } | { ok: false; message: string; line?: number };

function lineFrom(stack: unknown): number | undefined {
  const m = /script\.js:(\d+)/.exec(typeof stack === "string" ? stack : "");
  return m ? Number(m[1]) : undefined;
}

function describe(context: QuickJSContext, error: unknown): { message: string; line?: number } {
  const dumped = context.dump(error as never) as { name?: string; message?: string; stack?: string } | string;
  if (typeof dumped === "string") return { message: dumped };
  const line = lineFrom(dumped.stack);
  const message = `${dumped.name && dumped.name !== "Error" ? `${dumped.name}: ` : ""}${dumped.message ?? "Script failed."}`;
  return { message, ...(line !== undefined && { line }) };
}

export async function runInSandbox(code: string, host: Host): Promise<SandboxResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(LIMITS.stackBytes);
  const deadline = Date.now() + LIMITS.cpuMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() <= deadline) return false;
    timedOut = true;
    return true;
  });
  const context = runtime.newContext();
  try {
    const bridge = context.newFunction("__host", (nameH, argsH, lineH) => {
      const name = context.getString(nameH);
      let result: unknown;
      try {
        const args = JSON.parse(context.getString(argsH)) as unknown[];
        result = host(name, args, context.getNumber(lineH));
      } catch (error) {
        result = { __error: error instanceof Error ? error.message : String(error) };
      }
      return result === undefined ? context.undefined : context.newString(JSON.stringify(result));
    });
    context.setProp(context.global, "__host", bridge);
    bridge.dispose();
    context.unwrapResult(context.evalCode(PRELUDE, "prelude.js")).dispose();
    const out = context.evalCode(code, "script.js");
    if (out.error) {
      const failure = timedOut
        ? { message: `The script ran longer than ${LIMITS.cpuMs / 1000} seconds and was stopped.` }
        : describe(context, out.error);
      out.error.dispose();
      return { ok: false, ...failure };
    }
    out.value.dispose();
    return { ok: true };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
