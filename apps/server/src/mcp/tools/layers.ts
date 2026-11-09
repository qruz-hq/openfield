import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type CostEstimate, LAYER_SIZES, type ModelKey, newId } from "@openfield/core";
import { z } from "zod";
import { layersRequest } from "../../services/layers";
import { approveSpend, checkSpend, priceOf, spendFields, spendMode } from "../guard";
import { guarded, Refusal, reply, type ToolContext } from "../kit";
import { IMAGE_REF_HINT, resolveImage } from "../refs";
import { pickModel } from "../request";
import { describeRun } from "../runs";
import { DEFAULT_WAIT_S, waitField, waitForRuns } from "../wait";

// Layer separation: one image in, a base and up to 16 transparent layers out, each a library image
// of its own. The model decides how many layers there are, so the price is a range up to the most.

type Started = { stop: CallToolResult } | { stop?: undefined; runId: string; estimate: CostEstimate };

export function layerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "separate_layers",
    {
      title: "Separate an image into layers",
      description:
        "Splits one image into a base and separate transparent layers (up to 16), each cropped to its own part of the picture, for models with layers in list_models. " +
        "Every layer lands in the library with its name, its place on the image and its order. " +
        "Costs money, and the model decides how many layers to make: the price is a range, from a base and one layer to a base and 16. Check it with dryRun first.",
      inputSchema: {
        image: z
          .string()
          .describe(`The image to separate: a PNG or JPEG of at least 512x512. ${IMAGE_REF_HINT}`),
        model: z
          .string()
          .optional()
          .describe(
            "A model with layers in list_models. Default: the person's default, if it can, else the first that can.",
          ),
        size: z
          .enum(LAYER_SIZES)
          .optional()
          .describe('The size the layers come out at. "auto" (the default) keeps the image\'s own size.'),
        prompt: z
          .string()
          .max(4000)
          .optional()
          .describe(
            "Optional: which parts to separate, in words. Without one the model picks the main parts.",
          ),
        ...spendFields,
        wait: waitField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(ctx, "separate_layers", async (args, extra) => {
      const model = layerModel(ctx, args.model);
      const image = await resolveImage(ctx, args.image);
      const request = layersRequest({
        idempotencyKey: newId(),
        model,
        image: image.id,
        ...(args.size && { size: args.size }),
        ...(args.prompt && { prompt: args.prompt }),
        source: "api",
      });
      const mode = spendMode(ctx, "make_images");
      const first = await ctx.svc.runner.quote(request);
      const asked = await approveSpend(ctx, extra, first.estimate, args, {
        mode,
        what: "separate an image into layers",
      });
      if ("stop" in asked) return asked.stop;
      const started = await ctx.svc.agents.spending(async (): Promise<Started> => {
        const quote = await ctx.svc.runner.quote(request);
        const stop = checkSpend(ctx, quote.estimate, { ...args, confirmCost: asked.confirmCost }, mode);
        if (stop) return { stop };
        const accepted = await ctx.svc.runner.createJobSet(request, { agent: ctx.session.client });
        return { runId: accepted.jobSet.id, estimate: quote.estimate };
      });
      if (started.stop) return started.stop;
      await waitForRuns(ctx, [started.runId], args.wait ?? DEFAULT_WAIT_S, extra);
      const { summary, blocks } = await describeRun(ctx, started.runId, { previews: true });
      return reply(
        { ...summary, layers: stackOf(ctx, started.runId), price: priceOf(started.estimate) },
        blocks,
      );
    }),
  );
}

/** The model asked for, which must separate layers, or the first ready one that does. */
function layerModel(ctx: ToolContext, requested: string | undefined): ModelKey {
  if (requested) {
    const key = pickModel(ctx, requested);
    if (!ctx.svc.models.get(key)?.capabilities.layers) {
      throw new Refusal(
        `${ctx.svc.models.get(key)?.displayName ?? key} can't separate layers. Call list_models for one with layers.`,
      );
    }
    return key;
  }
  const { models } = ctx.svc.models.list();
  const usable = models.filter((m) => m.ready && m.enabled && m.capabilities.layers);
  const preferred = ctx.svc.settings.get().defaultModel;
  const model = usable.find((m) => m.key === preferred) ?? usable[0];
  if (!model) {
    throw new Refusal(
      "No model that separates layers is ready. Seedream 5.0 Pro and Flash can, with a BytePlus key in Openfield, Settings > API keys.",
    );
  }
  return model.key;
}

/** The stack once it's made: each layer's image id, name, order and box on the base. */
function stackOf(ctx: ToolContext, runId: string) {
  try {
    const { layers } = ctx.svc.layers.response(ctx.svc.layers.stack(runId));
    return layers.map((l) => ({
      assetId: l.asset.id,
      role: l.role,
      zIndex: l.zIndex,
      box: l.box,
      ...(l.name && { name: l.name }),
      ...(l.description && { description: l.description }),
    }));
  } catch {
    // Not made yet, or it failed: the run's own summary says which.
    return undefined;
  }
}
