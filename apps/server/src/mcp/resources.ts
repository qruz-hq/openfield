import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AgentAction } from "@openfield/core";
import { getAsset, getCanvas, libraryPage } from "@openfield/db";
import { canvasUrl, describeCanvas, saw } from "./canvas";
import { imageInfo, PREVIEW_EDGE, preview } from "./images";
import type { Extra, ToolContext } from "./kit";
import { askPerson, decide } from "./permissions";

// Library images and canvases as resources, for apps that let the person attach one
// (openfield://asset/<id>, openfield://canvas/<id>).

/** How many recent images the resource list offers. */
const RECENT = 50;

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "asset",
    new ResourceTemplate("openfield://asset/{id}", {
      list: async () => {
        const page = libraryPage(ctx.svc.db, { limit: RECENT });
        return {
          resources: page.items.map((item) => ({
            uri: `openfield://asset/${item.id}`,
            name: item.prompt ? item.prompt.slice(0, 80) : `Image ${item.id}`,
            mimeType: "image/jpeg",
          })),
        };
      },
    }),
    {
      title: "Library image",
      description: "An image from the Openfield library: a preview up to 1024 px, and its details.",
      mimeType: "image/jpeg",
    },
    async (uri, { id }, extra) => {
      await permitRead(ctx, extra, "read_images", "look at an image in your library");
      const row = getAsset(ctx.svc.db, String(id), { includeDeleted: true });
      if (!row) throw new McpError(ErrorCode.InvalidParams, `There's no image with the id ${String(id)}.`);
      const image = await preview(ctx, row, PREVIEW_EDGE * 2);
      const details = {
        ...imageInfo(ctx, row),
        prompt: row.prompt,
        model: row.providerId && row.modelId ? `${row.providerId}:${row.modelId}` : null,
        createdAt: row.createdAt,
      };
      return {
        contents: [
          ...(image ? [{ uri: uri.href, mimeType: image.mimeType, blob: image.data }] : []),
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(details, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    "canvas",
    new ResourceTemplate("openfield://canvas/{id}", {
      list: async () => ({
        resources: ctx.svc.canvases.list().map((c) => ({
          uri: `openfield://canvas/${c.id}`,
          name: c.name,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Canvas",
      description:
        "An Openfield canvas: its nodes, their settings and states, and its connections, as get_canvas gives them.",
      mimeType: "application/json",
    },
    async (uri, { id }, extra) => {
      await permitRead(ctx, extra, "read_canvases", "read one of your canvases");
      if (!getCanvas(ctx.svc.db, String(id))) {
        throw new McpError(ErrorCode.InvalidParams, `There's no canvas with the id ${String(id)}.`);
      }
      const { view, doc } = await describeCanvas(ctx, String(id));
      saw(ctx, view.canvasId, view.graphVersion, doc);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...view, url: canvasUrl(ctx, view.canvasId) }, null, 2),
          },
        ],
      };
    },
  );
}

/** A read set to Ask checks with the person first; an app that can't ask is sent to the tools. */
async function permitRead(ctx: ToolContext, extra: Extra, action: AgentAction, what: string): Promise<void> {
  if (decide(ctx, action) !== "ask") return;
  const answer = await askPerson(ctx, extra, `${ctx.session.client} wants to ${what}. Allow it?`);
  if (answer === "yes") return;
  throw new McpError(
    ErrorCode.InvalidRequest,
    answer === "no"
      ? "The person said no."
      : "The person asked Openfield to check with them first. Use get_canvas or get_asset with confirm: true once they agree.",
  );
}
