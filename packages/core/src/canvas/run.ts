import { z } from "zod";
import { type CanvasRunNodeState, canvasRunErrorSchema, canvasRunPlanItemSchema } from "../schemas/canvas";
import { ulidSchema } from "../schemas/common";
import { generateRequestSchema } from "../schemas/request";
import { type CanvasNodeResult, localIdSchema } from "./schema";

// What canvas_runs.plan stores: the submitted plan plus the server's own bookkeeping, so a run
// picks up where it left off after a restart (§8.4.5). Never sent to the browser.

/**
 * One job set a run means to create. Written before the job set exists, with the idempotency key
 * already in the request, so a restart finishes the launch without ever creating it twice.
 */
export const canvasRunLaunchSchema = z.object({
  nodeId: localIdSchema,
  /** Index into the plan item's calls. */
  call: z.int().nonnegative(),
  /** Which fanned-out input combination this is. */
  source: z.int().nonnegative(),
  request: generateRequestSchema,
  jobSetId: ulidSchema.nullable(),
  /** The request was refused before any job set existed, e.g. a setting the model can't do. */
  error: canvasRunErrorSchema.nullable(),
});

export const canvasRunRecordSchema = z.object({
  nodeIds: z.array(localIdSchema),
  items: z.array(canvasRunPlanItemSchema),
  launches: z.array(canvasRunLaunchSchema).default([]),
  /** Stop was pressed: nothing new starts. */
  canceled: z.boolean().default(false),
  /** Nodes whose own Cancel was pressed. They and what reads from them stop; the rest carries on. */
  canceledNodes: z.array(localIdSchema).default([]),
  /**
   * The agent app that started the run, such as "Claude Code". Each job set it makes carries it, so
   * the agents' daily limit and Spending count it. Null when a person did; absent in older records.
   */
  agent: z.string().max(80).nullable().default(null),
});

export type CanvasRunLaunch = z.infer<typeof canvasRunLaunchSchema>;
export type CanvasRunRecord = z.infer<typeof canvasRunRecordSchema>;

/**
 * What a canvas document keeps for a node a run finished, or null when the run leaves it alone:
 * skipped nodes keep what they have, blocked ones never ran, and one canceled before it made
 * anything spent nothing and changed nothing, so it keeps the result it had (§7.7). A failure that
 * made no images keeps the images it had next to the error, so what reads from it doesn't go out
 * of date over a run that changed nothing. The server writes it into the saved canvas and every
 * open tab writes the same into its copy, so they never disagree.
 */
export function resultOfRunNode(
  node: CanvasRunNodeState,
  fallbackTime: string,
  previous: CanvasNodeResult | null = null,
): CanvasNodeResult | null {
  if (node.state !== "done" && node.state !== "failed" && node.state !== "canceled") return null;
  if (node.state === "canceled" && node.assetIds.length === 0) return null;
  const result: CanvasNodeResult = {
    state: node.state,
    assetIds: [...node.assetIds],
    jobSetId: node.jobSetIds[0] ?? null,
    jobSetIds: [...node.jobSetIds],
    outputs: node.outputs.map((o) => ({ ...o })),
    fingerprint: node.fingerprint,
    costUsd: node.costUsd,
    ranAt: node.finishedAt ?? fallbackTime,
    error: node.error,
    inputs: [...node.inputs],
  };
  if (node.state === "failed" && node.assetIds.length === 0 && previous && previous.assetIds.length > 0) {
    const { inputs: _made, ...rest } = result;
    return {
      ...rest,
      assetIds: [...previous.assetIds],
      outputs: previous.outputs.map((o) => ({ ...o })),
      ...(previous.inputs && { inputs: [...previous.inputs] }),
    };
  }
  return result;
}
