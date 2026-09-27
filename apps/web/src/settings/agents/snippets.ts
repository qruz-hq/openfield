import { AGENT_KEY_PREFIX, type AgentsStatus } from "@openfield/core";

// What each app needs to connect, built from the real address, key and command, in each app's own
// format (checked against their docs, September 2026):
// - Claude Code: `claude mcp add --transport http … --header "Authorization: Bearer …"`, user scope
//   so Openfield is there in every project.
// - Claude Desktop: claude_desktop_config.json, which only starts programs: the stdio bridge.
// - Cursor: ~/.cursor/mcp.json, a remote server with `url` and `headers`.
// - Codex: ~/.codex/config.toml, [mcp_servers.<name>] with command and args: the stdio bridge.
// Each snippet comes twice: with the key hidden, to show, and whole, to copy.

export const AGENT_APPS = ["claude-code", "claude-desktop", "cursor", "codex", "other"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

export interface Snippet {
  shown: string;
  copied: string;
  /** Whether the key is in it. The stdio bridge reads it from the library folder instead. */
  hasKey: boolean;
}

type Target = Pick<AgentsStatus, "endpoint" | "key" | "launch">;

/** "of_ag_••••••••9kF3": enough to tell keys apart, never enough to use. */
export function maskKey(key: string): string {
  return `${AGENT_KEY_PREFIX}${"•".repeat(8)}${key.slice(-4)}`;
}

export function snippetFor(app: AgentApp, target: Target): Snippet {
  const key = target.key ?? "";
  const build = (k: string) => text(app, target, k);
  const hasKey = app === "claude-code" || app === "cursor" || app === "other";
  return { shown: build(key ? maskKey(key) : key), copied: build(key), hasKey };
}

function text(app: AgentApp, { endpoint, launch }: Target, key: string): string {
  const env = Object.keys(launch.env).length > 0 ? launch.env : undefined;
  switch (app) {
    case "claude-code":
      return `claude mcp add --transport http --scope user openfield ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`;
    case "claude-desktop":
      return json({
        mcpServers: { openfield: { command: launch.command, args: launch.args, ...(env && { env }) } },
      });
    case "cursor":
      return json({
        mcpServers: { openfield: { url: endpoint, headers: { Authorization: `Bearer ${key}` } } },
      });
    case "codex":
      return [
        "[mcp_servers.openfield]",
        `command = ${toml(launch.command)}`,
        `args = [${launch.args.map(toml).join(", ")}]`,
        ...(env
          ? [
              `env = { ${Object.entries(env)
                .map(([name, value]) => `${name} = ${toml(value)}`)
                .join(", ")} }`,
            ]
          : []),
      ].join("\n");
    case "other":
      return [
        `Address  ${endpoint}`,
        `Header   Authorization: Bearer ${key}`,
        `Command  ${commandLine(launch)}`,
      ].join("\n");
  }
}

/** Two-space JSON, with lists of words kept on one line as people write them ("args": [...]). */
const json = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(
    /\[\n\s*((?:"(?:[^"\\]|\\.)*",?\n\s*)+)\]/g,
    (_all, items: string) =>
      `[${items
        .trim()
        .split(/,\n\s*/)
        .join(", ")}]`,
  );
/** TOML basic strings escape like JSON's. */
const toml = (value: string) => JSON.stringify(value);
/** A word a shell reads as is: quoted only when it has to be. */
const shell = (value: string) =>
  /^[\w./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

function commandLine(launch: Target["launch"]): string {
  const env = Object.entries(launch.env).map(([name, value]) => `${name}=${shell(value)}`);
  return [...env, ...[launch.command, ...launch.args].map(shell)].join(" ");
}
