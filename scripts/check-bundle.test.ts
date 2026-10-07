import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkSourceMaps,
  classifySource,
  externalizedFromLog,
  findBuiltinImports,
  formatReport,
  loadConfiguredKeys,
  repoPath,
  scanForSecrets,
  scannedForSecrets,
} from "./check-bundle";

const repoRoot = resolve("/work/openfield");
const mapPath = resolve("/tmp/openfield-bundle-x/assets/index-abc.js.map");

// Vite writes sources relative to the map file, so a temp outDir yields long ../ chains.
const fromMap = (repoRel: string) => relative(dirname(mapPath), join(repoRoot, repoRel));

const check = (...repoRels: string[]) =>
  checkSourceMaps([{ mapPath, map: { sources: repoRels.map(fromMap) } }], repoRoot);

describe("source map check", () => {
  test("browser-safe modules pass", () => {
    expect(
      check(
        "apps/web/src/main.tsx",
        "packages/ui/src/button.tsx",
        "packages/core/src/schemas/manifest.ts",
        "packages/providers/src/manifest.ts",
        "packages/providers/src/manifest/estimate.ts",
        "packages/providers/src/types/provider.ts",
        "node_modules/.bun/react@19.3.0/node_modules/react/index.js",
      ),
    ).toEqual([]);
  });

  test("flags db, server, the providers server entry and adapters", () => {
    const found = check(
      "packages/db/src/index.ts",
      "apps/server/src/app.ts",
      "packages/providers/src/server.ts",
      "packages/providers/src/google/index.ts",
      "packages/providers/src/registry.ts",
    );
    expect(found.map((v) => v.source)).toEqual([
      "packages/db/src/index.ts",
      "apps/server/src/app.ts",
      "packages/providers/src/server.ts",
      "packages/providers/src/google/index.ts",
      "packages/providers/src/registry.ts",
    ]);
    expect(found[3]?.rule).toContain('"google" adapter');
  });

  test("flags server-only packages from node_modules", () => {
    const found = check("node_modules/.bun/drizzle-orm@0.45.3/node_modules/drizzle-orm/index.js");
    expect(found[0]?.rule).toContain("drizzle-orm");
  });

  test("flags Vite's stub for Node and Bun built-ins", () => {
    const found = check("apps/web/__vite-browser-external");
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toContain("built-in");
  });

  test("flags raw bun: and node: sources", () => {
    const found = checkSourceMaps([{ mapPath, map: { sources: ["node:fs", "bun:sqlite"] } }], repoRoot);
    expect(found).toHaveLength(2);
  });

  test("honours sourceRoot", () => {
    const sourceRoot = relative(dirname(mapPath), join(repoRoot, "packages"));
    const found = checkSourceMaps(
      [{ mapPath, map: { sourceRoot, sources: ["db/src/schema/assets.ts"] } }],
      repoRoot,
    );
    expect(found[0]?.source).toBe("packages/db/src/schema/assets.ts");
  });

  test("maps symlinked workspace paths back to their folder", () => {
    expect(repoPath(join(repoRoot, "apps/web/node_modules/@openfield/db/src/index.ts"), repoRoot)).toBe(
      "packages/db/src/index.ts",
    );
    expect(classifySource("x", "packages/db/src/index.ts")).not.toBeNull();
  });

  test("reports each module once across maps", () => {
    const map = { sources: [fromMap("packages/db/src/index.ts")] };
    expect(
      checkSourceMaps(
        [
          { mapPath, map },
          { mapPath, map },
        ],
        repoRoot,
      ),
    ).toHaveLength(1);
  });
});

describe("built-in imports", () => {
  test("reads Vite's externalized warnings", () => {
    const log = `[plugin rolldown:vite-resolve] Module "bun:sqlite" has been externalized for browser compatibility, imported by "${join(repoRoot, "apps/web/src/db.ts")}". See …`;
    expect(externalizedFromLog(log, repoRoot)).toEqual([
      { rule: 'Imports "bun:sqlite", which only exists on the server.', source: "apps/web/src/db.ts" },
    ]);
  });

  test("finds specifiers left in emitted code", () => {
    const code = 'import"node:fs";import{Database as e}from"bun:sqlite";const t=await import("node:path");';
    expect(findBuiltinImports(code)).toEqual(["node:fs", "bun:sqlite", "node:path"]);
  });

  test("ignores the same text outside an import", () => {
    expect(findBuiltinImports('const msg="node:fs is not available"')).toEqual([]);
  });
});

describe("secret scan", () => {
  const google = `AIza${"A1b2C3d4E5".repeat(3)}xyz12`;
  const openai = `sk-proj-${"Ab12Cd34Ef".repeat(3)}`;

  test("finds key-shaped strings and never prints them whole", () => {
    const text = `const a="${google}";\nconst b="${openai}";`;
    const found = scanForSecrets("assets/index.js", text);
    expect(found.map((f) => [f.kind, f.line])).toEqual([
      ["Google API key", 1],
      ["OpenAI API key", 2],
    ]);
    for (const f of found) {
      expect(f.preview).not.toContain(google);
      expect(f.preview).not.toContain(openai);
    }
  });

  test("finds Google's newer AQ. keys too, without flagging minified property access", () => {
    const aq = "AQ.Xy7FakeTmZ0xq-4F_w9TtY2kPz1QbV7cD3eH5jK8mN0pR";
    const found = scanForSecrets("assets/index.js", `const k="${aq}";`);
    expect(found.map((f) => f.kind)).toEqual(["Google API key"]);
    expect(found[0]?.preview).not.toContain(aq);
    expect(scanForSecrets("a.js", `x=${aq}`)).toHaveLength(1);
    // Mangled names and long property names are ordinary code.
    expect(
      scanForSecrets("a.js", "const r=AQ.getBoundingClientRectangles();AQ.addEventListenerOptions"),
    ).toEqual([]);
    expect(scanForSecrets("a.js", `obj.AQ.${"a1".repeat(15)}`)).toEqual([]);
    expect(scanForSecrets("a.js", `url(data:image/png;base64,iVBOR${aq}Qm9v)`)).toEqual([]);
  });

  test("finds literal x-goog-api-key values and bearer tokens", () => {
    expect(scanForSecrets("a.js", 'fetch(u,{headers:{"x-goog-api-key":"abcdefgh12345678"}})')).toHaveLength(
      1,
    );
    expect(scanForSecrets("a.js", 'h.set("Authorization","Bearer abcdefghijklmnopqrstuvwx")')).toHaveLength(
      1,
    );
  });

  test("finds a literal Higgsfield Key header value", () => {
    const found = scanForSecrets("a.js", 'h.set("authorization","Key abcd1234-ef56:secretsecretsecret")');
    expect(found.map((f) => f.kind)).toEqual(["Higgsfield key header value"]);
  });

  test("ignores key-like runs inside base64 data", () => {
    const data = `url(data:image/png;base64,iVBOR${google}Qm9vaw==)`;
    expect(scanForSecrets("a.css", data)).toEqual([]);
  });

  test("leaves ordinary code alone", () => {
    const code = `const h={"x-goog-api-key":e};const a=\`Bearer \${t}\`;const c="task-list-item-container-wide";const k=\`Key \${key}\`;const l="API Key settings for this company";`;
    expect(scanForSecrets("a.js", code)).toEqual([]);
  });

  test("finds keys configured on this machine", async () => {
    const keys = await loadConfiguredKeys({
      OPENFIELD_HOME: "/nonexistent/openfield-home",
      OPENAI_API_KEY: "local-key-value-123",
      ARK_API_KEY: "local-ark-value-456",
      OPENFIELD_HIGGSFIELD_API_KEY: "local-hf-value-789",
      HF_KEY: "hugging-face-token-000",
      HOME: "/home/x",
    });
    expect(keys).toEqual([
      { label: "OPENAI_API_KEY", value: "local-key-value-123" },
      { label: "ARK_API_KEY", value: "local-ark-value-456" },
      { label: "OPENFIELD_HIGGSFIELD_API_KEY", value: "local-hf-value-789" },
    ]);
    const found = scanForSecrets("a.js", 'x="local-key-value-123"', keys);
    expect(found[0]?.kind).toBe("Your key from OPENAI_API_KEY");
  });

  test("reads keys saved in config.json, skipping addresses", async () => {
    const home = await mkdtemp(join(tmpdir(), "openfield-home-"));
    try {
      const providers = {
        google: { apiKey: "saved-google-key-1" },
        openai: { baseUrl: "https://proxy.example" },
      };
      await writeFile(join(home, "config.json"), JSON.stringify({ version: 1, providers }));
      expect(await loadConfiguredKeys({ OPENFIELD_HOME: home })).toEqual([
        { label: "Settings (google.apiKey)", value: "saved-google-key-1" },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("scans source maps and copied public files, skipping only images and fonts", () => {
    for (const file of ["assets/index.js.map", "config.json", "icon.svg", "robots.txt", "app.webmanifest"]) {
      expect(scannedForSecrets(file)).toBe(true);
    }
    for (const file of ["logo.PNG", "fonts/inter.woff2"]) expect(scannedForSecrets(file)).toBe(false);
  });

  test("finds a key left in a source map's source text", () => {
    const key = `AIza${"S".repeat(35)}`;
    const map = JSON.stringify({ sources: ["a.ts"], sourcesContent: [`// temp key: ${key}\nexport {}`] });
    expect(scanForSecrets("assets/index.js.map", map)).toHaveLength(1);
  });

  test("the report names the rule, the module and the location", () => {
    const report = formatReport(
      [{ rule: "packages/db is server-only (§0.16 rule 4).", source: "packages/db/src/index.ts" }],
      [{ file: "assets/index.js", line: 1, column: 5, kind: "Google API key", preview: "AIza… (39 chars)" }],
    );
    expect(report).toContain("packages/db/src/index.ts");
    expect(report).toContain("assets/index.js:1:5  Google API key  AIza… (39 chars)");
  });
});
