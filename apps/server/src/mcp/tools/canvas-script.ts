import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasDocument } from "@openfield/core/canvas";
import { getCanvas } from "@openfield/db";
import { z } from "zod";
import { readDocument } from "../../canvas/documents";
import { ApiFailure } from "../../http/errors";
import { canvasField, resolveCanvas } from "../canvas";
import { guarded, Refusal, reply, type ToolContext } from "../kit";
import { MAX_STATE_BYTES, newPlan, planHost } from "../script/plan";
import { runInSandbox } from "../script/sandbox";
import { applyEdits } from "./canvas";

// canvas_script: a short JavaScript program that records canvas edits, so repetitive builds (a grid
// of prompts, the same setting on every node) cost a few lines of output instead of hundreds of
// edit objects, and land as one all-or-nothing batch like edit_canvas.

const RETRY_MAX = 64;
const RETRY_TTL_MS = 15 * 60 * 1000;
const RETRY_NODE_NOTE =
  "Fix it with retryId and edits [{find, replace}] instead of sending the script again.";

interface Stored {
  code: string;
  at: number;
}

interface SessionState {
  retries: Map<string, Stored>;
  remembered: Map<string, unknown>;
  nextId: number;
}

const sessions = new WeakMap<ToolContext, SessionState>();
function stateOf(ctx: ToolContext): SessionState {
  let s = sessions.get(ctx);
  if (!s) {
    s = { retries: new Map(), remembered: new Map(), nextId: 1 };
    sessions.set(ctx, s);
  }
  return s;
}

function storeRetry(state: SessionState, code: string, now: number): string {
  for (const [id, r] of state.retries) if (now - r.at > RETRY_TTL_MS) state.retries.delete(id);
  while (state.retries.size >= RETRY_MAX) state.retries.delete(state.retries.keys().next().value as string);
  const id = `r${state.nextId++}`;
  state.retries.set(id, { code, at: now });
  return id;
}

function patch(code: string, edits: { find: string; replace: string; all?: boolean | undefined }[]): string {
  let out = code;
  edits.forEach((e, i) => {
    const parts = out.split(e.find);
    const found = parts.length - 1;
    if (!e.find || found === 0)
      throw new Refusal(`edits[${i}]: "${e.find.slice(0, 60)}" isn't in the script.`);
    if (found > 1 && !e.all) {
      throw new Refusal(
        `edits[${i}]: "${e.find.slice(0, 60)}" appears ${found} times. Add more around it, or set all: true.`,
      );
    }
    out = e.all ? parts.join(e.replace) : parts[0] + e.replace + parts.slice(1).join(e.find);
  });
  return out;
}

const EMPTY: Pick<CanvasDocument, "nodes" | "edges"> = { nodes: [], edges: [] };

export function canvasScriptTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "canvas_script",
    {
      title: "Change a canvas with a script",
      description:
        "For repetitive canvas work (many similar nodes, one setting changed on many nodes), send a short JavaScript program instead of many edits. Nothing runs until it finishes: the calls only record edits, which apply together or not at all. " +
        "Reads: Nodes({type?, parentId?}), Node(id), Edges(), NodeTypes(). Reads see the script's own earlier edits. " +
        "Writes: Add(type, params?, {as?, title?, at?:{x,y}, near?, parent?, exact?}) returns the new node's id; Set(id, params, {title?, collapsed?}); Move(id, {x,y}, {exact?, parent?}); Remove(...ids); Connect('p.text', 'g.prompt'); Disconnect(from, to); Rename(name). " +
        "Layout: Grid(n, {cols?, x?, y?, w?, h?, gap?}), Row(n, opts), Column(n, opts) return n top-left corners. Also Print(...) and Remember(name, valueOrFunction) / Recall(name) to keep helpers for later calls. " +
        "Failed? Send retryId with edits [{find, replace, all?}] to patch the script instead of resending it. Costs nothing: it never runs images (use run_canvas).",
      inputSchema: {
        code: z.string().max(100_000).optional().describe("The JavaScript program."),
        retryId: z
          .string()
          .optional()
          .describe("From a failed call: patch that script with `edits` instead of `code`."),
        edits: z
          .array(z.object({ find: z.string(), replace: z.string(), all: z.boolean().optional() }))
          .max(50)
          .optional(),
        canvas: z.string().optional().describe(canvasField),
        createCanvas: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Make a new canvas with this name and run the script on it, instead of `canvas`."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Run the script and say what it would do, without changing anything."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "canvas_script", async (args) => {
      const state = stateOf(ctx);
      const now = Date.now();
      let code = args.code;
      if (args.retryId !== undefined) {
        if (!args.edits?.length) throw new Refusal("A retryId needs edits to patch the script with.");
        const stored = state.retries.get(args.retryId);
        state.retries.delete(args.retryId);
        if (!stored || now - stored.at > RETRY_TTL_MS) {
          throw new Refusal("That retryId has been used or has expired. Send the whole script as code.");
        }
        code = patch(stored.code, args.edits);
      }
      if (code === undefined) throw new Refusal("Send `code`, or `retryId` with `edits`.");
      if (args.createCanvas === undefined && args.canvas === undefined) {
        throw new Refusal("Name the canvas to change, or createCanvas to make a new one.");
      }
      const target = args.createCanvas === undefined ? resolveCanvas(ctx, args.canvas as string) : null;
      const row = target ? getCanvas(ctx.svc.db, target.id) : null;
      const doc = row ? readDocument(row.graph) : EMPTY;

      const plan = newPlan();
      const stored = state.remembered;
      const ran = await runInSandbox(code, planHost(doc, plan, stored));
      const fail = (message: string, line?: number) =>
        refuseWith(
          `${line ? `Line ${line}: ` : ""}${message} Nothing was changed.`,
          storeRetry(state, code as string, now),
          plan.prints,
        );
      if (!ran.ok) return fail(ran.message, ran.line);
      // Helpers the script asked to keep, within the cap.
      if (!args.dryRun) {
        for (const [k, v] of plan.remembered) stored.set(k, v);
        while (JSON.stringify([...stored]).length > MAX_STATE_BYTES && stored.size > 0) {
          stored.delete(stored.keys().next().value as string);
        }
      }
      if (plan.edits.length === 0) {
        return reply({
          note: "The script made no edits.",
          ...(plan.prints.length && { prints: plan.prints }),
        });
      }
      if (args.dryRun) {
        const ops: Record<string, number> = {};
        for (const e of plan.edits) ops[e.op] = (ops[e.op] ?? 0) + 1;
        return reply({ dryRun: true, edits: plan.edits.length, ops, prints: plan.prints });
      }

      let canvasRef = args.canvas;
      if (args.createCanvas !== undefined) {
        canvasRef = ctx.svc.canvases.create({ name: args.createCanvas }).id;
      }
      let answer: Awaited<ReturnType<typeof applyEdits>>;
      try {
        answer = await applyEdits(ctx, canvasRef as string, plan.edits, {
          compact: true,
          label: (i) => `line ${plan.lines[i] ?? "?"}`,
        });
      } catch (error) {
        if (error instanceof Refusal) return fail(error.message.replace(/ Nothing was changed\.?/, ""));
        if (error instanceof ApiFailure) return fail(error.userMessage ?? error.message);
        throw error;
      }
      if (plan.prints.length) {
        const first = answer.content[0];
        if (first?.type === "text") {
          const body = JSON.parse(first.text) as Record<string, unknown>;
          first.text = JSON.stringify({ ...body, prints: plan.prints }, null, 2);
        }
      }
      return answer;
    }),
  );
}

function refuseWith(message: string, retryId: string, prints: string[]) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: [
          message,
          ...(prints.length ? [`Printed: ${prints.join(" | ")}`] : []),
          `retryId: ${retryId}. ${RETRY_NODE_NOTE}`,
        ].join("\n"),
      },
    ],
  };
}
