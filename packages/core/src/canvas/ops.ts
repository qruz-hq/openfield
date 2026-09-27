import { z } from "zod";
import { CANVAS_EDGE_KINDS, CANVAS_MAX_NODES, CANVAS_NODE_TYPES } from "../constants";
import { canvasEdgeSchema, canvasNodeResultSchema, canvasNodeSchema, localIdSchema } from "./schema";

// Two op sets meet here. The editor's own document ops (§7.8, @openfield/canvas store/ops) are what
// canvas.updated carries to every open tab, which replays them; this is their wire form. And the
// edits an agent or a script sends (CanvasEdit): friendlier, with aliases, defaults and placement, which
// @openfield/canvas compiles down to document ops.

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const box = z.object({ w: z.number().positive().max(100_000), h: z.number().positive().max(100_000) });
const handle = z.string().min(1).max(64);

/**
 * A document op as JSON carries it. JSON has no undefined, so a params patch names the keys it
 * removes in `unset` instead of setting them to undefined.
 */
export const canvasWireOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addNode"), node: canvasNodeSchema, index: z.int().optional() }),
  z.object({ op: z.literal("deleteNode"), id: localIdSchema }),
  z.object({ op: z.literal("moveNode"), id: localIdSchema, position: point }),
  z.object({
    op: z.literal("resizeNode"),
    id: localIdSchema,
    size: box.optional(),
    position: point.optional(),
  }),
  z.object({
    op: z.literal("reparent"),
    id: localIdSchema,
    parentId: localIdSchema.nullable(),
    position: point,
  }),
  z.object({ op: z.literal("setTitle"), id: localIdSchema, title: z.string().max(200).nullable() }),
  z.object({ op: z.literal("setCollapsed"), id: localIdSchema, collapsed: z.boolean() }),
  z.object({ op: z.literal("setPresetLocks"), id: localIdSchema, locks: z.array(z.string()) }),
  z.object({
    op: z.literal("setParams"),
    id: localIdSchema,
    patch: z.record(z.string(), z.unknown()),
    unset: z.array(z.string()).optional(),
  }),
  z.object({ op: z.literal("setResult"), id: localIdSchema, result: canvasNodeResultSchema.nullable() }),
  z.object({ op: z.literal("reorderNode"), id: localIdSchema, index: z.int() }),
  z.object({ op: z.literal("addEdge"), edge: canvasEdgeSchema, index: z.int().optional() }),
  z.object({ op: z.literal("deleteEdge"), id: localIdSchema }),
  z.object({
    op: z.literal("reconnectEdge"),
    id: localIdSchema,
    source: localIdSchema,
    sourceHandle: handle,
    target: localIdSchema,
    targetHandle: handle,
  }),
  z.object({ op: z.literal("setEdgeOrder"), id: localIdSchema, order: z.int().nonnegative().optional() }),
  z.object({ op: z.literal("setName"), name: z.string().max(200) }),
]);

// Edits

/** A node id, or the `as` name of a node added earlier in the same batch. */
const nodeRef = z
  .string()
  .min(1)
  .max(64)
  .describe("A node id, or the `as` name given to a node added earlier in the same batch");
const alias = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/)
  .describe("A short name for the new node, so later edits in the same batch can refer to it");
const position = point.describe("Top-left corner in canvas coordinates, even inside a frame");
const params = z
  .record(z.string(), z.unknown())
  .describe("Settings for the node type. For update_node, only the keys given change; null removes one");

export const canvasEditSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    as: alias.optional(),
    type: z.enum(CANVAS_NODE_TYPES),
    params: params.optional(),
    title: z.string().max(200).nullable().optional(),
    position: position
      .optional()
      .describe("Leave out to place it next to what it connects to, clear of the rest"),
    size: box.optional(),
    parentId: nodeRef.nullable().optional().describe("A frame to put it in"),
    near: nodeRef.optional().describe("Place it to the right of this node"),
  }),
  z.object({
    op: z.literal("update_node"),
    id: nodeRef,
    params: params.optional(),
    title: z.string().max(200).nullable().optional(),
    collapsed: z.boolean().optional(),
    size: box.optional(),
  }),
  z.object({
    op: z.literal("move_node"),
    id: nodeRef,
    position: position.optional(),
    parentId: nodeRef.nullable().optional().describe("A frame to move it into, or null to take it out"),
  }),
  z.object({
    op: z.literal("remove_nodes"),
    ids: z.array(nodeRef).min(1).max(CANVAS_MAX_NODES),
  }),
  z.object({
    op: z.literal("connect"),
    source: nodeRef,
    sourceHandle: handle.optional().describe("An output port. Leave out to use the one that fits"),
    target: nodeRef,
    targetHandle: handle.optional().describe("An input port. Leave out to use the one that fits"),
    kind: z.enum(CANVAS_EDGE_KINDS).optional().describe("annotation draws an arrow between notes and frames"),
  }),
  z.object({
    op: z.literal("disconnect"),
    edgeId: localIdSchema.optional(),
    source: nodeRef.optional(),
    target: nodeRef.optional(),
    sourceHandle: handle.optional(),
    targetHandle: handle.optional(),
  }),
  z.object({ op: z.literal("rename_canvas"), name: z.string().trim().min(1).max(200) }),
]);

/** At most this many edits in one batch. */
export const CANVAS_EDITS_MAX = 500;
export const canvasEditsSchema = z.array(canvasEditSchema).min(1).max(CANVAS_EDITS_MAX);

export type CanvasWireOp = z.infer<typeof canvasWireOpSchema>;
export type CanvasEdit = z.infer<typeof canvasEditSchema>;
export type CanvasEditName = CanvasEdit["op"];
