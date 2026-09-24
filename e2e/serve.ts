import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Starts Openfield the way `bun start` does, for one e2e suite: fake models (no keys, no network,
// no cost), an empty library in a temp folder that's deleted on exit, and the port from
// OPENFIELD_PORT. `--build` builds the web app first. Run with Bun: `bun e2e/serve.ts`.
// SIGUSR2 restarts the server on the same library and port, the way a person quits and reopens
// it (SIGTERM, so it drains first). SIGUSR1 does the same after a crash: SIGKILL, mid-call if it was
// busy. This script's pid is in serve.pid, beside the library folder (see restartServer in support.ts).

const root = join(import.meta.dir, "..");

if (process.argv.includes("--build")) {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(root, "apps/web") });
  if (build.exitCode !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    process.exit(build.exitCode ?? 1);
  }
}

const dir = mkdtempSync(join(tmpdir(), "openfield-e2e-"));
const home = join(dir, "home");
mkdirSync(home, { mode: 0o700 });
writeFileSync(join(dir, "serve.pid"), String(process.pid));

const start = () =>
  Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", OPENFIELD_HOME: home, OPENFIELD_FAKE_PROVIDERS: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });

let server = start();
let stopping = false;
let restarting = false;

// Pass a stop signal on, then stay alive until the server is gone so the temp folder goes too.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    server.kill(signal);
  });
}

async function restart(signal: "SIGTERM" | "SIGKILL") {
  if (stopping || restarting) return;
  restarting = true;
  const old = server;
  old.kill(signal);
  await old.exited;
  if (!stopping) server = start();
  restarting = false;
}

process.on("SIGUSR2", () => void restart("SIGTERM"));
process.on("SIGUSR1", () => void restart("SIGKILL"));

let code: number;
do {
  code = await server.exited;
  // A restart swaps in a new server as this one exits: wait on that one instead.
  while (restarting) await Bun.sleep(50);
} while (!stopping && server.exitCode === null);
rmSync(dir, { recursive: true, force: true });
process.exit(code);
