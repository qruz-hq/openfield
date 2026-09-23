import { join } from "node:path";

// Runs the server and the Vite dev server together. Open the URL the server prints.
// The server proxies everything outside /api and /files to Vite, so the app has one origin in dev too.

const root = join(import.meta.dir, "..");
const env = { ...process.env, OPENFIELD_DEV: "1" };
const posix = process.platform !== "win32";
// Beside the server's 4317, not Vite's usual 5173, so another Vite project never takes it.
const VITE_PORT = 4318;

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

// Each child leads its own process group, so the terminal's Ctrl-C reaches only this script.
// A stop is then sent to each child alone: `bun run` passes it on to what it started, and a
// second copy would make the server skip its graceful shutdown. --silent drops bun's own
// "exited with code 143" line when Vite stops on that signal.
const start = (workspace: string) =>
  Bun.spawn(["bun", "run", "--silent", "dev"], {
    cwd: join(root, workspace),
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: posix,
  });

const procs = [start("apps/server"), start("apps/web")];
type Proc = (typeof procs)[number];

/** Signals one child, or with `group` everything it started. False once nothing is left. */
function signal(proc: Proc, sig: NodeJS.Signals | 0, group = false): boolean {
  try {
    if (posix && group) process.kill(-proc.pid, sig);
    else if (proc.exitCode !== null || proc.signalCode !== null) return false;
    else if (sig === 0) process.kill(proc.pid, 0);
    else proc.kill(sig);
    return true;
  } catch {
    return false;
  }
}

const alive = () => procs.some((proc) => signal(proc, 0, true));

let stoppingSince = 0;
async function stop(code: number) {
  stoppingSince = Date.now();
  for (const proc of procs) signal(proc, "SIGTERM");
  // The server lets running calls finish for up to 10 seconds. After that, stop waiting.
  const deadline = Date.now() + 15_000;
  while (alive() && Date.now() < deadline) await Bun.sleep(100);
  for (const proc of procs) signal(proc, "SIGKILL", true);
  process.exit(code);
}

function onSignal() {
  if (stoppingSince) {
    // A second Ctrl-C means now. The copy `bun run` passes on from the first one doesn't.
    if (Date.now() - stoppingSince < 1_000) return;
    for (const proc of procs) signal(proc, "SIGKILL", true);
    process.exit(1);
  }
  void stop(0);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);

// If either process dies, take the other one down too.
await Promise.race(procs.map((p) => p.exited));
if (!stoppingSince) await stop(1);
