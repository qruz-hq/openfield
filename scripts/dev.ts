import { type FSWatcher, watch } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Subprocess } from "bun";
import { ServerSupervisor, type StopKind } from "./dev-supervisor";

// Runs the server and the Vite dev server together. Open the URL the server prints.
// The server proxies everything outside /api and /files to Vite, so the app has one origin in dev too.
//
// The server doesn't run under `bun --watch`, which kills it on every save: an image being made
// then is lost, because a Google call can't be picked up again. This script watches the server's
// sources itself and restarts it the way Ctrl-C stops it, once running images are saved (§0.16).
// When to restart is dev-supervisor.ts, which has its own tests; scripts/dev.test.ts runs this file.

const root = join(import.meta.dir, "..");
const posix = process.platform !== "win32";
// Beside the server's 4317, not Vite's usual 5173, so another Vite project never takes it.
// OPENFIELD_VITE_PORT moves it, so a test can run bun dev beside a developer's own.
const VITE_PORT = Number(process.env.OPENFIELD_VITE_PORT) || 4318;
/** After the last change, so a save that touches several files, or a formatter pass, restarts once. */
const DEBOUNCE_MS = 300;
/**
 * Everything the server imports. The web app and packages/ui have Vite's hot reload instead.
 * OPENFIELD_DEV_WATCH replaces the list, for tests that save a file in a folder of their own.
 */
const WATCHED = process.env.OPENFIELD_DEV_WATCH?.split(delimiter).filter(Boolean) ?? [
  "apps/server/src",
  "packages/core/src",
  "packages/providers/src",
  "packages/canvas/src",
  "packages/db/src",
  "packages/db/migrations",
];
const env = {
  ...process.env,
  OPENFIELD_DEV: "1",
  OPENFIELD_VITE_PORT: String(VITE_PORT),
  // Vite stops on its own if this script is killed without a chance to stop it (vite.config.ts).
  OPENFIELD_DEV_PARENT: String(process.pid),
};

/** Vite needs its own port (§0.16). Say so plainly instead of failing after the server's URL. */
function vitePortFree(): boolean {
  try {
    Bun.serve({ hostname: "127.0.0.1", port: VITE_PORT, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

if (!vitePortFree()) {
  console.error(
    `Port ${VITE_PORT} is in use, and bun dev needs it for the web app. Stop the other dev server using it, then try again.`,
  );
  process.exit(1);
}

// On macOS and Linux each child leads its own process group, so the terminal's Ctrl-C reaches only
// this script, and each stop is sent once, to the child alone. --silent drops bun's own "exited
// with code 143" line when Vite stops.
const spawn = (cmd: string[], workspace: string, ipc = false) =>
  Bun.spawn(cmd, {
    cwd: join(root, workspace),
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: posix,
    ...(ipc && { ipc: () => {}, serialization: "json" as const }),
  });

const vite = spawn(["bun", "run", "--silent", "dev"], "apps/web");

/** Signals one child, or with `group` everything it started. False once nothing is left. */
function signal(proc: Subprocess | null, sig: NodeJS.Signals | 0, group = false): boolean {
  if (!proc) return false;
  try {
    if (posix && group) process.kill(-proc.pid, sig);
    else if (proc.exitCode !== null || proc.signalCode !== null) return false;
    else process.kill(proc.pid, sig);
    return true;
  } catch {
    return false;
  }
}

// The server

let server: Subprocess | null = null;

/**
 * Asks the server to stop over its IPC channel, never with a signal: on Windows a signal kills the
 * process outright, and a restart must drain there too (§0.16). False when none is running.
 */
function ask(proc: Subprocess | null, kind: StopKind): boolean {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return false;
  try {
    proc.send({ openfield: kind });
    return true;
  } catch {
    return false;
  }
}

const supervisor = new ServerSupervisor({
  debounceMs: DEBOUNCE_MS,
  async start() {
    const proc = spawn(["bun", "src/index.ts"], "apps/server", true);
    server = proc;
    await proc.exited;
    server = null;
  },
  // A restart says it's finishing images before the restart instead of offering Ctrl-C, which
  // stops bun dev.
  stop: (kind) => ask(server, kind),
  alive: () => signal(server, 0),
  say: (line) => console.log(line),
});

// Watching

const watchers: FSWatcher[] = WATCHED.map((dir) => {
  // Recursive watching works on macOS, Linux and Windows in Bun.
  const watcher = watch(isAbsolute(dir) ? dir : join(root, dir), { recursive: true }, (_event, file) =>
    supervisor.changed(file),
  );
  // A folder that went away, say. Without a listener this would take bun dev down with it.
  watcher.on("error", (err) => {
    console.error(`Stopped watching ${dir} for changes (${err.message}). Restart bun dev to watch it again.`);
    watcher.close();
  });
  return watcher;
});

// Stopping bun dev

/** A second Ctrl-C counts only this long after the first: `bun run` passes on a copy within a few ms. */
const SECOND_SIGNAL_MS = 200;

let quitSince = 0;
let forced = false;
const bothGone = () => !signal(vite, 0, true) && !signal(server, 0, true);

let quitting = false;

async function quit(code: number): Promise<never> {
  quitting = true;
  for (const watcher of watchers) watcher.close();
  signal(vite, "SIGTERM");
  supervisor.quit();
  while (!bothGone()) await Bun.sleep(100);
  process.exit(forced ? 1 : code);
}

function onSignal() {
  if (quitSince) {
    // A second Ctrl-C means now. The copy `bun run` passes on from the first one doesn't.
    if (Date.now() - quitSince < SECOND_SIGNAL_MS || forced) return;
    forced = true;
    supervisor.stopNow();
    setTimeout(() => {
      for (const proc of [vite, server]) signal(proc, "SIGKILL", true);
      process.exit(1);
    }, 3_000);
    return;
  }
  quitSince = Date.now();
  void quit(0);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);

// If this script dies of an error, Vite goes with it. The server stops on its own, draining like
// Ctrl-C, once its IPC channel to this script closes, so no image is cut off.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
process.on("exit", () => {
  signal(vite, "SIGTERM", true);
});

// If Vite dies, take the server down too. A server that dies waits for the next change instead.
void supervisor.run();
await vite.exited;
if (!quitting) {
  quitSince = Date.now();
  await quit(1);
}
