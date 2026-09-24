import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JobSetAccepted, type JobSetsListResponse, newId, SESSION_HEADER } from "@openfield/core";

// The real server process (§0.12, §8.4.6 acceptance d to f): Ctrl-C, a second Ctrl-C, SIGTERM,
// SIGHUP and SIGKILL in the middle of an image, then a fresh start on the same library. Most tests
// run src/index.ts directly; one goes through the root `bun start`, the way a person runs it, so a
// wrapper that exits on Ctrl-C and leaves the server draining out of sight can't come back. Fake
// models only, with keys from the environment, so nothing leaves this computer.

const ROOT = join(import.meta.dir, "../../..");
const ENTRY = join(import.meta.dir, "../src/index.ts");
const SLOW_PROMPT = "#fake:slow a lighthouse at dusk";
const GOOGLE_KEY = "AIzaProcessTestKey-0123456789abcdefgh";
const FAKE_KEY = "fake-process-test-key";

interface Running {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  token: string;
  /** Everything it printed so far, stdout and stderr. */
  out(): string;
  /** Leads its own process group (`bun start`): the wrapper and the server it runs. */
  group: boolean;
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("No free port");
  return port;
}

/** The developer's environment minus anything Openfield reads, so their keys and home stay out. */
function cleanEnv(): Record<string, string> {
  const skip = new Set(["GOOGLE_API_KEY", "GEMINI_API_KEY", "NODE_ENV"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("OPENFIELD_") && !skip.has(entry[0]),
    ),
  );
}

interface LaunchOptions {
  env?: Record<string, string>;
  /** Through the root package.json's `bun start`, leading its own process group like a terminal job. */
  viaBunStart?: boolean;
}

function spawnServer(home: string, port: number, opts: LaunchOptions = {}) {
  const proc = Bun.spawn(opts.viaBunStart ? [process.execPath, "run", "start"] : [process.execPath, ENTRY], {
    cwd: opts.viaBunStart ? ROOT : undefined,
    env: {
      ...cleanEnv(),
      NODE_ENV: "production",
      OPENFIELD_HOME: home,
      OPENFIELD_PORT: String(port),
      OPENFIELD_FAKE_PROVIDERS: "1",
      OPENFIELD_GOOGLE_API_KEY: GOOGLE_KEY,
      OPENFIELD_FAKE_API_KEY: FAKE_KEY,
      // Not built: the server answers with its placeholder page, which still carries the token.
      OPENFIELD_WEB_DIST: join(home, "no-web-app"),
      ...opts.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: opts.viaBunStart === true,
  });
  let text = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  };
  const done = Promise.all([
    collect(proc.stdout as ReadableStream<Uint8Array>),
    collect(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  return { proc, out: () => text, done };
}

async function launch(home: string, port: number, opts: LaunchOptions = {}): Promise<Running> {
  const { proc, out } = spawnServer(home, port, opts);
  const until = Date.now() + 15_000;
  for (;;) {
    const text = out();
    if (proc.exitCode !== null) throw new Error(`The server exited while starting:\n${text}`);
    const html = await fetch(`http://127.0.0.1:${port}/`)
      .then((res) => res.text())
      .catch(() => "");
    const token = /<meta name="openfield-session" content="([^"]+)"/.exec(html)?.[1];
    if (token) return { proc, port, token, out, group: opts.viaBunStart === true };
    if (Date.now() > until) throw new Error(`The server didn't start:\n${text}`);
    await Bun.sleep(50);
  }
}

async function api<T>(s: Running, path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { [SESSION_HEADER]: s.token, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const generate = (s: Running, overrides: Record<string, unknown>) =>
  api<JobSetAccepted>(s, "/api/generate", {
    idempotencyKey: newId(),
    model: "google:gemini-3.1-flash-image",
    op: "generate",
    prompt: "a lighthouse at dusk",
    size: { kind: "aspect", ratio: "3:4" },
    batch: 1,
    source: "composer",
    ...overrides,
  });

async function jobOf(s: Running, jobSetId: string) {
  const list = await api<JobSetsListResponse>(s, "/api/job-sets?status=all");
  return list.items.find((i) => i.jobSet.id === jobSetId)?.jobs[0];
}

/** One query against the library's database, from outside the server. */
function query<T>(home: string, sql: string): T[] {
  const db = new Database(join(home, "openfield.db"));
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

async function eventually<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error("Timed out waiting");
    await Bun.sleep(50);
  }
}

const inFlight = (s: Running, jobSetId: string) =>
  eventually(async () => {
    const job = await jobOf(s, jobSetId);
    return job && (job.status === "submitting" || job.status === "running") ? job : undefined;
  });

const succeeded = (s: Running, jobSetId: string) =>
  eventually(async () => {
    const job = await jobOf(s, jobSetId);
    return job?.status === "succeeded" ? job : undefined;
  });

/** No key, in any file of the library folder: logs, job log, database, config (§6.11). */
function expectNoKeys(home: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(home);
  expect(files.some((f) => f.endsWith("jobs.ndjson"))).toBe(true);
  for (const file of files) {
    const text = readFileSync(file).toString("latin1");
    for (const key of [GOOGLE_KEY, FAKE_KEY]) {
      if (text.includes(key)) throw new Error(`${file} holds a key`);
    }
  }
  const handles = query<{ handle: string | null }>(home, "SELECT handle FROM jobs");
  expect(JSON.stringify(handles)).not.toContain(FAKE_KEY);
}

/** Holds a port, the way another Openfield or any other app would. */
function holdPort(port: number) {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("someone else") });
}

describe("the server process", () => {
  let home: string;
  let port: number;
  let running: Running | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openfield-process-"));
    port = freePort();
  });

  afterEach(async () => {
    if (running?.group) {
      // The whole job, so a server a wrapper left behind (it shouldn't) doesn't outlive the test.
      try {
        process.kill(-running.proc.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    } else if (running && running.proc.exitCode === null) {
      running.proc.kill("SIGKILL");
    }
    await running?.proc.exited;
    running = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  test("Ctrl-C waits for a running image, saves it, and exits 0", async () => {
    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "1500" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);

    running.proc.kill("SIGINT");
    expect(await running.proc.exited).toBe(0);
    expect(running.out()).toContain("Finishing 1 image. Press Ctrl-C again to stop now.");
    expect(running.out()).toContain("Openfield stopped.");
    expect(query(home, "SELECT status FROM jobs")).toEqual([{ status: "succeeded" }]);
    expect(query(home, "SELECT count(*) AS n FROM assets")).toEqual([{ n: 1 }]);
  }, 30_000);

  test("a second Ctrl-C stops at once, and the next start runs the image again, once", async () => {
    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "60000" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);

    running.proc.kill("SIGINT");
    await eventually(() => running!.out().includes("Finishing 1 image."));
    // A copy right after the first doesn't count (`bun run` passes one on), so wait past that.
    await Bun.sleep(300);
    const t0 = Date.now();
    running.proc.kill("SIGINT");
    expect(await running.proc.exited).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(running.out()).toContain("Stopped. 1 image will run again when Openfield starts.");

    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "0" } });
    expect(running.out()).toContain("Running 1 image again.");
    const job = await succeeded(running, run.jobSet.id);
    expect(job.rerunAt).not.toBeNull();
    expect(query(home, "SELECT outcome, rerun FROM usage_log")).toEqual([{ outcome: "succeeded", rerun: 1 }]);
  }, 30_000);

  test("killed mid-call, the next start runs a Google image again, once", async () => {
    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "60000" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);
    running.proc.kill("SIGKILL");
    await running.proc.exited;

    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "0" } });
    const job = await succeeded(running, run.jobSet.id);
    expect(job).toMatchObject({ attempt: 1, resumedAt: null });
    expect(job.rerunAt).not.toBeNull();
    expect(query(home, "SELECT count(*) AS n FROM assets")).toEqual([{ n: 1 }]);
    expect(query(home, "SELECT outcome, rerun FROM usage_log")).toEqual([{ outcome: "succeeded", rerun: 1 }]);
    expectNoKeys(home);
  }, 30_000);

  test("`bun start`: Ctrl-C to the whole terminal job waits for the image, says so, and exits 0", async () => {
    running = await launch(home, port, { viaBunStart: true, env: { OPENFIELD_FAKE_SLOW_MS: "1500" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);

    // A terminal's Ctrl-C goes to every process in the foreground job: the wrapper and the server.
    process.kill(-running.proc.pid, "SIGINT");
    expect(await running.proc.exited).toBe(0);
    expect(running.out()).toContain("Finishing 1 image. Press Ctrl-C again to stop now.");
    expect(running.out()).toContain("Openfield stopped.");
    expect(query(home, "SELECT status FROM jobs")).toEqual([{ status: "succeeded" }]);
    // The library is free at once: nothing is still draining in the background.
    running = await launch(home, port, { viaBunStart: true });
  }, 30_000);

  test("`bun start`: SIGTERM to the wrapper alone, as a process manager sends it, drains the server too", async () => {
    running = await launch(home, port, { viaBunStart: true, env: { OPENFIELD_FAKE_SLOW_MS: "1500" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);

    running.proc.kill("SIGTERM");
    expect(await running.proc.exited).toBe(0);
    expect(running.out()).toContain("Openfield stopped.");
    expect(query(home, "SELECT status FROM jobs")).toEqual([{ status: "succeeded" }]);
  }, 30_000);

  test("a closed terminal (SIGHUP) drains like Ctrl-C instead of cutting the image off", async () => {
    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "1500" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);

    running.proc.kill("SIGHUP");
    expect(await running.proc.exited).toBe(0);
    expect(query(home, "SELECT status, rerun_at FROM jobs")).toEqual([
      { status: "succeeded", rerun_at: null },
    ]);
  }, 30_000);

  test("a start that can't get its port sends nothing, and the next start runs the image again, once", async () => {
    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "60000" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);
    running.proc.kill("SIGKILL");
    await running.proc.exited;
    running = undefined;

    const other = holdPort(port);
    try {
      const failed = spawnServer(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "0" } });
      expect(await failed.proc.exited).toBe(1);
      await failed.done;
      expect(failed.out()).toContain(`Port ${port} is already in use.`);
    } finally {
      other.stop(true);
    }
    // Nothing went out: the rerun waits, never sent, with its one chance unspent.
    expect(query(home, "SELECT status, attempt, rerun_at IS NOT NULL AS rerun FROM jobs")).toEqual([
      { status: "pending", attempt: 0, rerun: 1 },
    ]);
    expect(query(home, "SELECT count(*) AS n FROM usage_log")).toEqual([{ n: 0 }]);

    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "0" } });
    expect(running.out()).toContain("Running 1 image again.");
    const job = await succeeded(running, run.jobSet.id);
    expect(job).toMatchObject({ attempt: 1 });
    expect(query(home, "SELECT outcome, rerun FROM usage_log")).toEqual([{ outcome: "succeeded", rerun: 1 }]);
  }, 30_000);

  test("a stop while a resumable create is out says what it waits for, and the log keeps the story", async () => {
    running = await launch(home, port);
    const run = await generate(running, { model: "fake:resumable-image" });
    // The fake company takes about a second to answer the create.
    await eventually(async () =>
      (await jobOf(running!, run.jobSet.id))?.status === "submitting" ? true : undefined,
    );
    running.proc.kill("SIGINT");
    expect(await running.proc.exited).toBe(0);
    const lines = [
      "Waiting for Test company to confirm 1 image. Press Ctrl-C again to stop now.",
      "1 image will pick up where it left off next time.",
      "Openfield stopped.",
    ];
    for (const line of lines) expect(running.out()).toContain(line);
    // The same lines in logs/openfield.log, and one record of the stop in the job log.
    const logged = readFileSync(join(home, "logs", "openfield.log"), "utf8");
    for (const line of lines) expect(logged).toContain(JSON.stringify(line));
    const events = readFileSync(join(home, "logs", "jobs.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.findLast((e) => e.event === "server.stopped")).toMatchObject({
      forced: false,
      left: 1,
      cut: { rerun: 0, interrupted: 0 },
    });
    expect(query(home, "SELECT handle IS NOT NULL AS stored FROM jobs")).toEqual([{ stored: 1 }]);
  }, 30_000);

  test("a stop while the boot tidies up finished batches doesn't crash, and the running image is saved", async () => {
    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "4000" } });
    const speed = (value: string) =>
      api(running!, "/api/providers/google/settings", { values: { speed: value } }, "PATCH");
    await speed("batch");
    const batches = await Promise.all([1, 2, 3].map((i) => generate(running!, { prompt: `batch ${i}` })));
    for (const run of batches) await succeeded(running, run.jobSet.id);
    await speed("standard");
    running.proc.kill("SIGTERM");
    expect(await running.proc.exited).toBe(0);
    // Left for the next start to tidy up at Google, as a stop at the wrong moment leaves them.
    query(home, "UPDATE provider_batches SET cleaned_at = NULL");

    running = await launch(home, port, { env: { OPENFIELD_FAKE_SLOW_MS: "4000" } });
    const run = await generate(running, { prompt: SLOW_PROMPT });
    await inFlight(running, run.jobSet.id);
    // The boot's cleanup calls are still going out, one batch after another.
    await Bun.sleep(1_000);
    running.proc.kill("SIGINT");
    expect(await running.proc.exited).toBe(0);
    expect(running.out()).not.toContain("Error");
    expect(query(home, `SELECT status FROM jobs WHERE job_set_id = '${run.jobSet.id}'`)).toEqual([
      { status: "succeeded" },
    ]);
  }, 60_000);

  test("killed mid-call to the resumable model, the next start picks it up by the same id", async () => {
    running = await launch(home, port);
    const run = await generate(running, { model: "fake:resumable-image" });
    const sent = await eventually(
      () =>
        query<{ ref: string }>(home, "SELECT provider_job_id AS ref FROM jobs WHERE handle IS NOT NULL")[0]
          ?.ref,
    );
    running.proc.kill("SIGKILL");
    await running.proc.exited;

    running = await launch(home, port);
    // A plain line, like the stop's, not a log record with its level.
    expect(running.out()).toContain("\nPicking up 1 image where it left off.");
    expect(running.out()).not.toContain("info  Picking up");
    const job = await succeeded(running, run.jobSet.id);
    expect(job).toMatchObject({ attempt: 1, rerunAt: null });
    expect(job.resumedAt).not.toBeNull();
    // The same call at the company, not a second one.
    expect(query(home, "SELECT provider_job_id AS ref, resumable FROM jobs")).toEqual([
      { ref: sent, resumable: 1 },
    ]);
    expect(query(home, "SELECT outcome, rerun FROM usage_log")).toEqual([{ outcome: "succeeded", rerun: 0 }]);
    expectNoKeys(home);
  }, 30_000);
});
