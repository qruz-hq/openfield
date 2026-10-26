import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, type CDPSession, chromium, webkit } from "@playwright/test";
import { SESSION_HEADER } from "../../packages/core/src/constants.ts";
import { SEED_CANVAS_NAME } from "../../scripts/seed-canvas.ts";
import { type Counts, type FrameStats, installHelpers, type OpenStats, pageInit, readOpen } from "./page.ts";

// How smooth the canvas editor is on a big canvas: frame times (p50/p95), long tasks, React commits
// and DOM counts while it opens, pans and zooms at 100%, 40%, 20% and 10%, drags 30 cards and
// box-selects everything in view. Perf numbers are noisy, so this isn't part of CI: run it by hand
// against a library you don't mind it touching (it moves the view and undoes a drag), on an idle
// computer, and compare runs made on the same one.
//
//   bun run seed:canvas --home /tmp/bench           # a 1,000-node canvas
//   OPENFIELD_HOME=/tmp/bench OPENFIELD_FAKE_PROVIDERS=1 OPENFIELD_PORT=4431 bun start
//   bun run bench:canvas --port 4431                 # Chromium, then 4x slower CPU, then WebKit
//   bun run bench:canvas --url http://127.0.0.1:4431/canvas/<id> --browser webkit --only open,z0.1
//
// Chromium runs headless on the GPU at 60 fps. WebKit (the desktop app's engine) is held to 30 fps
// even headless and reports no long tasks, so read its frame times against 33 ms and its longest
// frame instead. The view the canvas was saved with is put back at the end.

const SCENARIOS = ["open", "z1", "z0.4", "z0.2", "z0.1", "sweep", "drag", "box", "openZoomedOut"] as const;
type Scenario = (typeof SCENARIOS)[number];

interface Run {
  browser: string;
  throttle: number;
  scenarios: Record<
    string,
    (FrameStats & { counts: Counts; before?: Counts }) | (OpenStats & { counts: Counts })
  >;
  profiles: Record<string, ProfileSummary>;
  tallies: Record<string, [string, number][]>;
}

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    port: { type: "string" },
    canvas: { type: "string" },
    browser: { type: "string", default: "chromium,webkit" },
    throttle: { type: "string", default: "1,4" },
    only: { type: "string" },
    out: { type: "string" },
    label: { type: "string", default: "" },
    profile: { type: "boolean", default: false },
    tally: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});

const only = values.only ? new Set(values.only.split(",")) : null;
const want = (s: Scenario) => !only || only.has(s);
const outFile = resolve(values.out ?? join(process.cwd(), `bench-canvas-${Date.now()}.json`));
const outDir = dirname(outFile);
mkdirSync(outDir, { recursive: true });

// Where the canvas is.

async function token(origin: string): Promise<string> {
  const html = await (await fetch(`${origin}/`)).text();
  const found = /<meta name="openfield-session" content="([^"]+)"/.exec(html)?.[1];
  if (!found) throw new Error(`${origin} doesn't look like Openfield`);
  return found;
}

async function call<T>(origin: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { [SESSION_HEADER]: await token(origin), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function target(): Promise<{ origin: string; id: string }> {
  if (values.url) {
    const url = new URL(values.url);
    return { origin: url.origin, id: url.pathname.split("/").pop()! };
  }
  if (!values.port) throw new Error("Say which canvas with --url, or --port (and --canvas)");
  const origin = `http://127.0.0.1:${values.port}`;
  if (values.canvas) return { origin, id: values.canvas };
  const list = await call<{ id: string; name: string }[]>(
    origin,
    "GET",
    `/api/canvases?q=${encodeURIComponent(SEED_CANVAS_NAME)}`,
  );
  const seeded = list.find((c) => c.name === SEED_CANVAS_NAME);
  if (!seeded) throw new Error("No seeded canvas there: run bun run seed:canvas, or pass --canvas");
  return { origin, id: seeded.id };
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
interface Detail {
  graph: { viewport: Viewport } & Record<string, unknown>;
  graphVersion: number;
}

/** Saves `viewport` as the canvas's view, so every run opens the same way. */
async function restoreView(origin: string, id: string, viewport: Viewport) {
  const now = await call<Detail>(origin, "GET", `/api/canvases/${id}`);
  await call(origin, "PATCH", `/api/canvases/${id}`, {
    graph: { ...now.graph, viewport },
    graphVersion: now.graphVersion,
  });
}

// CPU profiles (Chromium).

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}
interface ProfileSummary {
  totalMs: number;
  self: { fn: string; ms: number; pct: number }[];
  inclusive: { fn: string; ms: number; pct: number }[];
}

function summarize(profile: Profile): ProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n: ProfileNode) =>
    `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
  const selfById = new Map<number, number>();
  for (const [i, id] of profile.samples.entries()) {
    selfById.set(id, (selfById.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let total = 0;
  for (const [id, us] of selfById) {
    total += us;
    const key = label(byId.get(id)!);
    self.set(key, (self.get(key) ?? 0) + us);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const k = label(byId.get(at)!);
      if (seen.has(k) || k.startsWith("(root)")) continue;
      seen.add(k);
      inclusive.set(k, (inclusive.get(k) ?? 0) + us);
    }
  }
  const top = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([fn, us]) => ({ fn, ms: +(us / 1000).toFixed(1), pct: +((us / total) * 100).toFixed(1) }));
  return { totalMs: +(total / 1000).toFixed(1), self: top(self), inclusive: top(inclusive) };
}

// One browser, one CPU speed.

async function benchmark(browser: Browser, name: string, throttle: number, url: string): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(pageInit);
  const cdp: CDPSession | null = name === "chromium" ? await context.newCDPSession(page) : null;
  if (cdp && throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const run: Run = { browser: name, throttle, scenarios: {}, profiles: {}, tallies: {} };
  const tag = `${name}${throttle > 1 ? ` x${throttle}` : ""}`;
  const counts = () => page.evaluate(() => window.__benchHelpers.counts());
  const raf = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));

  async function open(label: string) {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    // Images, the engine's first pass and the first saves settle in this time.
    await page.waitForTimeout(4000);
    const stats = await page.evaluate(readOpen);
    if (!(await page.evaluate(installHelpers))) throw new Error("Couldn't reach the canvas's stores");
    run.scenarios[label] = { ...stats, counts: await counts() };
    console.log(`${tag} ${label}`, JSON.stringify(run.scenarios[label]));
  }

  async function measure(label: string, gesture: () => Promise<unknown>, extra: { before?: Counts } = {}) {
    if (cdp && values.profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp.send("Profiler.start");
    }
    if (values.tally) await page.evaluate(() => window.__benchHelpers.tally(true));
    await page.evaluate(() => window.__benchHelpers.start());
    await gesture();
    const stats = await page.evaluate(() => window.__benchHelpers.stop());
    if (values.tally) {
      const tally = (await page.evaluate(() => window.__benchHelpers.tally(false))) ?? {};
      run.tallies[label] = Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30);
    }
    if (cdp && values.profile) {
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: Profile };
      const file = join(outDir, `${values.label || "bench"}-${label}-${tag.replace(" ", "-")}.cpuprofile`);
      writeFileSync(file, JSON.stringify(profile));
      run.profiles[label] = summarize(profile);
    }
    run.scenarios[label] = { ...stats, ...extra, counts: await counts() };
    console.log(`${tag} ${label}`, JSON.stringify(stats));
  }

  if (want("open")) await open("open");
  else await open("open (warm-up)");

  for (const zoom of [1, 0.4, 0.2, 0.1]) {
    if (!want(`z${zoom}` as Scenario)) continue;
    const spot = await page.evaluate((z) => window.__benchHelpers.densest(z), zoom);
    await page.evaluate((a) => window.__benchHelpers.setView(a.cx, a.cy, a.zoom), { ...spot, zoom });
    await page.waitForTimeout(2500);
    const before = await counts();
    await measure(`pan ${zoom}`, () => page.evaluate(() => window.__benchHelpers.panLoop(180)), { before });
    await page.evaluate((a) => window.__benchHelpers.setView(a.cx, a.cy, a.zoom), { ...spot, zoom });
    await page.waitForTimeout(1500);
    await measure(`zoom ${zoom}`, () => page.evaluate((z) => window.__benchHelpers.zoomLoop(180, z), zoom));
  }

  if (want("sweep")) {
    const spot = await page.evaluate(() => window.__benchHelpers.densest(0.4));
    await page.evaluate((a) => window.__benchHelpers.setView(a.cx, a.cy, 1), spot);
    await page.waitForTimeout(2500);
    await measure("zoom 1 to 0.1 and back", () => page.evaluate(() => window.__benchHelpers.sweep(240)));
  }

  if (want("drag")) {
    const spot = await page.evaluate(() => window.__benchHelpers.densest(0.4));
    await page.evaluate((a) => window.__benchHelpers.setView(a.cx, a.cy, 0.4), spot);
    await page.waitForTimeout(2500);
    const pick = await page.evaluate(() => window.__benchHelpers.dragPick(30));
    await page.evaluate((ids) => window.__benchHelpers.select(ids), pick.ids);
    await page.waitForTimeout(500);
    await measure(`drag ${pick.ids.length} at 0.4`, async () => {
      await page.mouse.move(pick.x, pick.y);
      await page.mouse.down();
      for (let i = 1; i <= 120; i++) {
        await page.mouse.move(
          pick.x + 300 * Math.sin((i / 120) * Math.PI),
          pick.y + 120 * Math.sin((i / 60) * Math.PI),
        );
        await raf();
      }
      await page.mouse.up();
    });
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(800);
  }

  if (want("box")) {
    await page.evaluate(() => window.__benchHelpers.select([]));
    const zoom = await page.evaluate(() => window.__benchHelpers.fitAll());
    await page.waitForTimeout(2000);
    const label = `box-select all at ${zoom.toFixed(2)}`;
    await measure(label, async () => {
      await page.keyboard.down("Shift");
      await page.mouse.move(8, 100);
      await page.mouse.down();
      for (let i = 1; i <= 90; i++) {
        await page.mouse.move(8 + (1424 * i) / 90, 100 + (790 * i) / 90);
        await raf();
      }
      await page.mouse.up();
      await page.keyboard.up("Shift");
    });
    console.log(`${tag} selected ${await page.evaluate(() => window.__benchHelpers.selectedCount())}`);
    // Panning with everything selected, the usual next step.
    await measure(`pan ${zoom.toFixed(2)}, all selected`, () =>
      page.evaluate(() => window.__benchHelpers.panLoop(120)),
    );
    await page.evaluate(() => window.__benchHelpers.select([]));
  }

  if (want("openZoomedOut")) {
    // Leave the view zoomed all the way out long enough to be saved, then open again.
    await page.evaluate(() => window.__benchHelpers.fitAll());
    await page.waitForTimeout(4000);
    await open("open zoomed out");
  }
  await context.close();
  return run;
}

// Report

const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "-" : n.toFixed(digits);

function table(runs: Run[]): string {
  const lines = [
    "| Run | Scenario | p50 / p95 ms | fps | dropped | long tasks (total, longest ms) | commits | DOM / nodes / links / imgs |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const run of runs) {
    const name = `${run.browser}${run.throttle > 1 ? ` ${run.throttle}x` : ""}`;
    for (const [label, s] of Object.entries(run.scenarios)) {
      const c = s.counts;
      const dom = `${c.dom} / ${c.nodes} / ${c.edges} / ${c.images}`;
      if ("firstNode" in s) {
        lines.push(
          `| ${name} | ${label} | first node ${fmt(s.firstNode)}, images ${fmt(s.allImages)} | | longest frame ${s.longestFrame} | ${fmt(s.longTasks)} (${fmt(s.longTaskMs)}, ${fmt(s.longestTask)}) | | ${dom} |`,
        );
      } else {
        lines.push(
          `| ${name} | ${label} | ${s.p50} / ${s.p95} | ${s.fps} | ${s.dropped} | ${fmt(s.longTasks)} (${fmt(s.longTaskMs)}, ${fmt(s.longestTask)}) | ${s.commits} | ${dom} |`,
        );
      }
    }
  }
  return lines.join("\n");
}

const where = await target();
const url = `${where.origin}/canvas/${where.id}`;
const saved = (await call<Detail>(where.origin, "GET", `/api/canvases/${where.id}`)).graph.viewport;
const runs: Run[] = [];
const save = () =>
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        meta: { url, label: values.label, at: new Date().toISOString(), dpr: 2, viewport: "1440x900" },
        runs,
      },
      null,
      1,
    ),
  );
try {
  for (const name of values.browser.split(",")) {
    const engine = name === "webkit" ? webkit : chromium;
    const browser = await engine.launch({
      headless: !values.headed,
      // The GPU, as a person's browser has it, rather than software drawing.
      ...(name === "chromium" && {
        args: [
          ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
          "--enable-gpu",
          "--ignore-gpu-blocklist",
        ],
      }),
    });
    try {
      // Only Chromium can slow its CPU down.
      for (const throttle of name === "chromium" ? values.throttle.split(",").map(Number) : [1]) {
        runs.push(await benchmark(browser, name, throttle, url));
        save();
        await restoreView(where.origin, where.id, saved);
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await restoreView(where.origin, where.id, saved).catch(() => {});
}
console.log(`\n${table(runs)}\n\nWrote ${outFile}`);
