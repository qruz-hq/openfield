import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAsset, getCanvas } from "@openfield/db";
import { z } from "zod";
import { canvasUrl, reading, resolveCanvas } from "../canvas";
import { appUrl } from "../images";
import { guarded, Refusal, reply, type ToolContext } from "../kit";

// The person's own Openfield tab: what they're looking at, and opening something there for them.

export function presenceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_active_canvas",
    {
      title: "What's open",
      description:
        'The canvas open in the Openfield tab the person used last, and the nodes they have selected there. Use it for "this canvas" or "the selected node". Other tools take "active" for this canvas.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_active_canvas", async () => {
      const tab = ctx.svc.presence.active();
      if (!tab) return reply({ open: false, note: "No Openfield tab is open." });
      const row = tab.canvasId ? getCanvas(ctx.svc.db, tab.canvasId) : undefined;
      if (!row)
        return reply({ open: true, page: tab.path, canvas: null, note: "The tab isn't showing a canvas." });
      reading(ctx, row.id, tab.selection);
      return reply({
        open: true,
        page: tab.path,
        canvas: {
          canvasId: row.id,
          name: row.name,
          graphVersion: row.graphVersion,
          url: canvasUrl(ctx, row.id),
        },
        selected: tab.selection,
      });
    }),
  );

  server.registerTool(
    "show",
    {
      title: "Show in Openfield",
      description:
        "Opens a canvas (optionally selecting and bringing some of its nodes into view), an image, or a page in the person's Openfield tab. With no tab open, answers with the link instead.",
      inputSchema: {
        canvas: z.string().optional().describe('A canvas id, exact name or "active".'),
        nodeIds: z
          .array(z.string())
          .max(500)
          .optional()
          .describe("With canvas: nodes to select and bring into view."),
        assetId: z.string().optional().describe("An image to open in the detail view."),
        page: z
          .enum(["image", "assets", "canvas", "settings", "spending", "agents"])
          .optional()
          .describe("A page of the app."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "show", async ({ canvas: ref, nodeIds, assetId, page }) => {
      const given = [ref, assetId, page].filter((v) => v !== undefined).length;
      if (given !== 1) throw new Refusal("Pass one of canvas, assetId or page.");
      let url: string;
      let tabId: string | null;
      if (ref !== undefined) {
        const canvas = resolveCanvas(ctx, ref);
        url = canvasUrl(ctx, canvas.id);
        tabId = ctx.svc.presence.navigate({
          kind: "canvas",
          id: canvas.id,
          ...(nodeIds?.length && { nodeIds }),
        });
      } else if (assetId !== undefined) {
        if (!getAsset(ctx.svc.db, assetId, { includeDeleted: true })) {
          throw new Refusal(`There's no image with the id ${assetId}.`);
        }
        url = appUrl(ctx, assetId);
        tabId = ctx.svc.presence.navigate({ kind: "asset", id: assetId });
      } else {
        const path = PAGES[page!];
        url = `http://127.0.0.1:${ctx.svc.port}${path}`;
        tabId = ctx.svc.presence.navigate({ kind: "path", path });
      }
      return reply(
        tabId
          ? { shown: true, url }
          : { shown: false, url, note: "No Openfield tab is open. Give the person this link instead." },
      );
    }),
  );
}

const PAGES = {
  image: "/image",
  assets: "/assets",
  canvas: "/canvas",
  settings: "/settings",
  spending: "/settings/spending",
  agents: "/settings/agents",
} as const;
