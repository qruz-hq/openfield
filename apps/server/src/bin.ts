// The entry `bun build --compile` turns into the desktop app's sidecar (scripts/build-sidecar.ts).
// One binary does both jobs: `openfield-server` runs Openfield, and `openfield-server mcp` is the
// stdio bridge agent apps start, which only talks to a running Openfield and never starts one.
// Each is loaded only when asked for, so the bridge doesn't pay for the server's boot.

/** What the arguments ask for. Exported for tests. */
export function commandOf(argv: readonly string[]): "mcp" | "server" {
  return argv[2] === "mcp" ? "mcp" : "server";
}

if (import.meta.main) {
  if (commandOf(process.argv) === "mcp") await (await import("./mcp/stdio")).runBridge();
  else await (await import("./run")).runServer();
}
