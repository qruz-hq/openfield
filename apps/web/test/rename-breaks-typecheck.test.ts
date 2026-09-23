// biome-ignore-all lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// M0-11a: renaming a field in a core response schema must break apps/web's typecheck, in the web
// code that reads it. The probe copies core, renames `nextCursor` in the assets list response,
// and type-checks apps/web against the copy. The same probe with no rename must pass first, so a
// broken setup can't pass as a broken build.

const web = join(import.meta.dir, "..");
const repo = join(web, "../..");
const core = join(repo, "packages/core");
const tsc = join(repo, "node_modules/.bin/tsc");

// Inside apps/web/node_modules, so React, Vite and Bun types resolve exactly as they do for apps/web.
const cacheDir = join(web, "node_modules/.cache");
mkdirSync(cacheDir, { recursive: true });
const probe = mkdtempSync(join(cacheDir, "rename-probe-"));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

function writeProbe() {
  cpSync(join(core, "src"), join(probe, "core/src"), { recursive: true });
  // zod and ulid resolve through the real install, so every copy of their types is the same one.
  symlinkSync(join(core, "node_modules"), join(probe, "core/node_modules"), "dir");

  const exports = JSON.parse(readFileSync(join(core, "package.json"), "utf8")).exports as Record<
    string,
    string
  >;
  const paths = Object.fromEntries(
    Object.entries(exports).map(([sub, file]) => [
      `@openfield/core${sub.slice(1)}`,
      [join(probe, "core", file)],
    ]),
  );
  writeFileSync(
    join(probe, "tsconfig.json"),
    JSON.stringify({
      extends: join(web, "tsconfig.json"),
      compilerOptions: { paths },
      include: [join(web, "src")],
    }),
  );
}

function typecheck(): { code: number; output: string } {
  const run = Bun.spawnSync([tsc, "-p", join(probe, "tsconfig.json"), "--pretty", "false"], { cwd: web });
  return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
}

test(
  "renaming a core response field breaks apps/web's typecheck",
  () => {
    writeProbe();
    const control = typecheck();
    expect(control.output).toBe("");
    expect(control.code).toBe(0);

    const schema = join(probe, "core/src/schemas/asset.ts");
    const source = readFileSync(schema, "utf8");
    const field = "  nextCursor: cursorSchema.nullable(),\n});\n\n/** GET /api/assets/:id */";
    expect(source).toContain(field);
    writeFileSync(schema, source.replace(field, field.replace("nextCursor", "nextPage")));

    const renamed = typecheck();
    expect(renamed.code).not.toBe(0);
    // The feed's pager reads nextCursor off the typed client's response.
    expect(renamed.output).toMatch(
      /src\/api\/hooks\/assets\.ts\(\d+,\d+\): error TS2339: Property 'nextCursor'/,
    );
  },
  { timeout: 60_000 },
);
