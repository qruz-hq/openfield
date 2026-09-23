import { z } from "zod";
import { canvasDocumentSchema } from "../canvas/schema";
import { CANVAS_RUN_SCOPES } from "../constants";
import { modelKeySchema, timestampSchema, ulidSchema } from "./common";
import { costEstimateSchema } from "./cost";
import { errorEnvelopeSchema } from "./errors";

// Canvas routes (§8.3). The document itself lives in ../canvas.

export const canvasSummarySchema = z.object({
  id: ulidSchema,
  name: z.string(),
  previewUrl: z.string().nullable(),
  updatedAt: timestampSchema,
});
export const canvasesListResponseSchema = z.array(canvasSummarySchema);

/** POST /api/canvases */
export const canvasCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  /** Start from a bundled or saved template. */
  templateId: z.string().min(1).max(128).optional(),
});

/** GET /api/canvases/:id */
export const canvasDetailSchema = z.object({
  id: ulidSchema,
  name: z.string(),
  graph: canvasDocumentSchema,
  graphVersion: z.int().min(1),
  updatedAt: timestampSchema,
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

export const canvasVersionSchema = z.object({
  id: ulidSchema,
  label: z.string().nullable(),
  createdAt: timestampSchema,
});
export const canvasVersionsResponseSchema = z.array(canvasVersionSchema);
export const canvasVersionCreateBodySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
});

/** POST /api/canvases/:id/run. The browser compiles the plan; the server schedules it. */
export const canvasRunBodySchema = z.object({
  scope: z.enum(CANVAS_RUN_SCOPES),
  nodeIds: z.array(z.string().min(1).max(64)),
  plan: z
    .array(
      z.object({
        nodeId: z.string().min(1).max(64),
        typeVersion: z.int().min(1),
        fingerprint: z.string(),
        model: modelKeySchema,
        params: z.record(z.string(), z.unknown()),
        inputs: z.record(z.string(), z.unknown()),
      }),
    )
    .max(500),
  /** Estimate and report what would be reused, without running anything. */
  dryRun: z.boolean().optional(),
});
export const canvasRunResponseSchema = z.object({
  runId: ulidSchema.nullable(),
  jobSets: z.array(z.object({ nodeId: z.string(), jobSetId: ulidSchema })),
  skipped: z.array(z.object({ nodeId: z.string(), reason: z.literal("cached") })),
  estimate: costEstimateSchema,
});

export type CanvasSummary = z.infer<typeof canvasSummarySchema>;
export type CanvasDetail = z.infer<typeof canvasDetailSchema>;
export type CanvasRunBody = z.infer<typeof canvasRunBodySchema>;
export type CanvasRunResponse = z.infer<typeof canvasRunResponseSchema>;
