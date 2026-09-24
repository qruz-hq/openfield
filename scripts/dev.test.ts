import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `bun dev` itself (§0.16): the real scripts/dev.ts, with the real Vite and server, on ports of its
// own and watching a scratch folder, so it runs beside a developer's own bun dev. dev-supervisor's
// tests cover when it restarts; these cover how: the message to the server, the drain before a
// restart, and what happens to both children when bun dev goes away. Fake models only.

const ROOT = join(import.meta.dir, "..");
/** From @openfield/core, which scripts/ can't import. */
const SESSION_HEADER = "X-Openfield-Session";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID, for the idempotency key. */
function newId(): string {
  let time = "";
  for (let t = Date.now(), i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => CROCKFORD[b % 32]).join("");
  return time + random;
}

interface Dev {
  proc: ReturnType<typeof Bun.spawn>;
  home: string;
  watched: string;
  port: number;
  vitePort: number;
  out(): string;
}

let dev: Dev | undefined;

afterEach(async () => {
  if (dev) {
    if (dev.proc.exitCode === null) dev.proc.kill("SIGKILL");
    await dev.proc.exited;
    // Anything it left behind stops once it notices bun dev is gone; give it that moment.
    await eventually(() => portFree(dev!.port) && portFree(dev!.vitePort), 10_000).catch(() => {});
    rmSync(dev.home, { recursive: true, force: true });
    rmSync(dev.watched, { recursive: true, force: true });
  }
  dev = undefined;
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("No free port");
  return port;
}

function portFree(port: number): boolean {
  try {
    Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting.\n${dev?.out() ?? ""}`);
    await Bun.sleep(100);
  }
}

function startDev(extraEnv: Record<string, string> = {}): Dev {
  const home = mkdtempSync(join(tmpdir(), "openfield-dev-"));
  const watched = mkdtempSync(join(tmpdir(), "openfield-dev-watch-"));
  const port = freePort();
  const vitePort = freePort();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("OPENFIELD_") && !/API_KEY$|^NODE_ENV$/.test(entry[0]),
    ),
  );
  const proc = Bun.spawn([process.execPath, "scripts/dev.ts"], {
    cwd: ROOT,
    env: {
      ...env,
      OPENFIELD_HOME: home,
      OPENFIELD_PORT: String(port),
      OPENFIELD_VITE_PORT: String(vitePort),
      OPENFIELD_DEV_WATCH: watched,
      OPENFIELD_FAKE_PROVIDERS: "1",
      OPENFIELD_GOOGLE_API_KEY: "AIzaDevTestKey-0123456789abcdefghij",
      OPENFIELD_FAKE_API_KEY: "fake-dev-test-key",
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let text = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);
  return { proc, home, watched, port, vitePort, out: () => text };
}

/** The session token in the page the server proxies from Vite, once both are up. */
async function token(d: Dev): Promise<string | undefined> {
  const html = await fetch(`http://127.0.0.1:${d.port}/`)
    .then((res) => res.text())
    .catch(() => "");
  return /<meta name="openfield-session" content="([^"]+)"/.exec(html)?.[1];
}

async function generate(d: Dev, session: string, overrides: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/generate`, {
    method: "POST",
    headers: { [SESSION_HEADER]: session, "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: newId(),
      model: "google:gemini-3.1-flash-image",
      op: "generate",
      prompt: "a lighthouse at dusk",
      size: { kind: "aspect", ratio: "1:1" },
      batch: 1,
      source: "composer",
      ...overrides,
    }),
  });
  if (res.status !== 202) throw new Error(`generate answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as { jobSet: { id: string } };
}

function jobs(d: Dev) {
  const db = new Database(join(d.home, "openfield.db"));
  try {
    return db
      .query<{ set: string; status: string; handle: number; resumed: number; rerun: number }, []>(
        `SELECT job_set_id AS "set", status, handle IS NOT NULL AS handle,
                resumed_at IS NOT NULL AS resumed, rerun_at IS NOT NULL AS rerun FROM jobs`,
      )
      .all();
  } finally {
    db.close();
  }
}

test("a save restarts the server once the running image is saved, and Ctrl-C then stops both", async () => {
  dev = startDev({ OPENFIELD_FAKE_SLOW_MS: "3000" });
  const first = await eventually(() => token(dev!), 30_000);
  const google = await generate(dev, first, { prompt: "#fake:slow a lighthouse" });
  const resumable = await generate(dev, first, { model: "fake:resumable-image" });
  await eventually(() => {
    const rows = jobs(dev!);
    const of = (id: string) => rows.find((r) => r.set === id);
    return of(google.jobSet.id)?.status === "submitting" && of(resumable.jobSet.id)?.handle === 1;
  });

  // A few saves close together: one restart.
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(dev.watched, "saved.ts"), `export const saved = ${i};\n`);
    await Bun.sleep(50);
  }
  await eventually(() => dev!.out().includes("Restarting the server."));
  await eventually(() =>
    dev!.out().includes("Finishing 1 image before restarting. The app is back after that."),
  );
  const second = await eventually(async () => {
    const next = await token(dev!);
    return next && next !== first ? next : undefined;
  }, 30_000);
  expect(second).toBeTruthy();
  expect(dev.out().match(/Restarting the server\./g)).toHaveLength(1);
  expect(dev.out()).toContain("1 image will pick up where it left off next time.");

  // The Google image was saved before the restart, not run again after it, and the resumable one
  // was picked up by its id.
  await eventually(() => jobs(dev!).every((r) => r.status === "succeeded"), 30_000);
  const rows = jobs(dev);
  expect(rows.find((r) => r.set === google.jobSet.id)).toMatchObject({ rerun: 0, resumed: 0 });
  expect(rows.find((r) => r.set === resumable.jobSet.id)).toMatchObject({ rerun: 0, resumed: 1 });

  dev.proc.kill("SIGINT");
  expect(await dev.proc.exited).toBe(0);
  expect(dev.out()).toContain("Openfield stopped.");
  expect(portFree(dev.port)).toBe(true);
  expect(portFree(dev.vitePort)).toBe(true);
}, 120_000);

test("killed without a chance to stop them, bun dev's server and Vite still stop, and free their ports", async () => {
  dev = startDev();
  await eventually(() => token(dev!), 30_000);
  dev.proc.kill("SIGKILL");
  await dev.proc.exited;
  // The server stops when its channel to bun dev closes, and Vite when it sees bun dev gone.
  await eventually(() => portFree(dev!.port) && portFree(dev!.vitePort), 10_000);
}, 60_000);
