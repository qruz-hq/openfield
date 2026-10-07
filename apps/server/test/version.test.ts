import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { healthResponseSchema } from "@openfield/core";
import { startTestServer, type TestServer } from "./helpers";
import { connectAgent, turnOnAgents } from "./mcp-helpers";

// One version for the whole app: the root package.json. The server reports it, the desktop app's
// tauri.conf.json reads it, and Cargo.toml (which can't read a file) must say the same. The
// release workflow checks the tag against the root package.json and Cargo.toml.

const ROOT = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const rootVersion = (JSON.parse(read("package.json")) as { version: string }).version;

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("app version", () => {
  test("the root package.json has a real version", () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rootVersion).not.toBe("0.0.0");
  });

  test("the desktop app reads it, and Cargo.toml matches it", () => {
    const tauri = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { version: string };
    expect(tauri.version).toBe("../../../package.json");
    const crate = /^version = "(.+)"$/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1];
    expect(crate).toBe(rootVersion);
    // No second copy to forget when bumping.
    expect(JSON.parse(read("apps/desktop/package.json")).version).toBeUndefined();
  });

  test("/api/health reports it", async () => {
    server = await startTestServer();
    const health = healthResponseSchema.parse((await server.json("/api/health")).body);
    expect(health.version).toBe(rootVersion);
  });

  test("the MCP server introduces itself with it", async () => {
    server = await startTestServer();
    await turnOnAgents(server);
    const client = await connectAgent(server);
    expect(client.getServerVersion()?.version).toBe(rootVersion);
    await client.close();
  });
});
