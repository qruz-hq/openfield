import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fromDocument,
  LIST_MAX,
  NODE_LIMITS,
  PROMPT_MAX,
  specRegistry,
  TAKES_MAX,
  TAKES_MIN,
} from "@openfield/canvas";
import { ASPECT_RATIOS, BATCH_MAX, CANVAS_EDGE_KINDS, GENERATE_PROMPT_MAX, t } from "@openfield/core";
import { type CanvasEdit, canvasEditSchema } from "@openfield/core/canvas";
import { z } from "zod";
import { readDocument } from "../../canvas/documents";
import { serverEngineContext } from "../../canvas/engine-context";
import { ApiFailure } from "../../http/errors";
import {
  actorOf,
  canvasField,
  canvasPreviews,
  canvasUrl,
  describeCanvas,
  reading,
  resolveCanvas,
  restoreOps,
} from "../canvas";
import { guarded, Refusal, reply, type ToolContext } from "../kit";

// Building canvases: find, make, read, change, and go back to an earlier version. Every change goes
// through the canvas service as the agent, so open tabs show it as it happens, with the agent's name
// on the nodes it touched, and the canvas is saved as a version before the agent's first change.

const MAX_PREVIEWS = 8;

/** What each node type's settings mean, for list_node_types. Types not listed have none worth setting. */
const SETTINGS: Partial<Record<string, Record<string, string>>> = {
  prompt: { text: `The words it hands on to what it's connected to. At most ${PROMPT_MAX} characters.` },
  "image.upload": { assetIds: "Library image ids. Bring a file or web image in with import_image first." },
  "image.asset": { assetIds: "Library image ids, from search_assets." },
  "image.generate": {
    model:
      'A model key from list_models, such as "google:gemini-3-pro-image". Leave out for the default model.',
    prompt: `Its own prompt. A connected Prompt node's text comes first, then this; together at most ${GENERATE_PROMPT_MAX} characters.`,
    aspect: 'Shorthand for size: an aspect ratio such as "1:1", "3:4" or "16:9".',
    size: '{"kind":"aspect","ratio":"16:9"}, {"kind":"pixels","width":1024,"height":1536} or {"kind":"auto"}.',
    resolution: 'A resolution tier the model lists, such as "1K" or "2K".',
    quality: "A quality id the model lists in list_models.",
    batch: `How many images, 1 to ${BATCH_MAX}. Each is billed.`,
    seed: '{"mode":"random"} or {"mode":"fixed","value":42}, for models that take seeds.',
  },
  "image.variations": {
    strategy:
      '"same-prompt" (count new takes), "prompt-list" (one image per line of prompts) or "model-list" (one per model).',
    count: `New takes: how many, ${TAKES_MIN} to ${TAKES_MAX}.`,
    prompts: `prompt-list: the lines, at most ${LIST_MAX}, each at most ${PROMPT_MAX} characters.`,
    models: `model-list: model keys, one image each, at most ${LIST_MAX}.`,
    model: "same-prompt and prompt-list: the model. Leave out for the default.",
    aspect: "Shorthand for size, as on Generate.",
  },
  note: { text: "The note's text." },
  text: { text: "The text." },
  shape: { shape: '"rectangle" or "ellipse".', text: "Text inside it." },
};

// Edits

/** "node.port" or "node": the port is left to the canvas when it's plain which one fits. */
const endField = z
  .string()
  .min(1)
  .max(130)
  .describe(
    'A node, as "nodeId.port" or just "nodeId" when only one port fits. The node can be an `as` name from the same batch.',
  );

/** The friendly form of connect: { connect: "p.text", to: "g.prompt" }. */
const connectShorthand = z.object({
  connect: endField.describe('Where the connection starts: "nodeId.outputPort" or "nodeId".'),
  to: endField.describe('Where it ends: "nodeId.inputPort" or "nodeId".'),
  kind: z.enum(CANVAS_EDGE_KINDS).optional(),
});

/** Node ids and aliases never contain a dot, so the first dot splits node from port. */
function splitEnd(end: string): { node: string; handle?: string } {
  const dot = end.indexOf(".");
  return dot < 0 ? { node: end } : { node: end.slice(0, dot), handle: end.slice(dot + 1) };
}

export function connectEdit(from: string, to: string, kind?: (typeof CANVAS_EDGE_KINDS)[number]): CanvasEdit {
  const source = splitEnd(from);
  const target = splitEnd(to);
  return {
    op: "connect",
    source: source.node,
    ...(source.handle && { sourceHandle: source.handle }),
    target: target.node,
    ...(target.handle && { targetHandle: target.handle }),
    ...(kind && { kind }),
  };
}

/** `aspect: "16:9"` is shorthand for the size setting. */
function withSize(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params || typeof params.aspect !== "string") return params;
  const { aspect, ...rest } = params;
  if (!(ASPECT_RATIOS as readonly string[]).includes(aspect)) {
    throw new Refusal(
      `"${aspect}" isn't an aspect ratio Openfield knows. Try one like "1:1", "3:4" or "16:9".`,
    );
  }
  return { ...rest, size: aspect === "auto" ? { kind: "auto" } : { kind: "aspect", ratio: aspect } };
}

function tidy(edit: CanvasEdit): CanvasEdit {
  if (edit.op === "add_node" || edit.op === "update_node") {
    const params = withSize(edit.params);
    return params === undefined ? edit : { ...edit, params };
  }
  return edit;
}

/**
 * Applies edits as the agent and answers with what changed. A refused edit says which one, in the
 * words `label` gives it ("edit 3", "nodes[1]").
 */
async function applyEdits(
  ctx: ToolContext,
  canvasRef: string,
  edits: CanvasEdit[],
  opts: { graphVersion?: number | undefined; label?: (index: number) => string } = {},
) {
  const canvas = resolveCanvas(ctx, canvasRef);
  const label = opts.label ?? ((i: number) => `edit ${i}`);
  let result: ReturnType<typeof ctx.svc.canvases.edit>;
  try {
    result = ctx.svc.canvases.edit(canvas.id, edits.map(tidy), actorOf(ctx), {
      ...(opts.graphVersion !== undefined && { graphVersion: opts.graphVersion }),
    });
  } catch (error) {
    const index = error instanceof ApiFailure ? /^edits\.(\d+)$/.exec(error.field ?? "")?.[1] : undefined;
    if (index !== undefined && error instanceof ApiFailure) {
      throw new Refusal(
        `${label(Number(index))}: ${error.userMessage ?? error.message} Nothing was changed.`,
      );
    }
    throw error;
  }
  const { view } = await describeCanvas(ctx, canvas.id);
  const touched = new Set(result.touched);
  return reply({
    canvasId: canvas.id,
    graphVersion: result.graphVersion,
    ...(Object.keys(result.aliases).length > 0 && { created: result.aliases }),
    ...(result.versionId && {
      versionSaved: `Saved the canvas as a version first ("${t("canvas.agents.versionLabel", { name: ctx.session.client })}"), so the person can go back.`,
    }),
    changed: view.nodes.filter((n) => touched.has(n.id)),
    ...(result.touched.length === 0 && { note: "Nothing needed changing." }),
  });
}

const graphVersionField = z
  .int()
  .min(1)
  .optional()
  .describe(
    "The graphVersion you last read. If the canvas changed since, nothing is applied and you're told to read it again.",
  );

const addNodeFields = canvasEditSchema.options[0].omit({ op: true }).shape;

export function canvasTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_canvases",
    {
      title: "List canvases",
      description:
        "The person's canvases, newest change first, with which one is open in Openfield now. Can list the templates a canvas can start from.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Only canvases whose name has these words."),
        templates: z.boolean().optional().describe("Also list templates, for create_canvas."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_canvases", async ({ query, templates }) => {
      const active = ctx.svc.presence.active()?.canvasId ?? null;
      const canvases = ctx.svc.canvases.list(query).map((c) => ({
        canvasId: c.id,
        name: c.name,
        nodes: c.nodeCount,
        updatedAt: c.updatedAt,
        url: canvasUrl(ctx, c.id),
        ...(c.id === active && { active: true }),
      }));
      return reply({
        canvases,
        ...(templates && {
          templates: ctx.svc.canvases
            .listTemplates()
            .map((tpl) => ({ templateId: tpl.id, name: tpl.name, nodes: tpl.nodeCount })),
        }),
      });
    }),
  );

  server.registerTool(
    "create_canvas",
    {
      title: "Make a canvas",
      description:
        "Makes a new canvas, blank or from a template (list_canvases with templates: true). show: true opens it in the person's Openfield tab.",
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Its name. Default: Untitled, or the template's name."),
        templateId: z.string().optional().describe("Start from this template."),
        show: z.boolean().optional().describe("Open it in the person's Openfield tab. Default false."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "create_canvas", async ({ name, templateId, show }) => {
      const detail = ctx.svc.canvases.create({ ...(name && { name }), ...(templateId && { templateId }) });
      const tabId = show ? ctx.svc.presence.navigate({ kind: "canvas", id: detail.id }) : null;
      const { view } = await describeCanvas(ctx, detail.id);
      return reply({ ...view, ...(show && { shown: tabId !== null }) });
    }),
  );

  server.registerTool(
    "get_canvas",
    {
      title: "Read a canvas",
      description:
        'What\'s on a canvas: every node with its id, type, title, position and main settings; whether each image node is done, out of date, failed or needs something; the images it made; and the connections as "node.port" pairs. Use its graphVersion with edit_canvas to be sure nothing changed in between.',
      inputSchema: {
        canvas: z.string().describe(canvasField),
        previews: z
          .boolean()
          .optional()
          .describe(`Include previews of up to ${MAX_PREVIEWS} of its images. Default false.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_canvas", async ({ canvas: ref, previews }) => {
      const canvas = resolveCanvas(ctx, ref);
      const { view } = await describeCanvas(ctx, canvas.id);
      reading(ctx, canvas.id);
      return reply(view, previews ? await canvasPreviews(ctx, view, MAX_PREVIEWS) : []);
    }),
  );

  server.registerTool(
    "rename_canvas",
    {
      title: "Rename a canvas",
      description: "Renames a canvas. Its image folder follows the new name.",
      inputSchema: { canvas: z.string().describe(canvasField), name: z.string().trim().min(1).max(200) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "rename_canvas", ({ canvas, name }) =>
      applyEdits(ctx, canvas, [{ op: "rename_canvas", name }]),
    ),
  );

  server.registerTool(
    "duplicate_canvas",
    {
      title: "Copy a canvas",
      description: "Makes a copy of a canvas, with its nodes, settings and results.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('A name for the copy. Default: "<name> copy".'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "duplicate_canvas", async ({ canvas: ref, name }) => {
      const copy = ctx.svc.canvases.duplicate(resolveCanvas(ctx, ref).id);
      if (name) ctx.svc.canvases.edit(copy.id, [{ op: "rename_canvas", name }], actorOf(ctx));
      const { view } = await describeCanvas(ctx, copy.id);
      return reply(view);
    }),
  );

  server.registerTool(
    "delete_canvas",
    {
      title: "Delete a canvas",
      description:
        "Deletes a canvas and its versions for good, and stops its runs. The images it made stay in the library. Ask the person first.",
      inputSchema: { canvas: z.string().describe(canvasField) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(ctx, "delete_canvas", async ({ canvas: ref }) => {
      const canvas = resolveCanvas(ctx, ref);
      ctx.svc.canvasRuns.forgetCanvas(canvas.id);
      ctx.svc.canvases.remove(canvas.id);
      return reply({ deleted: canvas.id, name: canvas.name, note: "Its images are still in the library." });
    }),
  );

  server.registerTool(
    "list_versions",
    {
      title: "Canvas versions",
      description:
        "A canvas's saved versions, newest first: ones the person or an agent saved, and automatic ones.",
      inputSchema: { canvas: z.string().describe(canvasField) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_versions", async ({ canvas: ref }) => {
      const canvas = resolveCanvas(ctx, ref);
      reading(ctx, canvas.id);
      const versions = ctx.svc.canvases.versions(canvas.id).map((v) => ({
        versionId: v.id,
        label: v.label,
        kind: v.kind,
        createdAt: v.createdAt,
        nodes: v.nodeCount,
      }));
      return reply({ canvasId: canvas.id, versions });
    }),
  );

  server.registerTool(
    "save_version",
    {
      title: "Save a version",
      description: "Saves the canvas as it is now as a named version, to come back to later.",
      inputSchema: { canvas: z.string().describe(canvasField), label: z.string().trim().min(1).max(120) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "save_version", async ({ canvas: ref, label }) => {
      const canvas = resolveCanvas(ctx, ref);
      const version = ctx.svc.canvases.createVersion(canvas.id, { label });
      return reply({ canvasId: canvas.id, versionId: version.id, label: version.label });
    }),
  );

  server.registerTool(
    "restore_version",
    {
      title: "Go back to a version",
      description:
        "Puts a canvas back the way a saved version had it. What's there now is saved as a version first, so nothing is lost. Open tabs show the change as it happens.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        versionId: z.string().describe("From list_versions."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "restore_version", async ({ canvas: ref, versionId }) => {
      const canvas = resolveCanvas(ctx, ref);
      const version = ctx.svc.canvases.version(canvas.id, versionId);
      const actor = actorOf(ctx);
      // This session's first change saves "Before <agent>" on its own; a later one saves what's
      // there now, like the editor's own restore does.
      if (ctx.svc.canvases.saveAgentVersion(canvas.id, actor) === null) {
        ctx.svc.canvases.createVersion(canvas.id, {
          label: t("canvas.agents.versionLabel", { name: ctx.session.client }),
        });
      }
      const row = ctx.svc.canvases.get(canvas.id);
      const { slice } = fromDocument(readDocument(row.graph));
      const result = ctx.svc.canvases.applyOps(canvas.id, restoreOps(slice, version.graph), actor, {
        graphVersion: row.graphVersion,
      });
      const { view } = await describeCanvas(ctx, canvas.id);
      return reply({
        restored: versionId,
        label: version.label,
        graphVersion: result.graphVersion,
        canvas: view,
      });
    }),
  );

  server.registerTool(
    "list_node_types",
    {
      title: "Node types",
      description:
        "Every kind of node a canvas can have: what it does, its input and output ports (for connect), its settings, their defaults and their limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_node_types", async () => {
      const engine = serverEngineContext(ctx.svc);
      const types = specRegistry.all().map((spec) => ({
        type: spec.type,
        name: t(spec.label),
        about: t(spec.description),
        makesImages: spec.runnable,
        ...(spec.annotation && { forLayout: true }),
        inputs: specRegistry.ports(spec.type, "in").map((p) => ({
          port: p.id,
          takes: p.type,
          ...(p.arity === "multi" && { many: true }),
          ...(p.required && { required: true }),
        })),
        outputs: specRegistry.ports(spec.type, "out").map((p) => ({ port: p.id, gives: p.type })),
        settings: SETTINGS[spec.type] ?? {},
        defaults: spec.defaults(engine),
        ...(spec.type in NODE_LIMITS && { limits: NODE_LIMITS[spec.type as keyof typeof NODE_LIMITS] }),
      }));
      return reply({
        types,
        note: 'Connect an output to an input that takes the same kind ("text" to "text", "image" to "image").',
      });
    }),
  );

  server.registerTool(
    "edit_canvas",
    {
      title: "Change a canvas",
      description:
        "Applies a batch of edits in one go: all of them, or none if one is refused (the answer says which). Each edit is one of: " +
        'add_node {as?, type, params?, title?, position?, parentId?, near?}, update_node {id, params?, title?, collapsed?, size?}, move_node {id, position?, parentId?}, remove_nodes {ids}, connect {source, sourceHandle?, target, targetHandle?}, disconnect {edgeId | source/target}, rename_canvas {name}; or the short form {connect: "p.text", to: "g.prompt"}. ' +
        "`as` names a new node so later edits in the batch can use it. Leave position out and the node is placed next to what it connects to. Settings have limits (list_node_types gives them, and titles are at most 200 characters); a batch that goes past one is refused and says which, so nothing is cut short or left unable to run. The person sees each change in open tabs as it lands.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        edits: z
          .array(z.union([canvasEditSchema, connectShorthand]))
          .min(1)
          .max(500),
        graphVersion: graphVersionField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "edit_canvas", ({ canvas, edits, graphVersion }) =>
      applyEdits(
        ctx,
        canvas,
        edits.map((e) =>
          "connect" in e && typeof e.connect === "string"
            ? connectEdit(e.connect, e.to, e.kind)
            : (e as CanvasEdit),
        ),
        { graphVersion },
      ),
    ),
  );

  server.registerTool(
    "add_nodes",
    {
      title: "Add nodes",
      description:
        'Adds nodes, and optionally connects them, in one go. Give each an `as` name to connect it: connections: [{from: "p.text", to: "g.prompt"}]. Types and settings: list_node_types.',
      inputSchema: {
        canvas: z.string().describe(canvasField),
        nodes: z.array(z.object(addNodeFields)).min(1).max(100),
        connections: z
          .array(z.object({ from: endField, to: endField }))
          .max(200)
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "add_nodes", ({ canvas, nodes, connections = [] }) =>
      applyEdits(
        ctx,
        canvas,
        [
          ...nodes.map((n): CanvasEdit => ({ op: "add_node", ...n })),
          ...connections.map((c) => connectEdit(c.from, c.to)),
        ],
        { label: (i) => (i < nodes.length ? `nodes[${i}]` : `connections[${i - nodes.length}]`) },
      ),
    ),
  );

  server.registerTool(
    "connect",
    {
      title: "Connect two nodes",
      description:
        'Connects an output to an input: from "nodeId.port" to "nodeId.port". Leave a port out when only one fits.',
      inputSchema: { canvas: z.string().describe(canvasField), from: endField, to: endField },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "connect", ({ canvas, from, to }) =>
      applyEdits(ctx, canvas, [connectEdit(from, to)], { label: () => "The connection" }),
    ),
  );

  server.registerTool(
    "update_node",
    {
      title: "Change a node",
      description:
        "Changes a node's settings (only the keys given; null removes one), title, size, or folds it.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        ...canvasEditSchema.options[1].omit({ op: true }).shape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "update_node", ({ canvas, ...edit }) =>
      applyEdits(ctx, canvas, [{ op: "update_node", ...edit }], { label: () => `Node ${edit.id}` }),
    ),
  );

  server.registerTool(
    "delete_nodes",
    {
      title: "Remove nodes",
      description:
        "Removes nodes and their connections. A frame's nodes move out of it. The canvas keeps a version from before the agent's first change.",
      inputSchema: { canvas: z.string().describe(canvasField), ids: z.array(z.string()).min(1).max(500) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(ctx, "delete_nodes", ({ canvas, ids }) =>
      applyEdits(ctx, canvas, [{ op: "remove_nodes", ids }], { label: () => "Removing" }),
    ),
  );

  server.registerTool(
    "move_node",
    {
      title: "Move a node",
      description:
        "Moves a node to a position (canvas coordinates of its top-left corner), or into or out of a frame.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        ...canvasEditSchema.options[2].omit({ op: true }).shape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "move_node", ({ canvas, ...edit }) =>
      applyEdits(ctx, canvas, [{ op: "move_node", ...edit }], { label: () => `Node ${edit.id}` }),
    ),
  );
}
