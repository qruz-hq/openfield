// Runs the server and the Vite dev server together. Open the URL the server prints.
// The server proxies everything outside /api and /files to Vite, so the app has one origin in dev too.

const env = { ...process.env, OPENFIELD_DEV: "1" };

const procs = [
  Bun.spawn(["bun", "--filter", "@openfield/server", "dev"], { env, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--filter", "@openfield/web", "dev"], { env, stdout: "inherit", stderr: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// If either process dies, take the other one down too.
await Promise.race(procs.map((p) => p.exited));
stop(1);
