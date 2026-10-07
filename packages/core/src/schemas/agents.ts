import { z } from "zod";
import { timestampSchema, usdSchema } from "./common";

// Settings > Agents: apps like Claude Code connect to the running server and use Openfield for the
// person (docs/agents.md). The limits live in settings (agentAskAboveUsd, agentDailyCapUsd); this
// is the rest of the pane.

/** Every agent key starts with this, so a key pasted in the wrong place is easy to spot. */
export const AGENT_KEY_PREFIX = "of_ag_";

export const agentSpendSchema = z.object({
  usd: usdSchema,
  images: z.int().nonnegative(),
});

/** An app that connected since Openfield started, or that made something today. */
export const agentClientSchema = z.object({
  /** As the app names itself, tidied: "Claude Code", "Claude Desktop", "Cursor". */
  name: z.string(),
  /** Null when it only shows up in today's spending, from before this start. */
  lastSeenAt: timestampSchema.nullable(),
  /** Connected and used within the last minute. */
  active: z.boolean(),
  today: agentSpendSchema,
});

/** How an app that can only start programs reaches Openfield: `bun run --cwd <repo> mcp`. */
export const agentLaunchSchema = z.object({
  /** The bun that runs this server, by full path: desktop apps don't see the shell's PATH. */
  command: z.string(),
  args: z.array(z.string()),
  /** Only what differs from the defaults, such as OPENFIELD_HOME. */
  env: z.record(z.string(), z.string()),
  /**
   * The desktop app is running from somewhere that goes away (the disk image, or a copy macOS made
   * because it wasn't moved to Applications), so this command will stop working.
   */
  temporary: z.boolean().optional(),
});

/** GET /api/agents, and the reply to every change on it. */
export const agentsStatusSchema = z.object({
  enabled: z.boolean(),
  /** The whole key, for Copy. Null until agents are turned on the first time. */
  key: z.string().nullable(),
  /** Where apps that speak HTTP connect: http://127.0.0.1:4317/mcp. */
  endpoint: z.url(),
  launch: agentLaunchSchema,
  /** Spent by agents since local midnight, runs still going included at their estimate. */
  today: agentSpendSchema,
  clients: z.array(agentClientSchema),
});

/** PUT /api/agents. Turning agents on the first time makes the key. */
export const agentsPutBodySchema = z.object({ enabled: z.boolean() });

export type AgentSpend = z.infer<typeof agentSpendSchema>;
export type AgentClient = z.infer<typeof agentClientSchema>;
export type AgentLaunch = z.infer<typeof agentLaunchSchema>;
export type AgentsStatus = z.infer<typeof agentsStatusSchema>;
export type AgentsPutBody = z.infer<typeof agentsPutBodySchema>;

// What agents may do (Settings > Agents): each action is Allow (never asks), Ask (checks with the
// person in the agent's app every time) or Default (the rule below). The daily limit applies to
// everything that spends, whatever the setting.

export const AGENT_PERMISSIONS = ["allow", "ask", "default"] as const;
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/** What Default means for an action: always allowed, always asks, or asks above the amount set. */
export type AgentDefaultRule = "allow" | "ask" | "spend";

export const AGENT_ACTION_GROUPS = ["look", "build", "images", "organise", "delete"] as const;
export type AgentActionGroup = (typeof AGENT_ACTION_GROUPS)[number];

export const AGENT_ACTION_IDS = [
  "see_models",
  "read_canvases",
  "read_images",
  "read_spending",
  "make_canvases",
  "change_canvases",
  "versions",
  "show",
  "make_images",
  "run_canvases",
  "stop_runs",
  "import_images",
  "file_images",
  "folders",
  "remove_nodes",
  "trash_images",
  "delete_folders",
  "delete_canvases",
] as const;
export type AgentAction = (typeof AGENT_ACTION_IDS)[number];

/** Each action's group and Default rule, in the order Settings lists them. */
export const AGENT_ACTIONS: Record<AgentAction, { group: AgentActionGroup; rule: AgentDefaultRule }> = {
  see_models: { group: "look", rule: "allow" },
  read_canvases: { group: "look", rule: "allow" },
  read_images: { group: "look", rule: "allow" },
  read_spending: { group: "look", rule: "allow" },
  make_canvases: { group: "build", rule: "allow" },
  change_canvases: { group: "build", rule: "allow" },
  versions: { group: "build", rule: "allow" },
  show: { group: "build", rule: "allow" },
  make_images: { group: "images", rule: "spend" },
  run_canvases: { group: "images", rule: "spend" },
  stop_runs: { group: "images", rule: "allow" },
  import_images: { group: "organise", rule: "allow" },
  file_images: { group: "organise", rule: "allow" },
  folders: { group: "organise", rule: "allow" },
  remove_nodes: { group: "delete", rule: "allow" },
  trash_images: { group: "delete", rule: "allow" },
  delete_folders: { group: "delete", rule: "ask" },
  delete_canvases: { group: "delete", rule: "ask" },
};

/** settings.agentPermissions: only the actions set to something other than Default. */
export const agentPermissionsSchema = z.partialRecord(z.enum(AGENT_ACTION_IDS), z.enum(AGENT_PERMISSIONS));
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
