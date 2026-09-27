import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "../context";
import { INSTRUCTIONS } from "./instructions";
import type { AgentSession, ToolContext } from "./kit";
import { withPermissions } from "./permissions";
import { registerResources } from "./resources";
import { accountTools } from "./tools/account";
import { canvasTools } from "./tools/canvas";
import { canvasRunTools } from "./tools/canvas-runs";
import { folderTools } from "./tools/folders";
import { generateTools } from "./tools/generate";
import { libraryTools } from "./tools/library";
import { modelTools } from "./tools/models";
import { presenceTools } from "./tools/presence";
import { runTools } from "./tools/runs";

// One MCP server per connected app, its tools in groups.

export type ToolGroup = (server: McpServer, ctx: ToolContext) => void;

export const TOOL_GROUPS: readonly ToolGroup[] = [
  modelTools,
  generateTools,
  runTools,
  libraryTools,
  folderTools,
  canvasTools,
  canvasRunTools,
  presenceTools,
  accountTools,
];

export function createMcpServer(svc: Services, session: AgentSession): McpServer {
  const server = new McpServer(
    { name: "openfield", title: "Openfield", version: svc.version },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { svc, session };
  withPermissions(server, ctx);
  for (const group of TOOL_GROUPS) group(server, ctx);
  registerResources(server, ctx);
  return server;
}
