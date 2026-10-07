import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { commandOf } from "../src/bin";
import { bundledTemplatesDir } from "../src/canvas/templates";
import { homePaths, resolveHome } from "../src/config/home";
import {
  type ControlCommand,
  ControlReader,
  errorLine,
  isCompiled,
  isDesktop,
  listenForControl,
  readyLine,
} from "../src/desktop";
import { nativeSharp } from "../src/files/sharp";
import { notRunning } from "../src/mcp/stdio";
import { agentLaunch, isTemporaryPlace } from "../src/server";

// The desktop app's side of the server (apps/desktop): the folders it points the compiled server
// at, the lines it reads on stdout, the commands it writes on stdin, and the command agents get.

const SRC = join(import.meta.dir, "../src");

describe("folder overrides", () => {
  test("templates come from OPENFIELD_TEMPLATES_DIR when it's set", () => {
    expect(bundledTemplatesDir({})).toBe(join(SRC, "../seed/templates"));
    expect(bundledTemplatesDir({ OPENFIELD_TEMPLATES_DIR: " " })).toBe(join(SRC, "../seed/templates"));
    expect(bundledTemplatesDir({ OPENFIELD_TEMPLATES_DIR: "/app/templates" })).toBe("/app/templates");
  });

  test("sharp's native library loads from OPENFIELD_NATIVE_DIR, laid out like node_modules", async () => {
    expect(nativeSharp("darwin-arm64", {})).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), "openfield-native-"));
    try {
      expect(() => nativeSharp("darwin-arm64", { OPENFIELD_NATIVE_DIR: empty })).toThrow(
        /sharp for darwin-arm64 isn't in/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // node_modules already has the layout. In a child process, so this one's sharp is untouched.
    const modules = dirname(dirname(dirname(Bun.resolveSync("sharp", SRC))));
    const script = `const { nativeSharp } = await import(${JSON.stringify(join(SRC, "files/sharp.ts"))});
const b = nativeSharp(${JSON.stringify(`${process.platform}-${process.arch}`)}, { OPENFIELD_NATIVE_DIR: ${JSON.stringify(modules)} });
console.log(typeof b.libvipsVersion);`;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(proc.stdout).text()).trim()).toBe("function");
    expect(await proc.exited).toBe(0);
  });
});

describe("lines for the app", () => {
  test("ready and error lines carry JSON after a fixed word", () => {
    expect(readyLine(4317)).toBe('OPENFIELD_READY {"port":4317,"url":"http://127.0.0.1:4317"}');
    const line = errorLine("port_in_use", 'Port "4317" is taken');
    expect(line.startsWith("OPENFIELD_ERROR ")).toBe(true);
    expect(JSON.parse(line.slice("OPENFIELD_ERROR ".length))).toEqual({
      code: "port_in_use",
      message: 'Port "4317" is taken',
    });
  });

  test("only OPENFIELD_DESKTOP=1 is the desktop app", () => {
    expect(isDesktop({ OPENFIELD_DESKTOP: "1" })).toBe(true);
    expect(isDesktop({ OPENFIELD_DESKTOP: "true" })).toBe(false);
    expect(isDesktop({})).toBe(false);
  });

  test("a compiled binary is told apart by where its files live", () => {
    expect(isCompiled("/$bunfs/root")).toBe(true);
    expect(isCompiled("B:\\~BUN\\root")).toBe(true);
    expect(isCompiled(SRC)).toBe(false);
    expect(isCompiled()).toBe(false);
  });
});

describe("commands on stdin", () => {
  test("whole lines only, split anywhere, with either line ending", () => {
    const reader = new ControlReader();
    expect(reader.push("qu")).toEqual([]);
    expect(reader.push("it\r\nhello\n  now  \n")).toEqual(["quit", "now"]);
    expect(reader.push("QUIT\nquitting\n")).toEqual([]);
    expect(reader.push("now")).toEqual([]);
    expect(reader.push("\n")).toEqual(["now"]);
  });

  test("a runaway line is dropped instead of kept", () => {
    const reader = new ControlReader();
    reader.push("x".repeat(5000));
    expect(reader.push("\nquit\n")).toEqual(["quit"]);
  });

  test("the end of stdin is a quit, said once", async () => {
    const stream = new PassThrough();
    const heard: ControlCommand[] = [];
    listenForControl(stream, (command) => heard.push(command));
    stream.write("now\n");
    stream.end();
    await Bun.sleep(20);
    stream.destroy();
    await Bun.sleep(20);
    expect(heard).toEqual(["now", "quit"]);
  });
});

describe("the command agents get", () => {
  const paths = homePaths(resolveHome({}));
  const base = { paths, port: 4317, configuredPort: 4317, execPath: "/Apps/Openfield/openfield-server" };

  test("from a checkout, bun runs the bridge script", () => {
    const launch = agentLaunch({ ...base, env: {}, compiled: false });
    expect(launch.args).toEqual(["run", "--silent", "--cwd", expect.any(String), "mcp"]);
    expect(existsSync(join(launch.args[3]!, "package.json"))).toBe(true);
  });

  test("in the desktop app, the installed server binary with mcp", () => {
    expect(agentLaunch({ ...base, env: { OPENFIELD_DESKTOP: "1" }, compiled: false })).toEqual({
      command: "/Apps/Openfield/openfield-server",
      args: ["mcp"],
      env: {},
    });
    // A compiled binary started by hand is the same binary: never `run ... mcp`, which would boot a server.
    expect(agentLaunch({ ...base, env: {}, compiled: true }).args).toEqual(["mcp"]);
    expect(agentLaunch({ ...base, port: 5000, env: { OPENFIELD_DESKTOP: "1" } }).env).toEqual({
      OPENFIELD_PORT: "5000",
    });
  });

  test("a path the app gives that lasts wins over its own, and a temporary one is flagged", () => {
    const desktop = { ...base, execPath: undefined, env: { OPENFIELD_DESKTOP: "1" } };
    expect(
      agentLaunch({
        ...desktop,
        env: { ...desktop.env, OPENFIELD_AGENT_COMMAND: "/home/a/Openfield.AppImage" },
      }),
    ).toEqual({ command: "/home/a/Openfield.AppImage", args: ["mcp"], env: {} });
    expect(agentLaunch({ ...base, env: { OPENFIELD_DESKTOP: "1" } }).temporary).toBeUndefined();

    const translocated =
      "/private/var/folders/x/T/AppTranslocation/1F/d/Openfield.app/Contents/MacOS/openfield-server";
    expect(agentLaunch({ ...base, env: { OPENFIELD_DESKTOP: "1" }, execPath: translocated }).temporary).toBe(
      true,
    );
    const dmg = "/Volumes/Openfield/Openfield.app/Contents/MacOS/openfield-server";
    expect(isTemporaryPlace(dmg, () => false)).toBe(true);
    // An app installed on another drive is where the person put it.
    expect(isTemporaryPlace(dmg, () => true)).toBe(false);
    expect(isTemporaryPlace("/tmp/.mount_OpenfXYZ/usr/bin/openfield-server")).toBe(true);
    expect(isTemporaryPlace("/Applications/Openfield.app/Contents/MacOS/openfield-server")).toBe(false);
  });

  test("the bridge says to open the app when it's the desktop app's", () => {
    expect(notRunning(true)).toBe("Openfield isn't running. Open the Openfield app, then try again.");
    expect(notRunning(false)).toContain("bun start");
    expect(notRunning()).toContain("bun start");
  });
});

// The real entry, from source: the same code the compiled sidecar runs.

const BIN = join(SRC, "bin.ts");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("No free port");
  return port;
}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("OPENFIELD_"),
    ),
  );
}

function spawnBin(args: string[], env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "openfield-desktop-"));
  homes.push(home);
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    env: { ...cleanEnv(), OPENFIELD_HOME: home, OPENFIELD_WEB_DIST: join(home, "no-web-app"), ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) out += decoder.decode(chunk);
  })();
  return { proc, home, out: () => out };
}

async function until(check: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await Bun.sleep(25);
  }
}

describe("bin.ts", () => {
  test("only `mcp` picks the bridge", () => {
    expect(commandOf(["bun", "/x/bin.ts"])).toBe("server");
    expect(commandOf(["bun", "/x/bin.ts", "mcp"])).toBe("mcp");
    expect(commandOf(["openfield-server", "/$bunfs/root/bin", "mcp", "extra"])).toBe("mcp");
    expect(commandOf(["bun", "/x/bin.ts", "start"])).toBe("server");
  });

  test("`mcp` runs the bridge, not a second server, and answers before it leaves when stdin closes", async () => {
    const port = freePort();
    const { proc, home, out } = spawnBin(["mcp"], { OPENFIELD_PORT: String(port) });
    // Some apps send their last request and close stdin at once: it still gets its answer.
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`,
    );
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    await Bun.sleep(50);
    const reply = JSON.parse(out().trim().split("\n").at(-1) ?? "null");
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 1, error: { message: expect.any(String) } });
    // A server would have made the library; the bridge only reads config.json.
    expect(existsSync(join(home, "openfield.db"))).toBe(false);
  }, 20_000);

  test("the desktop app gets a ready line, and `quit` stops it cleanly", async () => {
    const port = freePort();
    const run = spawnBin([], { OPENFIELD_DESKTOP: "1", OPENFIELD_PORT: String(port) });
    await until(() => run.out().includes("OPENFIELD_READY"));
    expect(run.out()).toContain(readyLine(port));
    run.proc.stdin.write("quit\n");
    run.proc.stdin.flush();
    expect(await run.proc.exited).toBe(0);
    expect(run.out()).toContain("Openfield stopped.");
  }, 30_000);

  test("stdin closing (the app is gone) stops it too", async () => {
    const run = spawnBin([], { OPENFIELD_DESKTOP: "1", OPENFIELD_PORT: String(freePort()) });
    await until(() => run.out().includes("OPENFIELD_READY"));
    run.proc.stdin.end();
    expect(await run.proc.exited).toBe(0);
  }, 30_000);

  test("a taken port is an error line with its code", async () => {
    const port = freePort();
    const taken = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    try {
      const run = spawnBin([], { OPENFIELD_DESKTOP: "1", OPENFIELD_PORT: String(port) });
      expect(await run.proc.exited).toBe(1);
      await Bun.sleep(50);
      const line = run
        .out()
        .split("\n")
        .find((l) => l.startsWith("OPENFIELD_ERROR "));
      expect(JSON.parse(line!.slice("OPENFIELD_ERROR ".length))).toMatchObject({ code: "port_in_use" });
      expect(run.out()).not.toContain("OPENFIELD_READY");
    } finally {
      taken.stop(true);
    }
  }, 30_000);

  test("without OPENFIELD_DESKTOP nothing extra is printed", async () => {
    const port = freePort();
    const run = spawnBin([], { OPENFIELD_PORT: String(port) });
    await until(() => run.out().includes("Openfield is running at"));
    run.proc.kill("SIGTERM");
    expect(await run.proc.exited).toBe(0);
    expect(run.out()).not.toContain("OPENFIELD_");
  }, 30_000);
});
