import { readdirSync } from "node:fs";
import { join } from "node:path";
import type SharpModule from "sharp";

// The one way the server loads sharp. From source it's a plain import. A compiled server (the
// desktop app) can't find sharp's native library inside node_modules, so the sidecar build patches
// sharp to ask nativeSharp() first, which loads it from the folder the app ships it in.

export type Sharp = typeof SharpModule;

let loading: Promise<Sharp> | undefined;

/** Rejects when sharp can't load on this computer; callers fall back without it. */
export function loadSharp(): Promise<Sharp> {
  loading ??= import("sharp").then((mod) => mod.default);
  return loading;
}

/**
 * sharp's native binding from OPENFIELD_NATIVE_DIR, laid out like node_modules:
 * `@img/sharp-<platform>/lib/*.node`, with `@img/sharp-libvips-<platform>` beside it where its
 * library path expects it. `platform` is sharp's own name for this computer, e.g. "darwin-arm64"
 * or "linuxmusl-x64". Undefined when no folder is set, so sharp looks the usual way.
 */
export function nativeSharp(
  platform: string,
  env: Record<string, string | undefined> = process.env,
): unknown {
  const root = env.OPENFIELD_NATIVE_DIR?.trim();
  if (!root) return undefined;
  const lib = join(root, "@img", `sharp-${platform}`, "lib");
  let file: string | undefined;
  try {
    file = readdirSync(lib).find((name) => name.endsWith(".node"));
  } catch {
    // Reported below with the path, which says more than ENOENT.
  }
  if (!file) throw new Error(`sharp for ${platform} isn't in ${lib}`);
  const mod = { exports: {} as unknown };
  process.dlopen(mod, join(lib, file));
  return mod.exports;
}
