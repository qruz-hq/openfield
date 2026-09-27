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
