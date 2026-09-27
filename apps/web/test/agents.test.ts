// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { AGENT_APPS, maskKey, snippetFor } from "../src/settings/agents/snippets";

// Settings > Agents' snippets: each app's own format, the key hidden when shown and whole when
// copied, and paths with spaces kept intact.

const KEY = "of_ag_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const target = {
  endpoint: "http://127.0.0.1:4317/mcp",
  key: KEY,
  launch: {
    command: "/Users/mara/.bun/bin/bun",
    args: ["run", "--silent", "--cwd", "/Users/mara/My Code/openfield", "mcp"],
    env: {},
  },
};

describe("agent snippets", () => {
  test("the key shows only its end, and copies whole", () => {
    expect(maskKey(KEY)).toBe("of_ag_••••••••ABCD");
    for (const app of AGENT_APPS) {
      const snippet = snippetFor(app, target);
      expect(snippet.shown).not.toContain(KEY);
      expect(snippet.copied.includes(KEY)).toBe(snippet.hasKey);
    }
  });

  test("Claude Code adds an HTTP server for every project, with the key as a header", () => {
    expect(snippetFor("claude-code", target).copied).toBe(
      `claude mcp add --transport http --scope user openfield http://127.0.0.1:4317/mcp \\\n  --header "Authorization: Bearer ${KEY}"`,
    );
  });

  test("Claude Desktop and Codex start the bridge; Cursor connects over HTTP", () => {
    const desktop = snippetFor("claude-desktop", target).copied;
    expect(JSON.parse(desktop)).toEqual({
      mcpServers: { openfield: { command: target.launch.command, args: target.launch.args } },
    });
    expect(desktop).toContain('"args": ["run", "--silent", "--cwd", "/Users/mara/My Code/openfield", "mcp"]');

    expect(JSON.parse(snippetFor("cursor", target).copied)).toEqual({
      mcpServers: { openfield: { url: target.endpoint, headers: { Authorization: `Bearer ${KEY}` } } },
    });

    const withHome = {
      ...target,
      launch: { ...target.launch, env: { OPENFIELD_HOME: "/Volumes/Art/openfield" } },
    };
    expect(snippetFor("codex", withHome).copied).toBe(
      [
        "[mcp_servers.openfield]",
        'command = "/Users/mara/.bun/bin/bun"',
        'args = ["run", "--silent", "--cwd", "/Users/mara/My Code/openfield", "mcp"]',
        'env = { OPENFIELD_HOME = "/Volumes/Art/openfield" }',
      ].join("\n"),
    );
    expect(JSON.parse(snippetFor("claude-desktop", withHome).copied).mcpServers.openfield.env).toEqual({
      OPENFIELD_HOME: "/Volumes/Art/openfield",
    });
  });

  test("other apps get the address, the header and a command a shell reads right", () => {
    expect(snippetFor("other", target).copied).toBe(
      [
        "Address  http://127.0.0.1:4317/mcp",
        `Header   Authorization: Bearer ${KEY}`,
        "Command  /Users/mara/.bun/bin/bun run --silent --cwd '/Users/mara/My Code/openfield' mcp",
      ].join("\n"),
    );
  });
});
