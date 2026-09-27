import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getAsset, libraryPage } from "@openfield/db";
import { imageInfo, PREVIEW_EDGE, preview } from "./images";
import type { ToolContext } from "./kit";

// Library images as resources, for apps that let the person attach one (openfield://asset/<id>).
// The canvas resource joins with the canvas tools.

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
    async (uri, { id }) => {
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
}
