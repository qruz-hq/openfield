import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_ACTIONS, type AgentAction, type AgentDefaultRule } from "@openfield/core";
import { z } from "zod";
import { type Extra, refuse, type ToolContext } from "./kit";

// What agents may do (Settings > Agents): every tool call counts as one or more actions, and each
// action is Allow, Ask or Default. Ask checks with the person in the agent's own app (an MCP
// elicitation, a yes or no prompt). An app that can't show one gets a refusal that tells the agent
// to ask in its chat and call again with confirm: true. Making images and running canvases ask with
// the price, in the tools themselves (guard.ts), so the person sees what it costs.

/** How long the person has to answer a prompt in the app. */
const ASK_TIMEOUT_MS = 10 * 60_000;

/** What each action is, for a prompt: "Claude Code wants to delete a canvas." */
const VERBS: Record<AgentAction, string> = {
  see_models: "look at your models and prices",
  read_canvases: "read your canvases",
  read_images: "search and look at your images",
  read_spending: "look at your spending and settings",
  make_canvases: "make a canvas",
  change_canvases: "change a canvas",
  versions: "save or restore a canvas version",
  show: "open something in your Openfield tab",
  make_images: "make images",
  run_canvases: "run a canvas",
  stop_runs: "stop a run",
  import_images: "bring an image into your library",
  file_images: "favourite or file images",
  folders: "make or change folders",
  remove_nodes: "remove nodes from a canvas",
  trash_images: "move images to the Trash",
  delete_folders: "delete a folder",
  delete_canvases: "delete a canvas",
};

const TOOLS: Record<string, AgentAction> = {
  list_models: "see_models",
  estimate: "see_models",
  list_canvases: "read_canvases",
  get_canvas: "read_canvases",
  list_versions: "read_canvases",
  list_node_types: "read_canvases",
  get_run: "read_canvases",
  get_active_canvas: "read_canvases",
  search_assets: "read_images",
  get_asset: "read_images",
  view_asset: "read_images",
  get_job: "read_images",
  wait_for: "read_images",
  list_folders: "read_images",
  get_usage: "read_spending",
  get_settings: "read_spending",
  create_canvas: "make_canvases",
  duplicate_canvas: "make_canvases",
  edit_canvas: "change_canvases",
  add_nodes: "change_canvases",
  connect: "change_canvases",
  update_node: "change_canvases",
  move_node: "change_canvases",
  rename_canvas: "change_canvases",
  save_version: "versions",
  restore_version: "versions",
  show: "show",
  generate_image: "make_images",
  recreate: "make_images",
  run_canvas: "run_canvases",
  cancel_job: "stop_runs",
  stop_run: "stop_runs",
  import_image: "import_images",
  update_assets: "file_images",
  create_folder: "folders",
  update_folder: "folders",
  delete_nodes: "remove_nodes",
  delete_folder: "delete_folders",
  delete_canvas: "delete_canvases",
};

/** The actions a call counts as. A batch of edits that removes nodes is a removal too. */
export function actionsFor(tool: string, args: Record<string, unknown>): AgentAction[] {
  if (tool === "update_assets") {
    const filing =
      args.favourite !== undefined || !!args.addToFolder || !!args.removeFromFolder || !!args.restore;
    const actions: AgentAction[] = [];
    if (filing || args.trash !== true) actions.push("file_images");
    if (args.trash === true) actions.push("trash_images");
    return actions;
  }
  const main = TOOLS[tool];
  if (!main) return [];
  const removes =
    tool === "edit_canvas" &&
    Array.isArray(args.edits) &&
    args.edits.some((e) => (e as { op?: unknown }).op === "remove_nodes");
  return removes ? [main, "remove_nodes"] : [main];
}

/** What the person chose for an action, with Default read as its rule. */
export function decide(ctx: ToolContext, action: AgentAction): AgentDefaultRule {
  const chosen = ctx.svc.settings.get().agentPermissions[action] ?? "default";
  return chosen === "default" ? AGENT_ACTIONS[action].rule : chosen;
}

export type Answer = "yes" | "no" | "cant";

/** Asks the person in the agent's app. "cant" when the app can't show a prompt. */
export async function askPerson(ctx: ToolContext, extra: Extra, message: string): Promise<Answer> {
  if (!ctx.session.canAsk) return "cant";
  try {
    const result = await extra.sendRequest(
      {
        method: "elicitation/create",
        params: { message, requestedSchema: { type: "object", properties: {} } },
      },
      ElicitResultSchema,
      { timeout: ASK_TIMEOUT_MS },
    );
    return result.action === "accept" ? "yes" : "no";
  } catch {
    // No answer in time, or the prompt couldn't be shown: not a yes.
    return "no";
  }
}

export const saidNo = (ctx: ToolContext) =>
  refuse(`The person said no in ${ctx.session.client}. Nothing was done. Don't try again unless they ask.`);

export const confirmField = z
  .boolean()
  .optional()
  .describe(
    "Only when Openfield asked you to: the person agreed in your chat to this exact action. Openfield asks them itself when your app can show a prompt.",
  );

/** Null to go ahead, or what to answer instead. Spending actions are left to the tools. */
async function permit(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  extra: Extra,
): Promise<CallToolResult | null> {
  // Spending asks with the price, in the tool: never twice.
  const asks = actionsFor(tool, args).filter(
    (a) => AGENT_ACTIONS[a].rule !== "spend" && decide(ctx, a) === "ask",
  );
  if (!asks.length) return null;
  const what = asks.map((a) => VERBS[a]).join(" and ");
  const answer = await askPerson(ctx, extra, `${ctx.session.client} wants to ${what}. Allow it?`);
  if (answer === "yes") return null;
  if (answer === "no") return saidNo(ctx);
  if (args.confirm === true) return null;
  return refuse(
    `The person asked Openfield to check with them before an agent can ${what}. Ask them in your chat. If they agree, call ${tool} again with the same arguments and confirm: true.`,
  );
}

/**
 * Every tool gets `confirm` and the permission check, added as it's registered, so a tool can't
 * be left out.
 */
export function withPermissions(server: McpServer, ctx: ToolContext): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: { inputSchema?: Record<string, z.ZodType> } & Record<string, unknown>,
    cb: (args: Record<string, unknown>, extra: Extra) => Promise<CallToolResult>,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(
      name,
      { ...config, inputSchema: { ...config.inputSchema, confirm: confirmField } },
      async (args, extra) => {
        const stop = await permit(ctx, name, args, extra);
        return stop ?? cb(args, extra);
      },
    );
}
