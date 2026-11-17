import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type CostEstimate, LAYER_SIZES, LAYERS_MAX, type ModelKey, newId } from "@openfield/core";
import { z } from "zod";
import { layersRequest } from "../../services/layers";
import { approveSpend, checkSpend, priceOf, spendFields, spendMode } from "../guard";
import { guarded, Refusal, reply, type ToolContext } from "../kit";
import { IMAGE_REF_HINT, resolveImage } from "../refs";
import { pickModel } from "../request";
import { describeRun } from "../runs";
import { DEFAULT_WAIT_S, waitField, waitForRuns } from "../wait";

// Layer separation: one image in, a base and transparent layers out, each a library image of its
// own: up to 16, or up to as many as asked for (1 to 99) on models that take a number. The model
// decides how many there are, so the price is a range up to the most.

type Started = { stop: CallToolResult } | { stop?: undefined; runId: string; estimate: CostEstimate };

export function layerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "separate_layers",
    {
      title: "Separate an image into layers",
      description:
        "Splits one image into a base and separate transparent layers, each cropped to its own part of the picture, for models with layers in list_models. " +
        "Most models make up to 16 layers. Those whose list_models entry has layers.choose make up to maxLayers (1 to 99, 16 by default). " +
        "Every layer lands in the library with its name, its place on the image and its order; a text layer also carries the words on it, line by line, with each line's box, its approximate font and colour (layers.text in list_models). The words are part of the picture, not live text. " +
        "Costs money, and the model decides how many layers to make: the price is a range, from a base and one layer to a base and the most. Check it with dryRun first.",
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
        maxLayers: z
          .int()
          .min(1)
          .max(LAYERS_MAX)
          .optional()
          .describe(
            `The most layers to make, besides the base, 1 to ${LAYERS_MAX}, on models with layers.choose in list_models. Default 16. Each layer that comes back is billed, so a higher number can cost more. Leave out for other models: they decide for themselves.`,
          ),
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
      if (args.maxLayers !== undefined && !ctx.svc.models.get(model)?.capabilities.layers?.choose) {
        throw new Refusal(
          `${ctx.svc.models.get(model)?.displayName ?? model} decides how many layers to make. Leave out maxLayers, or pick a model with layers.choose in list_models.`,
        );
      }
      const image = await resolveImage(ctx, args.image);
      const request = layersRequest({
        idempotencyKey: newId(),
        model,
        image: image.id,
        ...(args.size && { size: args.size }),
        ...(args.maxLayers !== undefined && { maxLayers: args.maxLayers }),
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
      "No model that separates layers is ready. Seedream 5.5, 5.0 Pro and 5.0 Flash can, with a BytePlus key in Openfield, Settings > API keys.",
    );
  }
  return model.key;
}

/** The stack once it's made: each layer's image id, name, order, box on the base and any words. */
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
      ...(l.text && { text: l.text }),
    }));
  } catch {
    // Not made yet, or it failed: the run's own summary says which.
    return undefined;
  }
}
