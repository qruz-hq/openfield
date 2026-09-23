import { errorCopy, type JobSetWithJobs, type SseEvent, t } from "@openfield/core";
import { useEffect } from "react";
import { announce, useLive } from "../lib/live";
import { queryClient, queryKeys } from "./client";
import { patchAsset, prependAsset, removeAssets } from "./hooks/assets";
import { patchJob, patchJobSet, upsertJobSet } from "./hooks/job-sets";
import { ApiError, readEventStream } from "./raw";

// One stream, GET /api/events. Each frame patches the cache in place, so the feed never
// refetches on a job update (§2.3). When the stream is down, the feed polls instead.

const announced = new Set<string>();

/** "Generating 4 images", once per run. */
export function announceStarted(set: JobSetWithJobs) {
  if (announced.has(`start:${set.jobSet.id}`)) return;
  announced.add(`start:${set.jobSet.id}`);
  announce(t("feed.announce.started", { count: set.jobs.length }));
}

function announceFinished(jobSetId: string, status: string) {
  if (announced.has(`end:${jobSetId}`)) return;
  announced.add(`end:${jobSetId}`);
  const set = queryClient
    .getQueryData<JobSetWithJobs[]>(queryKeys.jobSets)
    ?.find((s) => s.jobSet.id === jobSetId);
  const ready = set?.jobs.filter((job) => job.status === "succeeded").length ?? 0;
  if (ready > 0) return announce(t("feed.announce.ready", { count: ready }));
  if (status === "canceled") return announce(t("toast.canceled"));
  const failed = set?.jobs.find((job) => job.errorCode);
  announce(failed?.errorReason ?? errorCopy(failed?.errorCode ?? "unknown").reason);
}

function jobSetsCache(): JobSetWithJobs[] {
  return queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets) ?? [];
}

export function applyEvent(event: SseEvent) {
  const setPosition = useLive.getState().setPosition;
  switch (event.event) {
    case "snapshot":
      for (const set of event.data.activeJobSets) upsertJobSet(set);
      return;
    case "job_set.created":
      upsertJobSet(event.data);
      announceStarted(event.data);
      return;
    case "job.queued":
      patchJob(event.data.jobSetId, event.data.jobId, { status: "queued" });
      setPosition(event.data.jobId, event.data.position);
      return;
    case "job.started":
      patchJob(event.data.jobSetId, event.data.jobId, { status: "running", startedAt: event.data.startedAt });
      setPosition(event.data.jobId, undefined);
      return;
    case "job.progress":
      patchJob(event.data.jobSetId, event.data.jobId, { progress: event.data.progress });
      return;
    case "job.output":
      patchJob(event.data.jobSetId, event.data.jobId, { status: "succeeded", assetId: event.data.asset.id });
      prependAsset(event.data.asset);
      return;
    case "job.failed":
      patchJob(event.data.jobSetId, event.data.jobId, {
        status: "failed",
        errorCode: event.data.error.code,
        errorMessage: event.data.error.message,
        errorReason: event.data.error.reason ?? null,
        // The frame carries no time; a refetch replaces this with the server's.
        finishedAt: new Date().toISOString(),
      });
      setPosition(event.data.jobId, undefined);
      return;
    case "job.canceled":
      patchJob(event.data.jobSetId, event.data.jobId, { status: "canceled", errorCode: "canceled" });
      setPosition(event.data.jobId, undefined);
      return;
    case "job_set.completed":
      patchJobSet(event.data.jobSetId, {
        status: event.data.status,
        costActualUsd: event.data.costActualUsd,
      });
      announceFinished(event.data.jobSetId, event.data.status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.usageToday });
      return;
    case "asset.updated":
      patchAsset(event.data.asset);
      return;
    case "asset.deleted":
      removeAssets(event.data.assetIds);
      return;
    case "models.updated":
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
      return;
    case "usage.updated":
      void queryClient.invalidateQueries({ queryKey: queryKeys.usageToday });
      return;
    default:
      // Partial previews, folders, canvas runs and maintenance aren't on these screens yet.
      return;
  }
}

// Short, so a restarted server is back within a few seconds (§8.4.6 asks for 5).
const BACKOFF_MS = [500, 1000, 2000, 3000];

/** Keeps the stream open for the life of the app, reconnecting with backoff. */
export function useEventStream() {
  useEffect(() => {
    const controller = new AbortController();
    const { setConnected } = useLive.getState();
    let lastEventId: string | undefined;
    let failures = 0;
    let everConnected = false;

    const run = async () => {
      while (!controller.signal.aborted) {
        let renewed = false;
        try {
          await readEventStream({
            signal: controller.signal,
            lastEventId,
            onOpen: () => {
              failures = 0;
              everConnected = true;
              setConnected(true);
              // Anything missed while offline: the snapshot covers active runs, this covers the rest.
              if (jobSetsCache().length) void queryClient.invalidateQueries({ queryKey: queryKeys.jobSets });
            },
            onEvent: (event, id) => {
              if (id) lastEventId = id;
              applyEvent(event);
            },
          });
        } catch (error) {
          // A 403 that picked up the restarted server's new token is worth trying again at once.
          renewed = error instanceof ApiError && error.status === 403 && error.retryable;
        }
        if (controller.signal.aborted) return;
        failures++;
        setConnected(false, everConnected || failures >= 2);
        if (renewed) continue;
        const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]!;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    };
    void run();
    return () => controller.abort();
  }, []);
}
