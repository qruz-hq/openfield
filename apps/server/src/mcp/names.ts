// What each agent app calls itself when it connects (initialize.clientInfo.name), and the name a
// person knows it by. The name is shown in Settings > Agents, on the canvas and in Spending.

const KNOWN: readonly [RegExp, string][] = [
  [/^claude-code/i, "Claude Code"],
  [/^claude-ai$|^claude[- ]desktop/i, "Claude Desktop"],
  [/cursor/i, "Cursor"],
  [/codex/i, "Codex"],
  [/windsurf/i, "Windsurf"],
  [/^visual studio code|^vscode|copilot/i, "VS Code"],
  [/^zed/i, "Zed"],
  [/inspector/i, "MCP Inspector"],
];

const MAX_NAME = 40;

export function clientDisplayName(raw: string | undefined): string {
  // Printable characters only: the name is stored with each run and shown in the app.
  const name = (raw ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  if (!name) return "An agent";
  for (const [pattern, known] of KNOWN) if (pattern.test(name)) return known;
  const words = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ").slice(0, MAX_NAME);
}
