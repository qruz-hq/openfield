import { type BatchUpdated, errorCopy, type JobSetWithJobs, type SseEvent, t } from "@openfield/core";
import { useEffect } from "react";
import { type BatchNameLookups, batchNotice } from "../lib/batch-copy";
import { announce, useLive } from "../lib/live";
import { notify } from "../lib/notify";
import { inCanvas, revealCanvas, revealJobSet } from "../lib/reveal";
import { systemNotify } from "../lib/system-notify";
import { queryClient, queryKeys } from "./client";
import { patchAsset, prependAsset, removeAssets } from "./hooks/assets";
import { patchBatch, patchJob, patchJobSet, upsertJobSet } from "./hooks/job-sets";
import { providersQuery } from "./hooks/keys";
import { modelsQuery } from "./hooks/models";
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
  // A Batch run that wasn't canceled gets a finish toast, and the toaster is already a live region.
  if (set?.batch && !set.batch.stopping && status !== "canceled") return;
  const ready = set?.jobs.filter((job) => job.status === "succeeded").length ?? 0;
  if (ready > 0) return announce(t("feed.announce.ready", { count: ready }));
  if (status === "canceled") return announce(t("toast.canceled"));
  const failed = set?.jobs.find((job) => job.errorCode);
  announce(failed?.errorReason ?? errorCopy(failed?.errorCode ?? "unknown").reason);
}

function jobSetsCache(): JobSetWithJobs[] {
  return queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets) ?? [];
}

const findJob = (jobSetId: string, jobId: string) =>
  jobSetsCache()
    .find((s) => s.jobSet.id === jobSetId)
    ?.jobs.find((job) => job.id === jobId);

/** Names for the finish notice, fetched when this tab hasn't loaded them yet. */
const names: BatchNameLookups = {
  model: async (key) =>
    (await queryClient.ensureQueryData(modelsQuery)).models.find((m) => m.key === key)?.displayName,
  company: async (id) =>
    (await queryClient.ensureQueryData(providersQuery)).find((p) => p.id === id)?.meta.displayName,
};

/**
 * A Batch run finished: one toast and one system notification, whether the tab was open all along
 * or reconnects later (§2.4). A run the person canceled already said so when they did.
 */
async function batchFinished(frame: BatchUpdated) {
  if (announced.has(`batch:${frame.jobSetId}`)) return;
  announced.add(`batch:${frame.jobSetId}`);
  void queryClient.invalidateQueries({ queryKey: queryKeys.usageToday });
  if (frame.state === "canceled") return;

  const set = jobSetsCache().find((s) => s.jobSet.id === frame.jobSetId);
  const copy = await batchNotice(frame, set?.jobs, names);
  // A canvas run's Show opens its canvas. Already in it, the node shows the result, so there's no Show.
  const canvasId = frame.canvasId ?? set?.jobSet.canvasId ?? null;
  const here = canvasId !== null && inCanvas(canvasId);
  const show = () => {
    if (canvasId) return inCanvas(canvasId) ? undefined : revealCanvas(canvasId);
    // Leave the toast first: the toaster hands focus back to where it came from as it's left,
    // which would otherwise pull focus off the tile Show brings up.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    revealJobSet(frame.jobSetId);
  };
  notify(copy.title, {
    tone: copy.made ? "success" : "danger",
    description: copy.detail,
    duration: 10_000,
    ...(!here && { action: { label: t("actions.show"), onClick: show } }),
  });
  systemNotify(copy.body, { tag: frame.jobSetId, onClick: show });
}

function batchUpdated(frame: BatchUpdated) {
  const { state, submittedAt, expiresAt, counts, stopping } = frame;
  patchBatch(frame.jobSetId, { state, submittedAt, expiresAt, counts, stopping });
  const live = frame.finished
    ? undefined
    : { providerId: frame.providerId, state, stopping: stopping === true };
  useLive.getState().setBatch(frame.jobSetId, live);
  if (frame.finished) void batchFinished(frame);
}

type FrameListener = (event: SseEvent) => void;
const listeners = new Set<FrameListener>();

/** Every frame, after the cache has it. The canvas engine follows its runs this way. */
export function subscribeEvents(listener: FrameListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyEvent(event: SseEvent) {
  applyToCache(event);
  for (const listener of listeners) listener(event);
}

function applyToCache(event: SseEvent) {
  const { setPosition, setRetry } = useLive.getState();
  switch (event.event) {
    case "snapshot":
      for (const set of event.data.activeJobSets) upsertJobSet(set);
      // The snapshot lists every Batch run in flight, so one that ended while offline drops out.
      useLive.getState().clearBatches();
      for (const batch of event.data.batches) batchUpdated(batch);
      return;
    case "job_set.created":
      upsertJobSet(event.data);
      announceStarted(event.data);
      return;
    case "job.queued": {
      const { jobSetId, jobId, position, retryAt, busy } = event.data;
      patchJob(jobSetId, jobId, { status: "queued", nextAttemptAt: retryAt ?? null });
      setPosition(jobId, position);
      setRetry(jobId, retryAt ? { at: retryAt, busy: busy === true } : undefined);
      return;
    }
    case "job.started": {
      const { jobSetId, jobId, startedAt, rerun } = event.data;
      // The snapshot after a restart carries rerunAt; this covers a tab that loaded the run before it.
      const rerunAt = rerun ? (findJob(jobSetId, jobId)?.rerunAt ?? startedAt) : undefined;
      patchJob(jobSetId, jobId, {
        status: "running",
        startedAt,
        nextAttemptAt: null,
        ...(rerunAt ? { rerunAt } : {}),
      });
      setPosition(jobId, undefined);
      setRetry(jobId, undefined);
      return;
    }
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
        errorAction: event.data.error.action ?? null,
        // The frame carries no time; a refetch replaces this with the server's.
        finishedAt: new Date().toISOString(),
      });
      setPosition(event.data.jobId, undefined);
      setRetry(event.data.jobId, undefined);
      return;
    case "job.canceled":
      patchJob(event.data.jobSetId, event.data.jobId, { status: "canceled", errorCode: "canceled" });
      setPosition(event.data.jobId, undefined);
      setRetry(event.data.jobId, undefined);
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
    case "batch.updated":
      batchUpdated(event.data);
      return;
    default:
      // Canvas runs reach the canvas engine through subscribeEvents. Partial previews, folders and
      // maintenance aren't on these screens yet.
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
