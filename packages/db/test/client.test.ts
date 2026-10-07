import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationsFolder } from "../src/client";

// The desktop app ships the migrations beside its compiled server and says where with
// OPENFIELD_MIGRATIONS_DIR. Without it, nothing changes.

const CLIENT = join(import.meta.dir, "../src/client.ts");

/** Opens a fresh database in a child process, so the folder is read the way a real boot reads it. */
async function openWith(env: Record<string, string>): Promise<{ code: number; out: string }> {
  const script = `const { openDb } = await import(${JSON.stringify(CLIENT)});
try { const o = openDb(":memory:"); console.log("tag=" + o.schemaTag); o.close(); }
catch (e) { console.log("failed=" + e.name); process.exit(3); }`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, OPENFIELD_MIGRATIONS_DIR: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

describe("migrationsFolder", () => {
  test("defaults to the package's own folder", () => {
    expect(migrationsFolder({})).toBe(join(import.meta.dir, "../migrations"));
    expect(migrationsFolder({ OPENFIELD_MIGRATIONS_DIR: "  " })).toBe(join(import.meta.dir, "../migrations"));
  });

  test("OPENFIELD_MIGRATIONS_DIR points it elsewhere", () => {
    expect(migrationsFolder({ OPENFIELD_MIGRATIONS_DIR: "/opt/openfield/migrations" })).toBe(
      "/opt/openfield/migrations",
    );
  });

  test("a boot migrates from the folder it's pointed at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openfield-migrations-"));
    try {
      cpSync(migrationsFolder({}), join(dir, "copy"), { recursive: true });
      const copied = await openWith({ OPENFIELD_MIGRATIONS_DIR: join(dir, "copy") });
      expect(copied.out).toMatch(/^tag=\d{4}_\w+/);
      const missing = await openWith({ OPENFIELD_MIGRATIONS_DIR: join(dir, "nowhere") });
      expect(missing.code).toBe(3);
      expect(missing.out).toContain("failed=MigrationError");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
