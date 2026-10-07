// Builds the server the desktop app runs as its sidecar: one `bun build --compile` binary named the
// way Tauri's externalBin wants it, plus the files it reads at run time staged as Tauri resources.
// Run: bun run desktop:sidecar [--target bun-darwin-arm64|bun-darwin-x64|bun-windows-x64|
//      bun-linux-x64|bun-linux-arm64] [--skip-web] [--skip-native]
//
// The binary is apps/desktop/src-tauri/binaries/openfield-server-<rust triple>[.exe]. Beside it, in
// apps/desktop/src-tauri/resources (gitignored): web/ (the built web app), migrations/, templates/
// and native/ (sharp's native library for the target). The app points the server at each one with
// OPENFIELD_WEB_DIST, OPENFIELD_MIGRATIONS_DIR, OPENFIELD_TEMPLATES_DIR and OPENFIELD_NATIVE_DIR.
//
// sharp's native library can't be cross-installed, so each OS builds its own (CI does). Without it
// installed the build stops; --skip-native builds the binary anyway, to check that it compiles.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";

const ROOT = join(import.meta.dir, "..");
const TAURI = join(ROOT, "apps/desktop/src-tauri");
const ENTRY = join(ROOT, "apps/server/src/bin.ts");
/** The module sharp is patched to ask for its native library. */
const SHARP_LOADER = join(ROOT, "apps/server/src/files/sharp.ts");

export interface Target {
  /** Rust's name for it, which Tauri appends to the sidecar's file name. */
  triple: string;
  /** sharp's name for the platform: its @img packages are `sharp-<this>`. */
  sharp: string;
  windows: boolean;
}

export const TARGETS = {
  "bun-darwin-arm64": { triple: "aarch64-apple-darwin", sharp: "darwin-arm64", windows: false },
  "bun-darwin-x64": { triple: "x86_64-apple-darwin", sharp: "darwin-x64", windows: false },
  "bun-windows-x64": { triple: "x86_64-pc-windows-msvc", sharp: "win32-x64", windows: true },
  "bun-linux-x64": { triple: "x86_64-unknown-linux-gnu", sharp: "linux-x64", windows: false },
  "bun-linux-arm64": { triple: "aarch64-unknown-linux-gnu", sharp: "linux-arm64", windows: false },
} as const satisfies Record<string, Target>;

export type TargetName = keyof typeof TARGETS;

const isTarget = (name: string): name is TargetName => Object.hasOwn(TARGETS, name);

/** The target for the computer this runs on. */
export function hostTarget(platform: string = process.platform, arch: string = process.arch): TargetName {
  const os = platform === "win32" ? "windows" : platform;
  const name = `bun-${os}-${arch}`;
  if (!isTarget(name)) throw new Error(`The desktop app doesn't build on ${platform}-${arch}.`);
  return name;
}

export interface BuildArgs {
  target: TargetName;
  skipWeb: boolean;
  skipNative: boolean;
}

export function parseArgs(argv: readonly string[], host: () => TargetName = hostTarget): BuildArgs {
  let target: TargetName | undefined;
  let skipWeb = false;
  let skipNative = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.split("=", 2) as [string, string | undefined];
    if (flag === "--target") {
      const value = inline ?? argv[++i];
      if (!value || !isTarget(value)) {
        throw new Error(
          `--target must be one of ${Object.keys(TARGETS).join(", ")}. Got ${value ?? "nothing"}.`,
        );
      }
      target = value;
    } else if (arg === "--skip-web") skipWeb = true;
    else if (arg === "--skip-native") skipNative = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  return { target: target ?? host(), skipWeb, skipNative };
}

export function sidecarPath(target: TargetName, dir = join(TAURI, "binaries")): string {
  const { triple, windows } = TARGETS[target];
  return join(dir, `openfield-server-${triple}${windows ? ".exe" : ""}`);
}

/**
 * sharp picks its native library with `require("@img/sharp-<platform>/sharp.node")`, which a
 * compiled binary can't resolve, and its libvips sits on a path relative to that file. The patch
 * asks apps/server/src/files/sharp.ts first, which loads it from OPENFIELD_NATIVE_DIR. When that
 * gives nothing, sharp goes on the way it always does.
 */
export function patchSharpLoader(source: string, kind: "cjs" | "mjs", loader: string = SHARP_LOADER): string {
  if (!source.includes("let sharp;") || !source.includes("runtimePlatform")) {
    throw new Error("sharp's loader changed shape; update patchSharpLoader in scripts/build-sidecar.ts.");
  }
  const bind =
    kind === "mjs"
      ? `import { nativeSharp as __openfieldNativeSharp } from ${JSON.stringify(loader)};\n`
      : `const { nativeSharp: __openfieldNativeSharp } = require(${JSON.stringify(loader)});\n`;
  return bind + source.replace("let sharp;", "let sharp = __openfieldNativeSharp(runtimePlatform);");
}

export const sharpNativePlugin: BunPlugin = {
  name: "openfield-sharp-native",
  setup(build) {
    build.onLoad({ filter: /[\\/]sharp[\\/]dist[\\/]sharp\.(c|m)js$/ }, async ({ path }) => ({
      loader: "js",
      contents: patchSharpLoader(await Bun.file(path).text(), path.endsWith(".mjs") ? "mjs" : "cjs"),
    }));
  },
};

/** sharp's package folder, the one apps/server resolves. Its @img packages sit beside it. */
function sharpDir(): string {
  return dirname(dirname(Bun.resolveSync("sharp", join(ROOT, "apps/server"))));
}

/** Copies @img/sharp-<platform> and the libvips it names, laid out as in node_modules. */
function stageNative(target: TargetName, out: string): void {
  const platform = TARGETS[target].sharp;
  const img = join(sharpDir(), "..", "@img");
  const main = join(img, `sharp-${platform}`);
  if (!existsSync(join(main, "package.json"))) {
    throw new Error(
      `sharp for ${platform} isn't installed here, so ${target} can't get thumbnails. Build on that ` +
        "OS (CI builds each one on its own runner), or pass --skip-native to only check that it compiles.",
    );
  }
  const pkg = JSON.parse(readFileSync(join(main, "package.json"), "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  const names = [`@img/sharp-${platform}`, ...Object.keys(pkg.optionalDependencies ?? {})];
  for (const name of names) {
    const from = join(img, "..", name);
    if (!existsSync(from)) throw new Error(`${name} isn't installed. Run bun install on this computer.`);
    cpSync(from, join(out, name), { recursive: true, dereference: true });
  }
}

/** Replaces a resource folder with a fresh copy of `from`. */
function stage(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`${from} doesn't exist.`);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed.`);
}

export async function buildSidecar(args: BuildArgs): Promise<string> {
  const resources = join(TAURI, "resources");
  if (!args.skipWeb) {
    console.log("Building the web app…");
    await run(["bun", "--filter", "@openfield/web", "build"]);
  }
  const webDist = join(ROOT, "apps/web/dist");
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error("apps/web/dist has no index.html. Build the web app first, or drop --skip-web.");
  }
  stage(webDist, join(resources, "web"));
  stage(join(ROOT, "packages/db/migrations"), join(resources, "migrations"));
  stage(join(ROOT, "apps/server/seed/templates"), join(resources, "templates"));
  if (!args.skipNative) {
    const native = join(resources, "native");
    rmSync(native, { recursive: true, force: true });
    mkdirSync(native, { recursive: true });
    stageNative(args.target, native);
  }

  const outfile = sidecarPath(args.target);
  mkdirSync(dirname(outfile), { recursive: true });
  console.log(`Compiling the server for ${args.target}…`);
  // No bytecode: it needs CommonJS output, and the server awaits at the top level.
  const result = await Bun.build({
    entrypoints: [ENTRY],
    plugins: [sharpNativePlugin],
    minify: true,
    sourcemap: "linked",
    compile: {
      target: args.target,
      outfile,
      // The app's environment is the whole configuration: a stray .env or bunfig.toml in the
      // folder it's started from must not change it.
      autoloadDotenv: false,
      autoloadBunfig: false,
      // The console stays: agent apps start `openfield-server mcp` and talk to it over stdin and
      // stdout like any other MCP server, which a windowless (GUI) build can't promise. The app
      // itself starts the server without a window. Bun applies these only when built on Windows.
      ...(TARGETS[args.target].windows && {
        windows: { title: "Openfield", description: "Openfield server" },
      }),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error("The server didn't compile.");
  }
  return outfile;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outfile = await buildSidecar(args);
    console.log(`Built ${outfile}${args.skipNative ? " (without sharp's native library)" : ""}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
