import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { hostTarget, parseArgs, patchSharpLoader, sidecarPath, TARGETS } from "./build-sidecar";

// The sidecar build itself runs in CI per OS; these cover the parts that decide what it builds.

describe("targets", () => {
  test("each Bun target maps to the Rust triple Tauri names the sidecar with", () => {
    expect(Object.fromEntries(Object.entries(TARGETS).map(([name, t]) => [name, t.triple]))).toEqual({
      "bun-darwin-arm64": "aarch64-apple-darwin",
      "bun-darwin-x64": "x86_64-apple-darwin",
      "bun-windows-x64": "x86_64-pc-windows-msvc",
      "bun-linux-x64": "x86_64-unknown-linux-gnu",
      "bun-linux-arm64": "aarch64-unknown-linux-gnu",
    });
  });

  test("the host is the default", () => {
    expect(hostTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(hostTarget("win32", "x64")).toBe("bun-windows-x64");
    expect(hostTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(() => hostTarget("freebsd", "x64")).toThrow(/doesn't build on freebsd-x64/);
  });

  test("only Windows gets .exe", () => {
    expect(sidecarPath("bun-windows-x64", "/b")).toBe(
      join("/b", "openfield-server-x86_64-pc-windows-msvc.exe"),
    );
    expect(sidecarPath("bun-linux-arm64", "/b")).toBe(
      join("/b", "openfield-server-aarch64-unknown-linux-gnu"),
    );
  });
});

describe("parseArgs", () => {
  const host = () => "bun-linux-x64" as const;

  test("defaults", () => {
    expect(parseArgs([], host)).toEqual({ target: "bun-linux-x64", skipWeb: false, skipNative: false });
  });

  test("flags, with the target spelled either way", () => {
    expect(parseArgs(["--target", "bun-windows-x64", "--skip-web", "--skip-native"], host)).toEqual({
      target: "bun-windows-x64",
      skipWeb: true,
      skipNative: true,
    });
    expect(parseArgs(["--target=bun-darwin-x64"], host).target).toBe("bun-darwin-x64");
  });

  test("anything else is refused", () => {
    expect(() => parseArgs(["--target", "bun-windows-arm64"], host)).toThrow(/--target must be one of/);
    expect(() => parseArgs(["--target"], host)).toThrow(/Got nothing/);
    expect(() => parseArgs(["--bytecode"], host)).toThrow(/Unknown option --bytecode/);
  });
});

describe("patchSharpLoader", () => {
  const dist = join(
    dirname(dirname(Bun.resolveSync("sharp", join(import.meta.dir, "../apps/server")))),
    "dist",
  );

  test.each(["cjs", "mjs"] as const)("asks the loader first in sharp.%s", async (kind) => {
    const source = await Bun.file(join(dist, `sharp.${kind}`)).text();
    const patched = patchSharpLoader(source, kind, "/repo/loader.ts");
    expect(patched).toContain("let sharp = __openfieldNativeSharp(runtimePlatform);");
    expect(patched).not.toContain("let sharp;");
    expect(patched.split("\n")[0]).toBe(
      kind === "mjs"
        ? 'import { nativeSharp as __openfieldNativeSharp } from "/repo/loader.ts";'
        : 'const { nativeSharp: __openfieldNativeSharp } = require("/repo/loader.ts");',
    );
  });

  test("a sharp that changed shape stops the build instead of shipping without thumbnails", () => {
    expect(() => patchSharpLoader("let binding;", "cjs")).toThrow(/changed shape/);
  });
});
