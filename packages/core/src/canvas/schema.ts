import { z } from "zod";
import {
  BATCH_MAX,
  CANVAS_EDGE_KINDS,
  CANVAS_MAX_NODES,
  CANVAS_NODE_STATES,
  CANVAS_NODE_TYPES,
  CANVAS_SEED_MODES,
} from "../constants";
import { t } from "../i18n";
import {
  errorCodeSchema,
  modelKeySchema,
  resolutionTierSchema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "../schemas/common";
import { sizeSpecSchema } from "../schemas/request";

// The canvas document (§7.8). One JSON object per canvas: the canvases.graph column, the
// .ofcanvas.json export and the bundled templates all use it.

export const CANVAS_SCHEMA_VERSION = 1;
export const CANVAS_SCHEMA = `openfield.canvas/${CANVAS_SCHEMA_VERSION}` as const;

/** Document-local ids, stable across saves ("n_gen_1", "e_1"). */
export const localIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const pointSchema = z.object({ x: z.number(), y: z.number() });

export const canvasViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().min(0.02).max(8),
});

/** One image a node made, with what it came from, for the labelled result grid. */
export const canvasOutputSchema = z.object({
  assetId: ulidSchema,
  model: modelKeySchema.optional(),
  /** Which call made it (Variations: the prompt line or model). */
  call: z.int().nonnegative().optional(),
  /** Which fanned-out input it came from. */
  source: z.int().nonnegative().optional(),
});

export const canvasNodeResultSchema = z.object({
  state: z.enum(CANVAS_NODE_STATES),
  assetIds: z.array(ulidSchema),
  /** The first job set, kept for older readers. jobSetIds has them all. */
  jobSetId: ulidSchema.nullable(),
  jobSetIds: z.array(ulidSchema).default([]),
  outputs: z.array(canvasOutputSchema).default([]),
  /** The fingerprint the result was made with (§0.11). */
  fingerprint: z.string().nullable(),
  costUsd: usdSchema.nullable(),
  ranAt: timestampSchema.nullable(),
  error: z.object({ code: errorCodeSchema, reason: z.string().optional() }).nullable().default(null),
  /**
   * The images it read, sorted. When an earlier node makes new images under the same settings,
   * they no longer match and the node shows it's out of date. Absent in older documents.
   */
  inputs: z.array(ulidSchema).optional(),
  /** It arrived after the node's settings changed: "Made with older settings" (§0.11). */
  late: z.boolean().optional(),
});

// Params stay loose except where §7 pins them down; unknown keys survive a round trip.
export const generateNodeParamsSchema = z.looseObject({
  model: modelKeySchema.optional(),
  prompt: z.string().optional(),
  size: sizeSpecSchema.optional(),
  resolution: resolutionTierSchema.optional(),
  quality: z.string().optional(),
  batch: z.int().min(1).max(BATCH_MAX).optional(),
  seed: z.object({ mode: z.enum(CANVAS_SEED_MODES), value: z.int().min(0).optional() }).optional(),
  enhancePrompt: z.boolean().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

export const canvasNodeSchema = z.object({
  id: localIdSchema,
  type: z.enum(CANVAS_NODE_TYPES),
  typeVersion: z.int().min(1),
  position: pointSchema,
  size: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
  /** Frame membership. null at the top level. */
  parentId: localIdSchema.nullable().default(null),
  collapsed: z.boolean().default(false),
  /** null: use the node type's own label. */
  title: z.string().max(200).nullable().default(null),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Fields currently driven by a connected preset. */
  presetLocks: z.array(z.string()).default([]),
  result: canvasNodeResultSchema.nullable().default(null),
  /**
   * Keeps what the node made: it never runs again and can't be deleted, though it still moves. A
   * locked frame locks everything in it. Absent when unlocked, so older documents read unchanged.
   */
  locked: z.boolean().optional(),
});

export const canvasEdgeSchema = z.object({
  id: localIdSchema,
  source: localIdSchema,
  sourceHandle: z.string().min(1).max(64),
  target: localIdSchema,
  targetHandle: z.string().min(1).max(64),
  /** Position within a multi input, in connection order. */
  order: z.int().nonnegative().optional(),
  kind: z.enum(CANVAS_EDGE_KINDS),
});

/** Reserved for comments (§7.11). Anchored to a node or a point. */
export const canvasCommentSchema = z.object({
  id: localIdSchema,
  nodeId: localIdSchema.optional(),
  point: pointSchema.optional(),
  text: z.string().max(4000),
  createdAt: timestampSchema,
});

// No object-level checks here, so this stays extendable. canvasDocumentSchema adds them.
export const canvasDocumentObjectSchema = z.object({
  schema: z.literal(CANVAS_SCHEMA),
  id: ulidSchema,
  name: z.string().max(200),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  viewport: canvasViewportSchema,
  nodes: z.array(canvasNodeSchema).max(CANVAS_MAX_NODES),
  edges: z.array(canvasEdgeSchema).max(20000),
  comments: z.array(canvasCommentSchema).default([]),
  meta: z
    .object({
      appVersion: z.string().optional(),
      /** Relative to the library folder; never an asset id. */
      previewPath: z.string().nullable().optional(),
    })
    .default({}),
});

/** A bad Generate setting, in words a person can act on (an imported file shows it, §7.8). */
function paramMessage(field: PropertyKey | undefined): string {
  switch (field) {
    case "batch":
      return t("canvas.errors.imageCount", { min: 1, max: BATCH_MAX });
    case "model":
      return t("canvas.errors.badModel");
    case "size":
      return t("canvas.errors.badSize");
    default:
      return t("canvas.errors.badSetting");
  }
}

export const canvasDocumentSchema = canvasDocumentObjectSchema.superRefine((doc, ctx) => {
  const ids = new Set<string>();
  doc.nodes.forEach((node, i) => {
    if (ids.has(node.id))
      ctx.addIssue({ code: "custom", message: t("canvas.errors.duplicateNode"), path: ["nodes", i, "id"] });
    ids.add(node.id);
    if (node.type === "image.generate") {
      const params = generateNodeParamsSchema.safeParse(node.params);
      if (!params.success) {
        for (const issue of params.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: paramMessage(issue.path[0]),
            path: ["nodes", i, "params", ...issue.path],
          });
        }
      }
    }
  });
  // Frames nest, but never in a circle: the editor walks up the parents to place a node.
  const types = new Map(doc.nodes.map((node) => [node.id, node.type]));
  const parents = new Map(doc.nodes.map((node) => [node.id, node.parentId]));
  doc.nodes.forEach((node, i) => {
    if (node.parentId === null) return;
    const path = ["nodes", i, "parentId"];
    if (!ids.has(node.parentId)) {
      ctx.addIssue({ code: "custom", message: t("canvas.errors.missingParent"), path });
      return;
    }
    if (types.get(node.parentId) !== "frame") {
      ctx.addIssue({ code: "custom", message: t("canvas.errors.parentNotFrame"), path });
      return;
    }
    const seen = new Set([node.id]);
    for (let at = parents.get(node.id) ?? null; at !== null; at = parents.get(at) ?? null) {
      if (seen.has(at)) {
        ctx.addIssue({ code: "custom", message: t("canvas.errors.parentLoop"), path });
        return;
      }
      seen.add(at);
    }
  });
  const edgeIds = new Set<string>();
  doc.edges.forEach((edge, i) => {
    if (edgeIds.has(edge.id))
      ctx.addIssue({ code: "custom", message: t("canvas.errors.duplicateEdge"), path: ["edges", i, "id"] });
    edgeIds.add(edge.id);
    if (!ids.has(edge.source))
      ctx.addIssue({ code: "custom", message: t("canvas.errors.missingNode"), path: ["edges", i, "source"] });
    if (!ids.has(edge.target))
      ctx.addIssue({ code: "custom", message: t("canvas.errors.missingNode"), path: ["edges", i, "target"] });
  });
});

export type CanvasViewport = z.infer<typeof canvasViewportSchema>;
export type CanvasOutput = z.infer<typeof canvasOutputSchema>;
export type CanvasNodeResult = z.infer<typeof canvasNodeResultSchema>;
export type GenerateNodeParams = z.infer<typeof generateNodeParamsSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasComment = z.infer<typeof canvasCommentSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
/** What the canvases.graph column holds: the whole document. */
export type CanvasGraph = CanvasDocument;
