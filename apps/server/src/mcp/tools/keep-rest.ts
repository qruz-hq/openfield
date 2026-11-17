import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KEEP_REST_MODES, KEEP_REST_SENSITIVITY, MASK_COMPOSITE_MAX_PX } from "@openfield/core";
import { getAsset } from "@openfield/db";
import { z } from "zod";
import { imageInfo, preview } from "../images";
import { keepRestView, nodesHolding } from "../keep-rest";
import { guarded, Refusal, reply, type ToolContext } from "../kit";

// Keep the rest after an edit, on a library image (§0.9). The model's own result is kept with every
// edit made with a mask or marks, so how the rest is kept can change afterwards, for free, and the
// model's result can be saved as an image of its own. get_asset reads the state (keepRest).

const editField = z.string().describe("An edited image's id, from a run or search_assets.");

export function keepRestTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "adjust_edit",
    {
      title: "Adjust how an edit keeps the rest",
      description:
        "Blends an edited image again with other keep-the-rest settings, in place and for free: no new image is made and nothing is billed. get_asset shows its settings now (keepRest). " +
        "Settings left out stay as they are. To keep the model's whole result instead, use save_model_result. An image an Edit node on a canvas made changes with that node's settings (update_node), so the canvas keeps up.",
      inputSchema: {
        assetId: editField,
        mode: z
          .enum(KEEP_REST_MODES)
          .optional()
          .describe(
            '"smart": follow what the model really changed, starting from the mask or marks. "mask": keep exactly the mask, grown and softened.',
          ),
        sensitivity: z
          .int()
          .min(KEEP_REST_SENSITIVITY.min)
          .max(KEEP_REST_SENSITIVITY.max)
          .optional()
          .describe('"smart" only: 0 to 100, higher keeps more of the model\'s small changes.'),
        expandPx: z
          .int()
          .min(0)
          .max(MASK_COMPOSITE_MAX_PX)
          .optional()
          .describe("Grow the area the model changes by this many pixels."),
        featherPx: z
          .int()
          .min(0)
          .max(MASK_COMPOSITE_MAX_PX)
          .optional()
          .describe("Blend the edit into the original over this many more pixels."),
        clearFixes: z
          .boolean()
          .optional()
          .describe("Drop the spots the person fixed by hand (touchedUp in get_asset)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "adjust_edit", async ({ assetId, mode, sensitivity, expandPx, featherPx, clearFixes }) => {
      const row = getAsset(ctx.svc.db, assetId, { includeDeleted: true });
      if (!row) throw new Refusal(`There's no image with the id ${assetId}.`);
      for (const held of nodesHolding(ctx, assetId)) {
        if (held.locked) {
          throw new Refusal(
            `This image is on a locked node (${held.nodeId}) on the canvas "${held.canvasName}". Only the person can unlock it. Nothing was changed.`,
          );
        }
        if (held.edit) {
          throw new Refusal(
            `Edit node ${held.nodeId} on the canvas "${held.canvasName}" made this image. Change that node's settings with update_node instead, so the canvas keeps up. Nothing was changed.`,
          );
        }
      }
      const out = await ctx.svc.keepRest.apply(assetId, {
        keep: true,
        ...(mode !== undefined && { mode }),
        ...(sensitivity !== undefined && { sensitivity }),
        ...(expandPx !== undefined && { expandPx }),
        ...(featherPx !== undefined && { featherPx }),
        ...(clearFixes && { fixes: "clear" as const }),
      });
      const now = getAsset(ctx.svc.db, assetId)!;
      const block = await preview(ctx, now);
      return reply(
        {
          ...imageInfo(ctx, now),
          changed: out.changed,
          ...(!out.changed && { note: "These settings make the same image, so nothing was rewritten." }),
          keepRest: keepRestView(out.state),
        },
        block ? [block] : [],
      );
    }),
  );

  server.registerTool(
    "save_model_result",
    {
      title: "Save the model's own result",
      description:
        "Saves the model's own result for an edited image as a library image of its own, for free: everything the model changed, with nothing of the original put back. The edit itself stays as it is. Saving it again gives the same image back.",
      inputSchema: { assetId: editField },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "save_model_result", async ({ assetId }) => {
      if (!getAsset(ctx.svc.db, assetId, { includeDeleted: true })) {
        throw new Refusal(`There's no image with the id ${assetId}.`);
      }
      const saved = await ctx.svc.keepRest.save(assetId);
      const row = getAsset(ctx.svc.db, saved.asset.id)!;
      const block = await preview(ctx, row);
      return reply(
        {
          ...imageInfo(ctx, row),
          madeFrom: assetId,
          ...(saved.existing && { note: "It was saved already, so that image came back." }),
        },
        block ? [block] : [],
      );
    }),
  );
}
