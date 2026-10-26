import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CANVAS_ARCHIVE_EXTENSION, type CanvasArchiveJob, t } from "@openfield/core";
import { z } from "zod";
import { archiveFileName } from "../../files/names";
import { canvasField, describeCanvas, resolveCanvas, saw } from "../canvas";
import { type Extra, guarded, Refusal, reply, type ToolContext } from "../kit";
import { DEFAULT_WAIT_S, MAX_WAIT_S } from "../wait";

// Moving a canvas whole, with every image it shows (§7.8): export_canvas saves it as one
// .ofcanvas.zip on this computer, import_canvas brings one in (or its unzipped folder, or a plain
// .ofcanvas.json). Both run as jobs: a tool waits up to `wait` seconds, telling the app how far
// along it is, then hands back the job id to wait on with the same tool.

const waitField = z
  .int()
  .min(0)
  .max(MAX_WAIT_S)
  .optional()
  .describe(
    `Seconds to wait for it to finish before answering with its job id instead. Default ${DEFAULT_WAIT_S}.`,
  );

const jobField = z
  .string()
  .optional()
  .describe("A job id an earlier answer gave: waits for that one instead of starting another.");

const expand = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/** "<name>.ofcanvas.zip" in Downloads, or "<name> 2.ofcanvas.zip" when that's taken. */
function freeName(dir: string, fileName: string): string {
  const stem = fileName.slice(0, -CANVAS_ARCHIVE_EXTENSION.length);
  let candidate = join(dir, fileName);
  for (let n = 2; existsSync(candidate); n++)
    candidate = join(dir, `${stem} ${n}${CANVAS_ARCHIVE_EXTENSION}`);
  return candidate;
}

/** Where to save: the path given (a folder gets the canvas's file name), else Downloads. */
function exportPath(path: string | undefined, fileName: string): string {
  if (!path) {
    const downloads = join(homedir(), "Downloads");
    return freeName(existsSync(downloads) ? downloads : homedir(), fileName);
  }
  const full = expand(path.trim());
  if (!isAbsolute(full)) throw new Refusal(`"${path}" isn't a full path. Start it with / or ~/.`);
  if (existsSync(full) && statSync(full).isDirectory()) return freeName(full, fileName);
  return full.toLowerCase().endsWith(".zip") ? full : `${full}${CANVAS_ARCHIVE_EXTENSION}`;
}

/** Waits for the job, sending MCP progress as its bytes move. */
async function follow(
  ctx: ToolContext,
  jobId: string,
  seconds: number,
  extra: Extra,
): Promise<CanvasArchiveJob> {
  const token = extra._meta?.progressToken;
  let reported = -1;
  const report = (job: CanvasArchiveJob) => {
    if (token === undefined || job.total <= 0 || job.done <= reported) return;
    reported = job.done;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: job.done,
          total: job.total,
          message: `${job.files.done} of ${job.files.total} files`,
        },
      })
      .catch(() => {});
  };
  const job = await ctx.svc.archives.wait(jobId, seconds * 1000, report);
  if (!job)
    throw new Refusal(`There's no export or import with the id ${jobId}. It may have finished a while ago.`);
  return job;
}

/** What a job that ended badly, or hasn't ended, says to the agent. */
function unfinished(job: CanvasArchiveJob, tool: string) {
  if (job.state === "failed") {
    const error = job.error;
    throw new Refusal(error?.userMessage ?? error?.message ?? t("errors.transport.internal"));
  }
  if (job.state === "canceled") throw new Refusal("It was stopped before it finished. Nothing was changed.");
  return reply({
    finished: false,
    job: job.jobId,
    progress: { files: job.files, bytes: { done: job.done, total: job.total } },
    note: `Still going. Call ${tool} again with job: "${job.jobId}" to keep waiting.`,
  });
}

export function archiveTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "export_canvas",
    {
      title: "Export a canvas",
      description: `Saves a canvas with every image it shows (originals, with their prompts and settings) as one ${CANVAS_ARCHIVE_EXTENSION} file on this computer, for another Openfield to import. Spend and version history aren't included.`,
      inputSchema: {
        canvas: z.string().optional().describe(`${canvasField} Not needed with job.`),
        path: z
          .string()
          .optional()
          .describe(
            `Where to save it: a full file path ending in .zip, or a folder. Default: Downloads/<name>${CANVAS_ARCHIVE_EXTENSION}.`,
          ),
        overwrite: z.boolean().optional().describe("Replace a file already at path. Default false."),
        wait: waitField,
        job: jobField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "export_canvas", async ({ canvas: ref, path, overwrite, wait, job: jobId }, extra) => {
      let id = jobId;
      if (!id) {
        if (!ref) throw new Refusal("Say which canvas to export: pass canvas.");
        const canvas = resolveCanvas(ctx, ref);
        const target = exportPath(path, archiveFileName(canvas.name, t("canvas.names.untitled")));
        id = ctx.svc.archives.exportTo(canvas.id, target, { overwrite: overwrite ?? false }).jobId;
      }
      const job = await follow(ctx, id, wait ?? DEFAULT_WAIT_S, extra);
      if (job.state !== "done" || job.result?.kind !== "export") return unfinished(job, "export_canvas");
      const { path: saved, bytes, assets, missing } = job.result;
      return reply({
        finished: true,
        canvasId: job.canvasId,
        name: job.name,
        path: saved,
        bytes,
        images: assets,
        ...(missing > 0 && {
          missing,
          note: `${missing} image${missing === 1 ? "" : "s"} on the canvas weren't in the library (in the Trash, or the file is gone), so they're left out.`,
        }),
      });
    }),
  );

  server.registerTool(
    "import_canvas",
    {
      title: "Import a canvas",
      description: `Brings in a canvas exported from Openfield: a ${CANVAS_ARCHIVE_EXTENSION} file, the folder it unzips to, or a .ofcanvas.json (the canvas alone; its images show as missing unless they're already here). Images already in the library are used, not copied again. New ones are filed in a folder named after the canvas. show: true opens it in the person's Openfield tab.`,
      inputSchema: {
        path: z.string().optional().describe("The full path to the file or folder. Not needed with job."),
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("A name for the new canvas. Default: the name it was exported with."),
        show: z
          .boolean()
          .optional()
          .describe("Open it in the person's Openfield tab once it's in. Default false."),
        wait: waitField,
        job: jobField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "import_canvas", async ({ path, name, show, wait, job: jobId }, extra) => {
      let id = jobId;
      if (!id) {
        if (!path) throw new Refusal("Say what to import: pass path.");
        const full = expand(path.trim());
        if (!isAbsolute(full)) throw new Refusal(`"${path}" isn't a full path. Start it with / or ~/.`);
        id = ctx.svc.archives.startImport({ path: full }, { ...(name && { name }) }).jobId;
      }
      const job = await follow(ctx, id, wait ?? DEFAULT_WAIT_S, extra);
      if (job.state !== "done" || job.result?.kind !== "import") return unfinished(job, "import_canvas");
      const { canvasId, imported, reused, missing, folderId } = job.result;
      // An imported canvas carries the view it was exported with, from another screen: it opens fitted.
      const tabId = show ? ctx.svc.presence.navigate({ kind: "canvas", id: canvasId, fit: true }) : null;
      const { view, doc } = await describeCanvas(ctx, canvasId);
      saw(ctx, canvasId, view.graphVersion, doc);
      return reply({
        finished: true,
        ...view,
        images: { imported, reused, missing },
        ...(folderId && { folderId }),
        ...(show && { shown: tabId !== null }),
      });
    }),
  );
}
