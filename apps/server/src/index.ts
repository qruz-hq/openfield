import { MAX_REQUEST_BYTES } from "./app";
import { createServer, LibraryInUseError } from "./server";

// `bun start` and `bun dev` land here. Binds 127.0.0.1 only, never 0.0.0.0 (§6.11).

const server = await createServer().catch((err: unknown) => {
  if (err instanceof LibraryInUseError) console.error(err.message);
  else console.error(`Openfield couldn't start. ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
const { port, dev } = server.services;

let http: ReturnType<typeof Bun.serve>;
try {
  // Long enough for the event stream's 15 s heartbeat.
  http = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: server.app.fetch,
    idleTimeout: 60,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
} catch (err) {
  const inUse = (err as { code?: string }).code === "EADDRINUSE";
  console.error(
    inUse
      ? `Port ${port} is already in use. Is Openfield already running? Set OPENFIELD_PORT to use another port.`
      : `Openfield couldn't start. ${err instanceof Error ? err.message : String(err)}`,
  );
  await server.stop({ drainMs: 0 });
  process.exit(1);
}

console.log(`\nOpenfield is running at http://127.0.0.1:${port}${dev ? " (dev)" : ""}\n`);
server.startBackground();

let stoppingSince = 0;
async function shutdown() {
  if (stoppingSince) {
    // A second Ctrl-C means now. A copy of the first one, a moment later, doesn't.
    if (Date.now() - stoppingSince < 1_000) return;
    process.exit(1);
  }
  stoppingSince = Date.now();
  console.log("Stopping Openfield. Press Ctrl-C again to quit at once.");
  server.services.events.close();
  await Promise.race([http.stop(), Bun.sleep(3_000)]);
  await server.stop({ drainMs: 10_000 });
  void http.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
