import { z } from "zod";
import { canvasEditsSchema, canvasWireOpSchema } from "../canvas/ops";
import { localIdSchema } from "../canvas/schema";
import { AGENT_ACTIVITY_KINDS, CANVAS_MAX_NODES, CANVAS_RUN_SCOPES } from "../constants";
import { canvasRunNodeResultSchema } from "./canvas";
import { timestampSchema, ulidSchema } from "./common";
import { costEstimateSchema } from "./cost";

// Live canvases (§7.11): edits made on the server reach every open tab as ops, agents show up while
// they work, and one tab can be asked to open something. The editor's own saves stay PATCH (§7.8).

/** Minted by each tab, kept for its session. */
export const tabIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const agentActorSchema = z.object({
  kind: z.literal("agent"),
  /** The app's display name, such as "Claude Code". */
  name: z.string().trim().min(1).max(80),
  /** One connection of that app. A version is saved before its first change to each canvas. */
  sessionId: z.string().min(1).max(128),
});
/** Who changed a canvas. */
export const canvasActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tab"), tabId: tabIdSchema }),
  agentActorSchema,
]);

/** POST /api/canvases/:id/edits. With graphVersion, a canvas that changed since is a 409. */
export const canvasEditsBodySchema = z.object({
  edits: canvasEditsSchema,
  graphVersion: z.int().min(1).optional(),
});
export const canvasEditsResponseSchema = z.object({
  graphVersion: z.int().min(1),
  updatedAt: timestampSchema,
  /** What the edits became, as every open tab receives them. */
  ops: z.array(canvasWireOpSchema),
  /** Nodes added or changed. */
  touched: z.array(localIdSchema),
  /** Each `as` name, with the node id it got. */
  aliases: z.record(z.string(), localIdSchema),
  /** The version saved before an agent's first change to this canvas. */
  versionId: ulidSchema.nullable(),
});

/** SSE canvas.updated. Tabs holding fromVersion replay the ops and move to graphVersion. */
export const canvasUpdatedSchema = z.object({
  canvasId: ulidSchema,
  fromVersion: z.int().min(1),
  graphVersion: z.int().min(1),
  updatedAt: timestampSchema,
  ops: z.array(canvasWireOpSchema),
  touched: z.array(localIdSchema),
  actor: canvasActorSchema,
  versionId: ulidSchema.nullable(),
});

/** SSE agent.activity. */
export const agentActivitySchema = z.object({
  canvasId: ulidSchema,
  actor: agentActorSchema,
  nodeIds: z.array(localIdSchema).max(CANVAS_MAX_NODES),
  kind: z.enum(AGENT_ACTIVITY_KINDS),
  at: timestampSchema,
  /** The version saved before this session's first change here, when this is that change. */
  versionId: ulidSchema.nullable().optional(),
});

export const navigateTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("canvas"),
    id: ulidSchema,
    /** Selected and brought into view once the canvas is open. */
    nodeIds: z.array(localIdSchema).max(CANVAS_MAX_NODES).optional(),
  }),
  z.object({ kind: z.literal("asset"), id: ulidSchema }),
  /** An app path, such as /assets or /settings/spending. */
  z.object({
    kind: z.literal("path"),
    path: z
      .string()
      .regex(/^\/(?!\/)/)
      .max(512),
  }),
]);
/** SSE ui.navigate: only the tab with this id acts on it. */
export const uiNavigateSchema = z.object({ tabId: tabIdSchema, to: navigateTargetSchema });

/** POST /api/presence: where a tab is, sent on route, selection and focus changes. */
export const presenceBodySchema = z.object({
  tabId: tabIdSchema,
  path: z.string().max(2048),
  canvasId: ulidSchema.nullable(),
  selection: z.array(localIdSchema).max(CANVAS_MAX_NODES),
  focused: z.boolean(),
});
/** The tab an agent means by "the open canvas": the one focused last. */
export const activeTabSchema = z.object({
  tabId: tabIdSchema,
  path: z.string(),
  canvasId: ulidSchema.nullable(),
  selection: z.array(localIdSchema),
  focused: z.boolean(),
  /** When it last had focus. */
  focusedAt: timestampSchema.nullable(),
});

/** A server-compiled run: what a person's Run would do, asked for by scope instead of a plan. */
export const canvasRunScopeBodySchema = z.object({
  scope: z.enum(CANVAS_RUN_SCOPES),
  nodeIds: z.array(localIdSchema).max(CANVAS_MAX_NODES).default([]),
  /** Run it even when nothing changed (⌥-click). */
  bypassCache: z.boolean().optional(),
  /** A single-node run also runs the earlier nodes it needs. */
  includeUpstream: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  /** Required when the run makes more than CANVAS_CONFIRM_JOBS jobs. */
  confirmed: z.boolean().optional(),
});
export const canvasRunBlockedSchema = z.object({
  nodeId: localIdSchema,
  /** CanvasBlockReason, or a run-only reason such as upstream_failed. */
  reason: z.string(),
  /** What the node's band says, when there's something to say. */
  message: z.string().nullable(),
});
export const canvasRunScopeResponseSchema = z.object({
  /** "plan" ran (or would run); "needs_upstream" asks to run earlier nodes too; "busy" is already running. */
  outcome: z.enum(["plan", "needs_upstream", "busy", "nothing"]),
  runId: ulidSchema.nullable(),
  /** Nodes the plan covers, upstream first. */
  planned: z.array(localIdSchema),
  /** Nodes left out because nothing changed. */
  upToDate: z.array(localIdSchema),
  blocked: z.array(canvasRunBlockedSchema),
  /** needs_upstream: the earlier nodes that would run too. */
  upstream: z.array(localIdSchema),
  jobs: z.int().nonnegative(),
  estimate: costEstimateSchema,
  nodes: z.array(canvasRunNodeResultSchema),
  jobSets: z.array(z.object({ nodeId: localIdSchema, jobSetId: ulidSchema })),
});

export type AgentActor = z.infer<typeof agentActorSchema>;
export type CanvasActor = z.infer<typeof canvasActorSchema>;
export type CanvasEditsBody = z.infer<typeof canvasEditsBodySchema>;
export type CanvasEditsResponse = z.infer<typeof canvasEditsResponseSchema>;
export type CanvasUpdated = z.infer<typeof canvasUpdatedSchema>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type NavigateTarget = z.infer<typeof navigateTargetSchema>;
export type UiNavigate = z.infer<typeof uiNavigateSchema>;
export type PresenceBody = z.infer<typeof presenceBodySchema>;
export type ActiveTab = z.infer<typeof activeTabSchema>;
export type CanvasRunScopeBody = z.input<typeof canvasRunScopeBodySchema>;
export type CanvasRunBlocked = z.infer<typeof canvasRunBlockedSchema>;
export type CanvasRunScopeResponse = z.infer<typeof canvasRunScopeResponseSchema>;
