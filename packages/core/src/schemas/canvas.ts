import { z } from "zod";
import { canvasDocumentSchema, canvasOutputSchema, localIdSchema } from "../canvas/schema";
import {
  CANVAS_BLOCK_REASONS,
  CANVAS_INPUT_TARGETS,
  CANVAS_MAX_NODES,
  CANVAS_NODE_STATES,
  CANVAS_NODE_TYPES,
  CANVAS_PORT_ARITIES,
  CANVAS_PREVIEW_THEMES,
  CANVAS_RUN_MAX_JOBS,
  CANVAS_RUN_SCOPES,
  CANVAS_TEMPLATE_SOURCES,
  CANVAS_VERSION_KINDS,
} from "../constants";
import { HASH_RE } from "../hash";
import {
  errorCodeSchema,
  jobSetStateSchema,
  modelKeySchema,
  referenceRoleSchema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "./common";
import { costEstimateSchema } from "./cost";
import { errorEnvelopeSchema } from "./errors";
import { generateRequestSchema } from "./request";

// Canvas routes (§8.3). The document itself lives in ../canvas.

/** One index card. previewUrl is null above CANVAS_PREVIEW_MAX_NODES; coverAssetId is the fallback. */
export const canvasSummarySchema = z.object({
  id: ulidSchema,
  name: z.string(),
  previewUrl: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  nodeCount: z.int().nonnegative(),
  /** The newest result image still in the library. */
  coverAssetId: ulidSchema.nullable(),
  /** So the index can rename without loading the whole canvas. */
  graphVersion: z.int().min(1),
});
export const canvasesListResponseSchema = z.array(canvasSummarySchema);
/** GET /api/canvases. q filters by name. */
export const canvasesListQuerySchema = z.object({ q: z.string().trim().max(200).optional() });

/** POST /api/canvases: a blank canvas, a template, or an import (already migrated and re-id'd). */
export const canvasCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  /** Start from a bundled or saved template. */
  templateId: z.string().min(1).max(128).optional(),
  graph: canvasDocumentSchema.optional(),
});

/** GET /api/canvases/:id */
export const canvasDetailSchema = z.object({
  id: ulidSchema,
  name: z.string(),
  graph: canvasDocumentSchema,
  graphVersion: z.int().min(1),
  updatedAt: timestampSchema,
  /**
   * Images the document names that aren't in this library: a canvas from another computer, or
   * images deleted since. Nodes show a placeholder for them and runs leave them out (§7.8).
   */
  missingAssetIds: z.array(ulidSchema).optional(),
  /**
   * Pixel sizes of the images it names that are here, so an image card opens at its image's exact
   * shape instead of waiting for a thumbnail's rounded one.
   */
  assetSizes: z.record(z.string(), z.object({ w: z.int().positive(), h: z.int().positive() })).optional(),
  /** When the index card's picture was taken, so the editor knows whether it's out of date (M4-15). */
  previewAt: timestampSchema.nullable().optional(),
});

/** PATCH /api/canvases/:id. Autosave with optimistic concurrency on graphVersion. */
export const canvasPatchBodySchema = z.object({
  graph: canvasDocumentSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  graphVersion: z.int().min(1),
});
export const canvasPatchResponseSchema = z.object({
  graphVersion: z.int().min(1),
  updatedAt: timestampSchema,
});
/** 409 from PATCH: the error plus the server's copy, so the editor can offer Reload or Keep mine. */
export const canvasConflictResponseSchema = errorEnvelopeSchema.extend({ canvas: canvasDetailSchema });

// Versions (§7.8)

export const canvasVersionSchema = z.object({
  id: ulidSchema,
  label: z.string().nullable(),
  kind: z.enum(CANVAS_VERSION_KINDS),
  createdAt: timestampSchema,
  nodeCount: z.int().nonnegative(),
  edgeCount: z.int().nonnegative(),
  coverAssetId: ulidSchema.nullable(),
});
export const canvasVersionsResponseSchema = z.array(canvasVersionSchema);
/** GET /api/canvases/:id/versions/:vid, for Preview. */
export const canvasVersionDetailSchema = canvasVersionSchema.extend({ graph: canvasDocumentSchema });
/** The kinds the editor asks for. Automatic and before-restore snapshots are the server's own. */
export const CANVAS_REQUESTED_VERSION_KINDS = [
  "named",
  "before_delete",
  "before_import",
  "before_template",
] as const satisfies readonly (typeof CANVAS_VERSION_KINDS)[number][];
/** POST /api/canvases/:id/versions. kind defaults to named. */
export const canvasVersionCreateBodySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(CANVAS_REQUESTED_VERSION_KINDS).optional(),
});
export const canvasVersionParamSchema = z.object({
  id: z.string().min(1).max(128),
  vid: z.string().min(1).max(128),
});

// Runs (§7.7, §8.3)

export const canvasRunInputValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: ulidSchema }),
  /** The images an earlier plan item makes. */
  z.object({ kind: z.literal("node"), nodeId: localIdSchema, port: z.string().min(1).max(64) }),
]);
export const canvasRunInputSchema = z.object({
  port: z.string().min(1).max(64),
  to: z.enum(CANVAS_INPUT_TARGETS),
  role: referenceRoleSchema.optional(),
  /** A single input with more than one image runs the node once per image. */
  arity: z.enum(CANVAS_PORT_ARITIES),
  // As many as a run can make: a node can read everything an earlier one made.
  values: z.array(canvasRunInputValueSchema).max(CANVAS_RUN_MAX_JOBS),
});
/** One job set's settings before fan-out: a GenerateRequest minus what the server fills in. */
/** A call's caption (a Variations prompt line) is cut to this in the plan; the prompt itself isn't. */
export const CANVAS_CALL_LABEL_MAX = 200;

export const canvasRunCallSchema = generateRequestSchema
  .pick({
    model: true,
    op: true,
    prompt: true,
    negativePrompt: true,
    enhancePrompt: true,
    size: true,
    resolution: true,
    quality: true,
    batch: true,
    seed: true,
    providerOptions: true,
  })
  .extend({
    op: z.enum(["generate", "variation", "edit", "inpaint"]),
    /** Caption for this call's images, e.g. the prompt line. */
    label: z.string().max(CANVAS_CALL_LABEL_MAX).optional(),
  });
export const canvasRunPlanItemSchema = z.object({
  nodeId: localIdSchema,
  type: z.enum(CANVAS_NODE_TYPES),
  typeVersion: z.int().min(1),
  fingerprint: z.string().regex(HASH_RE),
  /** The node's main model (its first call's). */
  model: modelKeySchema,
  /** The normalized params that went into the fingerprint. Provenance only. */
  params: z.record(z.string(), z.unknown()),
  /** Image inputs only; text is already resolved into calls[].prompt. */
  inputs: z.array(canvasRunInputSchema).max(8),
  calls: z.array(canvasRunCallSchema).min(1).max(8),
  /** The node's current result, so an unchanged node is skipped. */
  cached: z
    .object({ fingerprint: z.string(), assetIds: z.array(ulidSchema).max(CANVAS_RUN_MAX_JOBS) })
    .nullable(),
  bypassCache: z.boolean().optional(),
});
/** POST /api/canvases/:id/run */
export const canvasRunBodySchema = z.object({
  scope: z.enum(CANVAS_RUN_SCOPES),
  /** What the person asked for. The plan may include upstream nodes too. */
  nodeIds: z.array(localIdSchema).max(CANVAS_MAX_NODES),
  /** Runnable nodes only, upstream first. The job cap (CANVAS_RUN_MAX_JOBS) is what limits a run. */
  plan: z.array(canvasRunPlanItemSchema).min(1).max(CANVAS_MAX_NODES),
  /** Estimate and report what would be skipped, without running anything. */
  dryRun: z.boolean().optional(),
  /** Required when the run makes more than CANVAS_CONFIRM_JOBS jobs. */
  confirmed: z.boolean().optional(),
});
/** One row of the run-all preview. */
export const canvasRunNodeResultSchema = z.object({
  nodeId: localIdSchema,
  jobs: z.int().nonnegative(),
  estimate: costEstimateSchema,
  skipped: z.boolean(),
  blocked: z.enum(CANVAS_BLOCK_REASONS).nullable(),
});
/** 201 for a run, 200 for a dry run. */
export const canvasRunResponseSchema = z.object({
  runId: ulidSchema.nullable(),
  /** Created right away. Later ones arrive on canvas_run.updated. */
  jobSets: z.array(z.object({ nodeId: localIdSchema, jobSetId: ulidSchema })),
  skipped: z.array(z.object({ nodeId: localIdSchema, reason: z.literal("cached") })),
  /** Total for what will run. */
  estimate: costEstimateSchema,
  /** Expected jobs after fan-out. */
  jobs: z.int().nonnegative(),
  nodes: z.array(canvasRunNodeResultSchema),
});
export const canvasRunErrorSchema = z.object({ code: errorCodeSchema, reason: z.string().optional() });
export const canvasRunNodeStateSchema = z.object({
  nodeId: localIdSchema,
  state: z.enum(CANVAS_NODE_STATES),
  /** As submitted: a late result compares against it. */
  fingerprint: z.string(),
  jobSetIds: z.array(ulidSchema),
  done: z.int().nonnegative(),
  total: z.int().nonnegative(),
  /** Made so far, in output order. */
  assetIds: z.array(ulidSchema),
  outputs: z.array(canvasOutputSchema),
  /** The images it read, sorted. A result keeps them, so new images upstream make it stale. */
  inputs: z.array(ulidSchema).default([]),
  costUsd: usdSchema.nullable(),
  error: canvasRunErrorSchema.nullable(),
  blocked: z.enum(CANVAS_BLOCK_REASONS).nullable(),
  /** When its first job started, so a reloaded tab's clock carries on. */
  startedAt: timestampSchema.nullable().default(null),
  /** When it settled. Every tab writes the same result, down to the time. */
  finishedAt: timestampSchema.nullable().default(null),
});
/** The whole run, as canvas_run.updated carries it, so a reloaded tab re-attaches from one frame. */
export const canvasRunStateSchema = z.object({
  runId: ulidSchema,
  canvasId: ulidSchema,
  scope: z.enum(CANVAS_RUN_SCOPES),
  status: jobSetStateSchema,
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  nodes: z.array(canvasRunNodeStateSchema),
});
/** GET /api/canvases/:id/runs: every active run, plus runs finished after `since`. */
export const canvasRunsQuerySchema = z.object({ since: timestampSchema.optional() });
export const canvasRunsResponseSchema = z.object({ runs: z.array(canvasRunStateSchema) });
export const canvasRunParamSchema = z.object({
  id: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
});
/** POST /api/canvases/:id/runs/:runId/nodes/:nodeId/cancel: one node and what depends on it. */
export const canvasRunNodeParamSchema = canvasRunParamSchema.extend({ nodeId: localIdSchema });

// Templates and previews

export const canvasTemplateSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.enum(CANVAS_TEMPLATE_SOURCES),
  name: z.string(),
  nodeCount: z.int().nonnegative(),
  graph: canvasDocumentSchema,
});
/** GET /api/canvas-templates */
export const canvasTemplatesResponseSchema = z.array(canvasTemplateSchema);
/** PUT /api/canvases/:id/preview?theme= and GET /files/canvas-preview/:id?theme=. Light by default. */
export const canvasPreviewQuerySchema = z.object({
  theme: z.enum(CANVAS_PREVIEW_THEMES).optional(),
  v: z.string().max(40).optional(),
});
/** PUT /api/canvases/:id/preview */
export const canvasPreviewResponseSchema = z.object({ previewUrl: z.string() });

/** GET /api/canvases/:id/spend: what this canvas's runs have cost, by Spending's rules. */
export const canvasSpendResponseSchema = z.object({
  usd: z.number().nonnegative(),
  images: z.int().nonnegative(),
  /** Canceled after it was sent: may be billed, no image to show for it. */
  usdDiscarded: z.number().nonnegative(),
  currency: z.string(),
});

export type CanvasSummary = z.infer<typeof canvasSummarySchema>;
export type CanvasesListQuery = z.infer<typeof canvasesListQuerySchema>;
export type CanvasCreateBody = z.infer<typeof canvasCreateBodySchema>;
export type CanvasDetail = z.infer<typeof canvasDetailSchema>;
export type CanvasPatchBody = z.infer<typeof canvasPatchBodySchema>;
export type CanvasPatchResponse = z.infer<typeof canvasPatchResponseSchema>;
export type CanvasConflictResponse = z.infer<typeof canvasConflictResponseSchema>;
export type CanvasVersion = z.infer<typeof canvasVersionSchema>;
export type CanvasVersionDetail = z.infer<typeof canvasVersionDetailSchema>;
export type CanvasVersionCreateBody = z.infer<typeof canvasVersionCreateBodySchema>;
export type CanvasRunInputValue = z.infer<typeof canvasRunInputValueSchema>;
export type CanvasRunInput = z.infer<typeof canvasRunInputSchema>;
export type CanvasRunCall = z.infer<typeof canvasRunCallSchema>;
export type CanvasRunPlanItem = z.infer<typeof canvasRunPlanItemSchema>;
export type CanvasRunBody = z.infer<typeof canvasRunBodySchema>;
export type CanvasRunNodeResult = z.infer<typeof canvasRunNodeResultSchema>;
export type CanvasRunResponse = z.infer<typeof canvasRunResponseSchema>;
export type CanvasRunError = z.infer<typeof canvasRunErrorSchema>;
export type CanvasRunNodeState = z.infer<typeof canvasRunNodeStateSchema>;
export type CanvasRunState = z.infer<typeof canvasRunStateSchema>;
export type CanvasRunsQuery = z.infer<typeof canvasRunsQuerySchema>;
export type CanvasRunsResponse = z.infer<typeof canvasRunsResponseSchema>;
export type CanvasTemplate = z.infer<typeof canvasTemplateSchema>;
export type CanvasTemplatesResponse = z.infer<typeof canvasTemplatesResponseSchema>;
export type CanvasPreviewResponse = z.infer<typeof canvasPreviewResponseSchema>;
export type CanvasSpendResponse = z.infer<typeof canvasSpendResponseSchema>;
export type CanvasPreviewQuery = z.infer<typeof canvasPreviewQuerySchema>;
