import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { getJob, getJobSet } from "@openfield/db";
import { z } from "zod";
import { guarded, Refusal, reply, type ToolContext } from "../kit";
import { describeRun, type RunSummary } from "../runs";
import { DEFAULT_WAIT_S, waitField, waitForRuns } from "../wait";

// Runs already started: look, wait, stop.

const runIdField = z.string().describe("A run id, from generate_image, recreate or get_asset.");

export function runTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_job",
    {
      title: "Check a run",
      description: "Where a run is: finished or not, the images it made with previews, and why any failed.",
      inputSchema: {
        runId: runIdField,
        previews: z.boolean().optional().describe("Include image previews. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_job", async ({ runId, previews }) => {
      const { summary, blocks } = await describeRun(ctx, runId, { previews: previews ?? true });
      return reply(summary, blocks);
    }),
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for runs",
      description:
        "Waits until runs finish, or the time is up, then answers with their images. Use it after a tool answered before its images were ready.",
      inputSchema: {
        runIds: z.array(z.string()).min(1).max(8).describe("Run ids to wait for."),
        wait: waitField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "wait_for", async ({ runIds, wait }, extra) => {
      for (const id of runIds)
        if (!getJobSet(ctx.svc.db, id)) throw new Refusal(`There's no run with the id ${id}.`);
      const done = await waitForRuns(ctx, runIds, wait ?? DEFAULT_WAIT_S, extra);
      const runs: RunSummary[] = [];
      const blocks: ImageContent[] = [];
      for (const id of runIds) {
        const described = await describeRun(ctx, id, { previews: true });
        runs.push(described.summary);
        blocks.push(...described.blocks);
      }
      return reply({ finished: done, runs }, blocks);
    }),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Stop a run",
      description:
        "Stops a run, or one image in it. Images already sent to the company may still be charged.",
      inputSchema: {
        runId: runIdField,
        jobId: z.string().optional().describe("Stop only this image of the run (a jobId from get_job)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(ctx, "cancel_job", async ({ runId, jobId }) => {
      if (!getJobSet(ctx.svc.db, runId)) throw new Refusal(`There's no run with the id ${runId}.`);
      if (jobId) {
        if (getJob(ctx.svc.db, jobId)?.jobSetId !== runId) {
          throw new Refusal(`The run ${runId} has no image with the id ${jobId}.`);
        }
        ctx.svc.runner.cancelJob(jobId);
      } else {
        ctx.svc.runner.cancelJobSet(runId);
      }
      const { summary } = await describeRun(ctx, runId, { previews: false });
      return reply({
        ...summary,
        note: "Stopped. Anything the company had already started may still be charged.",
      });
    }),
  );
}
