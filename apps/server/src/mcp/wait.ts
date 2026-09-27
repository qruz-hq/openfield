import { isTerminalState, TERMINAL_JOB_STATES } from "@openfield/core";
import { getJobSet, jobsOf } from "@openfield/db";
import { z } from "zod";
import type { Extra, ToolContext } from "./kit";

// Tools that start images wait for them, up to `wait` seconds, telling the app how far along they
// are. Past that they hand back the run id for wait_for. A Batch-speed run takes hours, so it's
// handed back at once.

export const DEFAULT_WAIT_S = 120;
export const MAX_WAIT_S = 600;

export const waitField = z
  .int()
  .min(0)
  .max(MAX_WAIT_S)
  .optional()
  .describe(
    `Seconds to wait for the images before answering with the run id instead. Default ${DEFAULT_WAIT_S}. 0 answers at once.`,
  );

const TERMINAL = new Set<string>(TERMINAL_JOB_STATES);
const POLL_MS = 1_000;

/** True when every run is finished. */
export function allDone(ctx: ToolContext, jobSetIds: readonly string[]): boolean {
  return jobSetIds.every((id) => {
    const set = getJobSet(ctx.svc.db, id);
    return !set || isTerminalState(set.status);
  });
}

/** Waits until every run is finished, the time is up, or the app gives up. True when finished. */
export function waitForRuns(
  ctx: ToolContext,
  jobSetIds: readonly string[],
  seconds: number,
  extra: Extra,
): Promise<boolean> {
  const { db, events } = ctx.svc;
  if (allDone(ctx, jobSetIds)) return Promise.resolve(true);
  if (seconds <= 0) return Promise.resolve(false);
  if (jobSetIds.some((id) => getJobSet(db, id)?.speed === "batch")) return Promise.resolve(false);

  const ids = new Set(jobSetIds);
  const token = extra._meta?.progressToken;
  const total = jobSetIds.reduce((n, id) => n + (getJobSet(db, id)?.batchSize ?? 0), 0);
  let reported = -1;

  // Progress counts finished images, and a share of each running one when its company says.
  const report = () => {
    if (token === undefined) return;
    let finished = 0;
    let progress = 0;
    for (const id of ids) {
      for (const job of jobsOf(db, id)) {
        if (TERMINAL.has(job.status)) {
          finished++;
          progress++;
        } else progress += job.progress ?? 0;
      }
    }
    // Each notification has to move forward (MCP progress).
    if (progress <= reported) return;
    reported = progress;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          total,
          message: `${finished} of ${total} ${total === 1 ? "image" : "images"} done`,
        },
      })
      .catch(() => {});
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(poll);
      clearTimeout(timer);
      extra.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const check = () => {
      report();
      if (allDone(ctx, jobSetIds)) finish(true);
    };
    const unsubscribe = events.subscribe((event, data) => {
      if (!event.startsWith("job")) return;
      const payload = data as { jobSetId?: string; jobSet?: { id: string } };
      const id = payload.jobSetId ?? payload.jobSet?.id;
      if (id && ids.has(id)) check();
    });
    // Belt and braces: an event missed between the first check and subscribing.
    const poll = setInterval(check, POLL_MS);
    const timer = setTimeout(() => finish(allDone(ctx, jobSetIds)), seconds * 1000);
    const onAbort = () => finish(allDone(ctx, jobSetIds));
    extra.signal.addEventListener("abort", onAbort);
    check();
  });
}
