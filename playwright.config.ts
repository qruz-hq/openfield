import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

// Each suite gets its own Openfield (e2e/serve.ts): fake models, an empty library in a temp
// folder, and a free port, so suites never see each other's keys or images. Suites are named
// *.e2e.ts because `bun test` claims *.spec.ts for itself.

/** Asks the OS for a free port. Synchronous, because the config is. */
function freePort(): number {
  const script =
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return Number(execFileSync(process.execPath, ["-e", script]).toString());
}

/** Playwright loads this file again in every worker, so each port is picked once and kept in the env. */
function portFor(suite: string): number {
  const key = `OPENFIELD_E2E_PORT_${suite.toUpperCase().replace(/\W/g, "_")}`;
  process.env[key] ??= String(freePort());
  return Number(process.env[key]);
}

const suites = [
  { name: "first-run", testMatch: "m0-first-run.e2e.ts" },
  { name: "guards", testMatch: "guards.e2e.ts" },
  { name: "canvas", testMatch: "canvas.e2e.ts" },
].map((suite) => ({ ...suite, origin: `http://127.0.0.1:${portFor(suite.name)}` }));

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: suites.map(({ name, testMatch, origin }) => ({ name, testMatch, use: { baseURL: origin } })),
  // Playwright starts these one after another, so only the first needs to build the web app.
  webServer: suites.map(({ origin }, i) => ({
    command: `bun e2e/serve.ts${i === 0 ? " --build" : ""}`,
    url: `${origin}/`,
    env: { OPENFIELD_PORT: new URL(origin).port },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe" as const,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
  })),
});
