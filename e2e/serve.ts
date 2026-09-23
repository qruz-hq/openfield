import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Starts Openfield the way `bun start` does, for one e2e suite: fake models (no keys, no network,
// no cost), an empty library in a temp folder that's deleted on exit, and the port from
// OPENFIELD_PORT. `--build` builds the web app first. Run with Bun: `bun e2e/serve.ts`.

const root = join(import.meta.dir, "..");

if (process.argv.includes("--build")) {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(root, "apps/web") });
  if (build.exitCode !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    process.exit(build.exitCode ?? 1);
  }
}

const home = mkdtempSync(join(tmpdir(), "openfield-e2e-"));
const server = Bun.spawn(["bun", "apps/server/src/index.ts"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "production", OPENFIELD_HOME: home, OPENFIELD_FAKE_PROVIDERS: "1" },
  stdout: "inherit",
  stderr: "inherit",
});

// Pass a stop signal on, then stay alive until the server is gone so the temp folder goes too.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));

const code = await server.exited;
rmSync(home, { recursive: true, force: true });
process.exit(code);
