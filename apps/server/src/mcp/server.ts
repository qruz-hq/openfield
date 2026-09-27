import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "../context";
import { INSTRUCTIONS } from "./instructions";
import type { AgentSession, ToolContext } from "./kit";
import { registerResources } from "./resources";
import { accountTools } from "./tools/account";
import { folderTools } from "./tools/folders";
import { generateTools } from "./tools/generate";
import { libraryTools } from "./tools/library";
import { modelTools } from "./tools/models";
import { runTools } from "./tools/runs";

// One MCP server per connected app. Tools come in groups; the canvas group joins this list.

export type ToolGroup = (server: McpServer, ctx: ToolContext) => void;

export const TOOL_GROUPS: readonly ToolGroup[] = [
  modelTools,
  generateTools,
  runTools,
  libraryTools,
  folderTools,
  accountTools,
];

export function createMcpServer(svc: Services, session: AgentSession): McpServer {
  const server = new McpServer(
    { name: "openfield", title: "Openfield", version: svc.version },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { svc, session };
  for (const group of TOOL_GROUPS) group(server, ctx);
  registerResources(server, ctx);
  return server;
}
