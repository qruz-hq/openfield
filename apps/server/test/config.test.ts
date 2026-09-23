import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileError, ConfigStore } from "../src/config/config-file";
import { resolveHome } from "../src/config/home";
import { createServer } from "../src/server";
import { saveKey, startTestServer, TEST_KEY, type TestServer } from "./helpers";

// §6.11: config.json at 0600, the folder at 0700, checked on every write; env vars override.

const mode = (path: string) => statSync(path).mode & 0o777;

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("OPENFIELD_HOME", () => {
  test("defaults to ~/.openfield and expands ~", () => {
    expect(resolveHome({})).toBe(join(homedir(), ".openfield"));
    expect(resolveHome({ OPENFIELD_HOME: "~/pics/of" })).toBe(join(homedir(), "pics/of"));
    expect(resolveHome({ OPENFIELD_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  test("boot creates the folder tree and keeps the root private", async () => {
    server = await startTestServer();
    expect(mode(server.home)).toBe(0o700);
    for (const dir of [
      "assets",
      "uploads",
      "thumbs",
      "logs",
      "tmp/orphans",
      "presets/exported",
      "canvases/templates",
    ]) {
      expect(statSync(join(server.home, dir)).isDirectory()).toBe(true);
    }
  });
});

describe("config.json", () => {
  test("every write is 0600, with the previous file kept as a 0600 backup", async () => {
    server = await startTestServer();
    await saveKey(server, "first-key-0000000000");
    const file = join(server.home, "config.json");
    const backup = join(server.home, "config.json.bak");
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).providers.google.apiKey).toBe("first-key-0000000000");

    await saveKey(server, "second-key-1111111111");
    expect(mode(file)).toBe(0o600);
    expect(mode(backup)).toBe(0o600);
  });

  test("a replaced or removed key doesn't live on in the backup", async () => {
    server = await startTestServer();
    const backup = join(server.home, "config.json.bak");
    await saveKey(server, "first-key-0000000000");
    await saveKey(server, "second-key-1111111111");
    expect(readFileSync(backup, "utf8")).not.toContain("first-key-0000000000");

    const removed = await server.json<{ present: boolean }>("/api/settings/keys/google", {
      method: "DELETE",
    });
    expect(removed.body.present).toBe(false);
    expect(readFileSync(backup, "utf8")).not.toContain("second-key-1111111111");
    expect(readFileSync(join(server.home, "config.json"), "utf8")).not.toContain("second-key");
  });

  test("boot makes an open backup private and clears temp files a crash left", async () => {
    const home = mkdtempSync(join(tmpdir(), "openfield-test-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
    writeFileSync(join(home, "config.json.bak"), JSON.stringify({ providers: { google: { apiKey: "k" } } }));
    chmodSync(join(home, "config.json.bak"), 0o644);
    writeFileSync(join(home, "config.json.01ABC.tmp"), "{}");
    server = await startTestServer({ home });
    expect(mode(join(home, "config.json.bak"))).toBe(0o600);
    expect(existsSync(join(home, "config.json.01ABC.tmp"))).toBe(false);
  });

  test("a config.json readable by others is fixed at boot, with a warning", async () => {
    const home = mkdtempSync(join(tmpdir(), "openfield-test-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, providers: {} }));
    chmodSync(join(home, "config.json"), 0o644);
    chmodSync(home, 0o755);
    server = await startTestServer({ home });
    expect(mode(join(home, "config.json"))).toBe(0o600);
    expect(mode(home)).toBe(0o700);
    const log = readFileSync(join(home, "logs/openfield.log"), "utf8");
    expect(log).toContain("config.json was readable by other users");
    expect(log).toContain("The library folder was open to other users");
  });

  test("a broken config.json stops boot instead of being overwritten", async () => {
    const home = mkdtempSync(join(tmpdir(), "openfield-test-"));
    writeFileSync(join(home, "config.json"), "{ not json", { mode: 0o600 });
    try {
      await expect(
        createServer({ env: { OPENFIELD_HOME: home }, console: false, webDist: null }),
      ).rejects.toThrow(ConfigFileError);
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{ not json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the store refuses to leave a key in a file it can't make private", () => {
    const dir = mkdtempSync(join(tmpdir(), "openfield-config-"));
    try {
      const store = ConfigStore.open(join(dir, "config.json"), join(dir, "config.json.bak"));
      store.update((d) => {
        d.providers.google = { apiKey: "x" };
      });
      expect(mode(join(dir, "config.json"))).toBe(0o600);
      // A directory where the file should be makes the write fail loudly.
      rmSync(join(dir, "config.json"));
      mkdirSync(join(dir, "config.json"));
      expect(() =>
        store.update((d) => {
          d.providers.google = { apiKey: "new-key" };
        }),
      ).toThrow(ConfigFileError);
      // The half-done save leaves no temp file behind holding the new key.
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a key that can't be saved gets a reply the page can show", async () => {
    server = await startTestServer();
    mkdirSync(join(server.home, "config.json"));
    const put = await server.json<{ error: { code: string; userMessage?: string } }>(
      "/api/settings/keys/google",
      { method: "PUT", body: { apiKey: TEST_KEY } },
    );
    expect(put.status).toBe(500);
    expect(put.body.error.userMessage).toBe(
      "Couldn't save your key. Check there's free space, then try again.",
    );
    expect(readdirSync(server.home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("every write puts the library folder back to private, with a warning", async () => {
    server = await startTestServer();
    chmodSync(server.home, 0o755);
    await saveKey(server, "first-key-0000000000");
    expect(mode(server.home)).toBe(0o700);
    const log = readFileSync(join(server.home, "logs/openfield.log"), "utf8");
    expect(log).toContain("The library folder was open to other users");
  });
});

describe("environment overrides", () => {
  test("an env key wins over the file, shows its source and can't be overwritten", async () => {
    server = await startTestServer({ env: { GEMINI_API_KEY: "env-key-abcdefghijkl" } });
    const status =
      await server.json<{ source: string; envVar: string; present: boolean; hint: string }[]>(
        "/api/settings/keys",
      );
    const google = status.body.find((s) => (s as { providerId?: string }).providerId === "google")!;
    expect(google).toMatchObject({ present: true, source: "env", envVar: "GEMINI_API_KEY", hint: "ijkl" });

    const put = await server.json<{ error: { code: string } }>("/api/settings/keys/google", {
      method: "PUT",
      body: { apiKey: TEST_KEY },
    });
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe("conflict");
    expect(() => readFileSync(join(server!.home, "config.json"))).toThrow();
  });

  test("OPENFIELD_<PROVIDER>_API_KEY comes before the provider's usual variable", async () => {
    server = await startTestServer({
      env: { OPENFIELD_GOOGLE_API_KEY: "first-choice-000000", GOOGLE_API_KEY: "second-choice-11111" },
    });
    const google = server.services.credentials.resolve("google");
    expect(google.values.apiKey).toBe("first-choice-000000");
    expect(google.envVar).toBe("OPENFIELD_GOOGLE_API_KEY");
  });

  test("OPENFIELD_PORT overrides the default port", async () => {
    server = await startTestServer({ port: undefined, env: { OPENFIELD_PORT: "4555" } });
    expect(server.services.port).toBe(4555);
  });
});
