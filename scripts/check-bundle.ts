// Builds apps/web with source maps and fails if server code or a key ended up in the browser bundle.
// Enforces PRD §0.16 (dependency rules 1 to 4) and the S5 secret scan. Run: bun run check:bundle

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export interface SourceMapLike {
  sources?: (string | null)[];
  sourceRoot?: string;
}

export interface SourceViolation {
  rule: string;
  source: string;
}

export interface SecretFinding {
  file: string;
  line: number;
  column: number;
  kind: string;
  preview: string;
}

const SERVER_ONLY_PACKAGES = ["sharp", "drizzle-orm", "drizzle-kit", "drizzle-zod"];

// Workspace names, so a symlinked path (preserveSymlinks) maps back to the real folder.
const WORKSPACE_DIRS: Record<string, string> = {
  server: "apps/server",
  web: "apps/web",
  core: "packages/core",
  db: "packages/db",
  providers: "packages/providers",
  ui: "packages/ui",
};

const toPosix = (p: string) => p.split(sep).join("/");

/** Maps a module path to a repo-relative posix path, or null when it lives outside the repo. */
export function repoPath(absPath: string, repoRoot: string): string | null {
  const rel = toPosix(relative(repoRoot, absPath));
  if (rel.startsWith("../") || rel === "..") return null;
  const linked = rel.match(/(?:^|\/)node_modules\/@openfield\/([^/]+)\/(.*)$/);
  if (linked?.[1] && WORKSPACE_DIRS[linked[1]]) return `${WORKSPACE_DIRS[linked[1]]}/${linked[2]}`;
  return rel;
}

/** Why a bundled module must not be in the browser, or null when it's fine. */
export function classifySource(raw: string, rel: string | null): string | null {
  // Vite swaps Node and Bun built-ins for this empty stub instead of failing the build.
  if (raw.includes("__vite-browser-external") || /(?:^|[\\/\0:])(?:bun|node):/.test(raw)) {
    return "A Node or Bun built-in (bun:, node:) was imported by browser code.";
  }
  if (rel === null) return null;

  for (const pkg of SERVER_ONLY_PACKAGES) {
    if (rel.includes(`node_modules/${pkg}/`)) return `${pkg} is a server-only package.`;
  }
  if (rel.includes("node_modules/")) return null;

  if (rel.startsWith("packages/db/")) return "packages/db is server-only (§0.16 rule 4).";
  if (rel.startsWith("apps/server/")) return "apps/server code can't ship to the browser (§0.16 rule 1).";

  if (rel.startsWith("packages/providers/")) {
    const inner = rel.slice("packages/providers/".length);
    if (inner === "src/manifest.ts" || inner.startsWith("src/manifest/") || inner.startsWith("src/types/")) {
      return null;
    }
    if (inner === "src/server.ts") {
      return "@openfield/providers/server is the server entry. Use @openfield/providers/manifest.";
    }
    const adapter = inner.match(/^src\/([^/]+)\//)?.[1];
    if (adapter) return `The "${adapter}" adapter is server-only (§0.16 rule 3).`;
    return "Only @openfield/providers/manifest may reach the browser (§0.16 rule 3).";
  }
  return null;
}

/** Checks every source listed in the given maps. `mapPath` is where each map file lives on disk. */
export function checkSourceMaps(
  maps: { mapPath: string; map: SourceMapLike }[],
  repoRoot: string,
): SourceViolation[] {
  const seen = new Set<string>();
  const out: SourceViolation[] = [];
  for (const { mapPath, map } of maps) {
    for (const raw of map.sources ?? []) {
      if (!raw) continue;
      const abs = resolve(dirname(mapPath), map.sourceRoot ?? "", raw);
      const rel = repoPath(abs, repoRoot);
      const rule = classifySource(raw, rel);
      const source = rel ?? raw;
      if (rule && !seen.has(source)) {
        seen.add(source);
        out.push({ rule, source });
      }
    }
  }
  return out;
}

/** Built-ins Vite reported as externalized, with the file that imported each one. */
export function externalizedFromLog(log: string, repoRoot: string): SourceViolation[] {
  const out: SourceViolation[] = [];
  const re = /Module "([^"]+)" has been externalized for browser compatibility, imported by "([^"]+)"/g;
  for (const m of log.matchAll(re)) {
    const importer = repoPath(m[2] ?? "", repoRoot) ?? m[2] ?? "";
    out.push({ rule: `Imports "${m[1]}", which only exists on the server.`, source: importer });
  }
  return out;
}

/** bun: or node: specifiers left in emitted JS, e.g. when a config marks them external. */
export function findBuiltinImports(code: string): string[] {
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'`])((?:bun|node):[^"'`]+)\1/g;
  return [...new Set([...code.matchAll(re)].map((m) => m[2] ?? ""))];
}

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  // Bounded on both sides so a long inlined base64 asset can't produce a false match.
  { kind: "Google API key", re: /(?<![A-Za-z0-9+/_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  // The newer auth keys AI Studio makes by default (§6.11). Google doesn't document their length, so
  // the net is loose; a digit is required so minified code like `AQ.getBoundingClientRect` never trips it.
  {
    kind: "Google API key",
    re: /(?<![A-Za-z0-9+/_.$-])AQ\.(?=[0-9A-Za-z_-]*\d)[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_-])/g,
  },
  { kind: "OpenAI API key", re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g },
  { kind: "x-goog-api-key header value", re: /x-goog-api-key["'`]?\s*[:,=]\s*["'`][^"'`\s]{8,}["'`]/gi },
  { kind: "Bearer token", re: /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{20,}/g },
];

// Never print a key. Enough to find it, not enough to use it.
const redact = (s: string) => `${s.slice(0, 4)}… (${s.length} chars)`;

function position(text: string, index: number) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return { line, column: index - before.lastIndexOf("\n") };
}

/** Key-shaped strings, plus exact matches for keys configured on this machine. */
export function scanForSecrets(
  file: string,
  text: string,
  knownKeys: { label: string; value: string }[] = [],
): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ file, ...position(text, m.index ?? 0), kind, preview: redact(m[0]) });
    }
  }
  for (const { label, value } of knownKeys) {
    let i = text.indexOf(value);
    while (i !== -1) {
      out.push({ file, ...position(text, i), kind: `Your key from ${label}`, preview: redact(value) });
      i = text.indexOf(value, i + value.length);
    }
  }
  return out;
}

const KEY_ENV =
  /^(?:OPENFIELD_\w*(?:API_KEY|KEY_ID|KEY_SECRET)|OPENAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY)$/;

/** Keys from env vars and config.json, so the scan also catches this machine's real keys (§6.11). */
export async function loadConfiguredKeys(env: Record<string, string | undefined>) {
  const keys: { label: string; value: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (KEY_ENV.test(name) && value && value.trim().length >= 8)
      keys.push({ label: name, value: value.trim() });
  }
  const home = env.OPENFIELD_HOME || join(homedir(), ".openfield");
  try {
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      providers?: Record<string, Record<string, unknown>>;
    };
    for (const [provider, fields] of Object.entries(config.providers ?? {})) {
      for (const [field, value] of Object.entries(fields ?? {})) {
        if (typeof value === "string" && value.length >= 8 && !value.startsWith("http")) {
          keys.push({ label: `Settings (${provider}.${field})`, value });
        }
      }
    }
  } catch {
    // No config yet is the normal case in CI.
  }
  return keys;
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const f of new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true })) files.push(join(dir, f));
  return files;
}

const CODE = new Set([".js", ".mjs", ".cjs"]);
const BINARY = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
]);

/**
 * Every file the server hands out gets the secret scan: source maps carry the full source text,
 * and public/ is copied as is. Only images and fonts are skipped.
 */
export const scannedForSecrets = (file: string) => !BINARY.has(extname(file).toLowerCase());

class CheckFailed extends Error {}

/** Returns the success line, or throws CheckFailed with the full report. */
async function run(repoRoot: string, outDir: string): Promise<string> {
  const webDir = join(repoRoot, "apps/web");
  if (!existsSync(join(webDir, "index.html"))) {
    throw new CheckFailed(
      "apps/web has no index.html yet, so there is no web app to check.\nThis check works once `bun run build` builds apps/web.",
    );
  }

  console.log("Building apps/web with source maps…");
  const build = Bun.spawnSync(["bunx", "vite", "build", "--sourcemap", "--outDir", outDir, "--emptyOutDir"], {
    cwd: webDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = `${build.stdout.toString()}\n${build.stderr.toString()}`;
  if (build.exitCode !== 0) {
    console.error(log);
    throw new CheckFailed("apps/web didn't build (output above). Fix the build, then run this again.");
  }

  const files = await listFiles(outDir);
  const mapFiles = files.filter((f) => f.endsWith(".map"));
  if (mapFiles.length === 0) {
    throw new CheckFailed("The build wrote no source maps, so there's no way to see what went in.");
  }

  const maps = await Promise.all(
    mapFiles.map(async (mapPath) => ({
      mapPath,
      map: JSON.parse(await readFile(mapPath, "utf8")) as SourceMapLike,
    })),
  );
  // Vite's own warnings name the importing file, so they go first.
  const violations = [...externalizedFromLog(log, repoRoot), ...checkSourceMaps(maps, repoRoot)];

  const knownKeys = await loadConfiguredKeys(process.env);
  const secrets: SecretFinding[] = [];
  for (const file of files.filter(scannedForSecrets)) {
    const text = await readFile(file, "utf8");
    const name = toPosix(relative(outDir, file));
    if (CODE.has(extname(file))) {
      for (const spec of findBuiltinImports(text)) {
        violations.push({ rule: `Emitted code still imports "${spec}".`, source: name });
      }
    }
    secrets.push(...scanForSecrets(name, text, knownKeys));
  }

  if (violations.length === 0 && secrets.length === 0) {
    const modules = new Set(maps.flatMap((m) => m.map.sources ?? [])).size;
    return `Bundle check passed: ${modules} modules, no server code, no keys.`;
  }
  throw new CheckFailed(formatReport(violations, secrets));
}

export function formatReport(violations: SourceViolation[], secrets: SecretFinding[]): string {
  const lines: string[] = [];
  if (violations.length > 0) {
    lines.push("Server-only code is in the web bundle:");
    const byRule = new Map<string, string[]>();
    for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v.source]);
    for (const [rule, sources] of byRule) {
      lines.push(`  ${rule}`);
      for (const s of sources.slice(0, 10)) lines.push(`    ${s}`);
      if (sources.length > 10) lines.push(`    and ${sources.length - 10} more`);
    }
    lines.push("", "Run `bun run lint` to find the import that pulled it in.");
  }
  if (secrets.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Something that looks like a key is in the web bundle:");
    for (const s of secrets) lines.push(`  ${s.file}:${s.line}:${s.column}  ${s.kind}  ${s.preview}`);
    lines.push(
      "",
      "Keys belong on the server only. If a real key leaked, revoke it with the company that issued it.",
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const outDir = await mkdtemp(join(tmpdir(), "openfield-bundle-"));
  try {
    console.log(await run(resolve(import.meta.dir, ".."), outDir));
  } catch (err) {
    if (!(err instanceof CheckFailed)) throw err;
    console.error(`\nBundle check failed.\n\n${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
