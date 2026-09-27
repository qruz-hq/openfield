import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SPEED_IDS, speedName, speedSettingField, USAGE_SERIES_GROUPS } from "@openfield/core";
import { firstUsageAt, libraryStats, listProviders, usageMinutes } from "@openfield/db";
import { z } from "zod";
import { startOfToday } from "../../services/agents";
import { buildUsageSeries } from "../../services/usage-series";
import { guarded, reply, type ToolContext } from "../kit";

// What's been spent, and how Openfield is set up. Read only: agents never change settings, keys
// or their own limits, and never see a key.

/** The server's own zone: the person's computer, so its clock is theirs. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function accountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_usage",
    {
      title: "Spending",
      description:
        "What was spent on images and how many were made, by model, company, size or where they were made (agent apps by name). Default: today.",
      inputSchema: {
        from: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("Start, included (ISO 8601). Default: midnight today."),
        to: z.iso.datetime({ offset: true }).optional().describe("End, excluded (ISO 8601). Default: now."),
        groupBy: z.enum(USAGE_SERIES_GROUPS).optional().describe("How to split it. Default model."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_usage", async ({ from, to, groupBy }) => {
      const { db } = ctx.svc;
      const start = from ?? startOfToday();
      const series = buildUsageSeries(usageMinutes(db, { from: start, ...(to && { to }) }), {
        from: start,
        to,
        now: new Date(),
        tz: zone(),
        step: "day",
        groupBy: groupBy ?? "model",
        firstAt: firstUsageAt(db),
      });
      return reply({
        from: start,
        to: to ?? new Date().toISOString(),
        currency: series.currency,
        total: series.totals,
        groups: series.groups.map(({ key: _key, ...group }) => group),
        agentsToday: ctx.svc.agents.today(),
      });
    }),
  );

  server.registerTool(
    "get_settings",
    {
      title: "How Openfield is set up",
      description:
        "The person's defaults, which companies are set up and at what speed, the limits on what agents may spend, and where the library is. Read only; keys are never shown.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_settings", async () => {
      const { settings, credentials, db, providerSettings, models, paths } = ctx.svc;
      const s = settings.get();
      const enabled = new Map(listProviders(db).map((p) => [p.id, p.enabled]));
      const stats = libraryStats(db);
      const companies = ctx.svc.providers
        .filter((p) => !models.early(p.meta.id) || s.showExperimental)
        .map((p) => {
          const { schema, stored } = providerSettings.forRun(p.meta.id);
          const field = speedSettingField(schema);
          const chosen = field ? (stored[field.id] ?? field.default) : "standard";
          const speed = SPEED_IDS.find((id) => id === chosen) ?? "standard";
          return {
            id: p.meta.id,
            name: p.meta.displayName,
            on: enabled.get(p.meta.id) ?? true,
            hasKey: credentials.resolve(p.meta.id).present,
            speed: speedName(schema, speed),
          };
        });
      return reply({
        defaults: { model: s.defaultModel, aspect: s.defaultAspect, count: s.defaultBatch },
        companies,
        agents: {
          askBeforeSpendingAboveUsd: s.agentAskAboveUsd,
          dailyLimitUsd: s.agentDailyCapUsd,
          spentToday: ctx.svc.agents.today(),
        },
        monthlyLimitUsd: s.spendGuardUsd,
        library: { folder: paths.root, images: stats.assets, inTrash: stats.trash.count },
      });
    }),
  );
}
