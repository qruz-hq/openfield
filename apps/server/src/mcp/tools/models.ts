import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatCost, type ModelListItem, t } from "@openfield/core";
import { estimate, pricedOp, resolveProviderSettings } from "@openfield/providers/manifest";
import { z } from "zod";
import { priceOf } from "../guard";
import { guarded, reply, type ToolContext } from "../kit";
import { buildRequest, imageRequestFields } from "../request";

// Which models there are, what each can do and what it costs.

const OPS: [keyof ModelListItem["capabilities"]["ops"], string][] = [
  ["textToImage", "make images from text"],
  ["imageEdit", "edit an image"],
  ["inpaint", "edit part of an image with a mask"],
  ["outpaint", "extend an image"],
  ["upscale", "upscale"],
  ["removeBackground", "remove the background"],
];

export function modelTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "The image models Openfield has, with what each can do, its sizes and qualities, and its price per image at the speed the person chose. Only models marked ready can run; the others need a key in Openfield's settings.",
      inputSchema: {
        readyOnly: z.boolean().optional().describe("Only models that can run now. Default false."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_models", async ({ readyOnly }) => {
      const { models } = ctx.svc.models.list();
      const defaultModel = ctx.svc.settings.get().defaultModel;
      const rows = models
        .filter((m) => !readyOnly || (m.ready && m.enabled))
        .map((m) => describeModel(ctx, m, m.key === defaultModel));
      return reply({ defaultModel, models: rows });
    }),
  );

  server.registerTool(
    "estimate",
    {
      title: "Estimate a price",
      description:
        "What generate_image would cost for these settings, without making anything. Reference images are brought into the library to check them.",
      inputSchema: imageRequestFields,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "estimate", async (args) => {
      const request = await buildRequest(ctx, args);
      const quote = await ctx.svc.runner.quote(request);
      return reply({
        model: request.model,
        count: request.batch,
        speed: quote.request.speed,
        price: priceOf(quote.estimate),
      });
    }),
  );
}

function describeModel(ctx: ToolContext, m: ModelListItem, isDefault: boolean) {
  const caps = m.capabilities;
  const { schema, stored } = ctx.svc.providerSettings.forRun(m.providerId);
  const { speed } = resolveProviderSettings(schema, stored, m, pricedOp("generate"));
  const perImage = estimate(m, { op: "generate", batch: 1, prompt: "", speed });
  return {
    key: m.key,
    name: m.displayName,
    ...(m.description && { about: m.description }),
    company: ctx.svc.credentials.provider(m.providerId).meta.displayName,
    ready: m.ready && m.enabled,
    ...(!m.enabled ? { note: "Turned off in Settings > Models." } : !m.ready ? { note: "Needs a key." } : {}),
    ...(isDefault && { default: true }),
    can: OPS.filter(([op]) => caps.ops[op]).map(([, words]) => words),
    size:
      caps.size.mode === "aspect"
        ? { aspects: caps.size.ratios, default: caps.size.default }
        : caps.size.mode === "enum"
          ? { sizes: caps.size.sizes.map((s) => `${s.width}x${s.height}`), auto: caps.size.allowAuto }
          : { free: `${caps.size.minEdge} to ${caps.size.maxEdge} px, multiples of ${caps.size.multipleOf}` },
    ...(caps.resolution && {
      resolutions: caps.resolution.tiers,
      defaultResolution: caps.resolution.default,
    }),
    ...(caps.quality && {
      qualities: caps.quality.levels.map((l) => ({ id: l.id, name: l.label })),
      defaultQuality: caps.quality.default,
    }),
    maxImages: caps.batch.max,
    references: caps.references.supported ? caps.references.max : 0,
    seeds: caps.seed.supported,
    negativePrompt: caps.negativePrompt,
    speed: t(`speed.names.${speed}`),
    pricePerImage: perImage.confidence === "unknown" ? null : perImage.max,
    price: formatCost(perImage),
  };
}
