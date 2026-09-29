import {
  ACTIVE_JOB_STATES,
  type BatchSummary,
  type GenerateBody,
  type Job,
  type JobSet,
  type JobSetWithJobs,
  type PixelSize,
  type SpeedId,
} from "@openfield/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, call, queryClient, queryKeys } from "../client";

// Runs on the feed: placeholders while they work, failed tiles when they don't (§2.4). The Image
// and Video pages each cache their own modality's list, so a run of one kind never shows on the
// other's feed; patches below reach into whichever list actually holds the run (§0.16).

/** Only the modalities a page's feed can be. audio has no page yet. */
export type JobModality = "image" | "video";

export const isActiveJob = (job: Pick<Job, "status">) =>
  (ACTIVE_JOB_STATES as readonly string[]).includes(job.status);

const JOB_SET_LIMIT = 50;

export function useJobSets({ poll, modality = "image" }: { poll: boolean; modality?: JobModality }) {
  return useQuery({
    queryKey: queryKeys.jobSets(modality),
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets(modality));
      const res = await call(
        api.api["job-sets"].$get(
          { query: { status: "all", limit: String(JOB_SET_LIMIT), modality } },
          { init: { signal } },
        ),
      );
      // While polling, a run that finished since last time means new images to fetch.
      if (previous && finishedSince(previous, res.items)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.allAssets });
      }
      return mergeOptimistic(modality, res.items);
    },
    refetchInterval: poll ? 2000 : false,
  });
}

function finishedSince(before: readonly JobSetWithJobs[], after: readonly JobSetWithJobs[]): boolean {
  const wasActive = new Set(before.flatMap((set) => set.jobs.filter(isActiveJob).map((job) => job.id)));
  return after.some((set) => set.jobs.some((job) => wasActive.has(job.id) && job.status === "succeeded"));
}

// Placeholders show the moment Generate is pressed, before the server answers (§2.4).
const OPTIMISTIC = "optimistic:";
export const isOptimistic = (jobSetId: string) => jobSetId.startsWith(OPTIMISTIC);

function mergeOptimistic(modality: JobModality, items: JobSetWithJobs[]): JobSetWithJobs[] {
  const pending = queryClient
    .getQueryData<JobSetWithJobs[]>(queryKeys.jobSets(modality))
    ?.filter((s) => isOptimistic(s.jobSet.id));
  return pending?.length ? [...pending, ...items] : items;
}

/** No page asks for audio runs yet; every run this app makes is one of the other two. */
const jobModalityOf = (modality: JobSet["modality"]): JobModality =>
  modality === "video" ? "video" : "image";

/**
 * Add or replace a run in its modality's loaded list. With nothing loaded yet it does nothing:
 * seeding the cache with one run would pass for the whole list and skip the real fetch.
 */
export function upsertJobSet(next: JobSetWithJobs) {
  queryClient.setQueryData<JobSetWithJobs[]>(
    queryKeys.jobSets(jobModalityOf(next.jobSet.modality)),
    (list) => {
      if (!list) return list;
      const at = list.findIndex((s) => s.jobSet.id === next.jobSet.id);
      if (at < 0) return [next, ...list];
      const copy = list.slice();
      copy[at] = next;
      return copy;
    },
  );
}

/**
 * A new run the server just accepted. The stream may have sent it already and moved its jobs on
 * (job_set.created, then job.started, before the 202 lands), so a copy already here wins.
 */
export function addJobSet(accepted: JobSetWithJobs) {
  queryClient.setQueryData<JobSetWithJobs[]>(
    queryKeys.jobSets(jobModalityOf(accepted.jobSet.modality)),
    (list) => {
      if (!list || list.some((s) => s.jobSet.id === accepted.jobSet.id)) return list;
      return [accepted, ...list];
    },
  );
}

/** Patches every modality's cache; the one that doesn't hold this run is a no-op. */
function patchAllJobSetLists(updater: (list: JobSetWithJobs[]) => JobSetWithJobs[]) {
  queryClient.setQueriesData<JobSetWithJobs[]>({ queryKey: queryKeys.jobSetsRoot }, (list) =>
    list ? updater(list) : list,
  );
}

export function patchJobSet(jobSetId: string, patch: Partial<JobSet>) {
  patchAllJobSetLists((list) =>
    list.map((s) => (s.jobSet.id === jobSetId ? { ...s, jobSet: { ...s.jobSet, ...patch } } : s)),
  );
}

/** A Batch run's provider batch changed state (batch.updated). */
export function patchBatch(jobSetId: string, batch: BatchSummary) {
  patchAllJobSetLists((list) => list.map((s) => (s.jobSet.id === jobSetId ? { ...s, batch } : s)));
}

export function patchJob(jobSetId: string, jobId: string, patch: Partial<Job>) {
  patchAllJobSetLists((list) =>
    list.map((s) =>
      s.jobSet.id === jobSetId
        ? { ...s, jobs: s.jobs.map((job) => (job.id === jobId ? { ...job, ...patch } : job)) }
        : s,
    ),
  );
}

function removeJobSet(jobSetId: string) {
  patchAllJobSetLists((list) => list.filter((s) => s.jobSet.id !== jobSetId));
}

function optimisticJobSet(
  body: GenerateBody,
  size: PixelSize,
  speed: SpeedId,
  modality: JobModality,
): JobSetWithJobs {
  const now = new Date().toISOString();
  const id = `${OPTIMISTIC}${body.idempotencyKey}`;
  return {
    jobSet: {
      id,
      status: "pending",
      op: body.op,
      model: body.model,
      modality,
      batchSize: body.batch,
      prompt: body.prompt,
      promptOriginal: null,
      source: body.source,
      priority: 10,
      costEstimateUsd: null,
      costActualUsd: null,
      errorCode: null,
      errorMessage: null,
      canvasId: null,
      canvasNodeId: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      speed,
    },
    jobs: Array.from({ length: body.batch }, (_, idx) => ({
      id: `${id}:${idx}`,
      jobSetId: id,
      idx,
      status: "pending" as const,
      width: size.width,
      height: size.height,
      progress: null,
      seed: null,
      attempt: 0,
      assetId: null,
      errorCode: null,
      errorMessage: null,
      errorReason: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    })),
  };
}

export interface GenerateInput {
  body: GenerateBody;
  /** Where the placeholders reserve space until the server sends the real size. */
  placeholder: PixelSize;
  /** What the company's settings resolve to, so a Batch run's tiles wait from the start. */
  speed: SpeedId;
  /** Which feed the placeholder belongs to. */
  modality: JobModality;
}

export function useGenerate() {
  return useMutation({
    mutationFn: ({ body }: GenerateInput) => call(api.api.generate.$post({ json: body })),
    onMutate: ({ body, placeholder, speed, modality }) => {
      upsertJobSet(optimisticJobSet(body, placeholder, speed, modality));
    },
    onSuccess: (accepted, { body }) => {
      removeJobSet(`${OPTIMISTIC}${body.idempotencyKey}`);
      addJobSet(accepted);
    },
    onError: (_error, { body }) => removeJobSet(`${OPTIMISTIC}${body.idempotencyKey}`),
  });
}

export function useCancelJob() {
  return useMutation({
    mutationFn: (jobId: string) => call(api.api.jobs[":id"].cancel.$post({ param: { id: jobId } })),
  });
}

/** Cancel a whole run. A Batch run's images stop together, at the company too (§0.12). */
export function useCancelJobSet() {
  return useMutation({
    mutationFn: (jobSetId: string) =>
      call(api.api["job-sets"][":id"].cancel.$post({ param: { id: jobSetId } })),
  });
}

/** Try again: re-send the frozen request of a failed run, only the images that failed. */
export function useRetryJobSet() {
  return useMutation({
    mutationFn: (jobSetId: string) =>
      call(api.api["job-sets"][":id"].retry.$post({ param: { id: jobSetId }, json: { onlyFailed: true } })),
    onSuccess: addJobSet,
  });
}

/** Recreate: replay the frozen request as a new run (§0.1). */
export function useRecreateJobSet() {
  return useMutation({
    mutationFn: (jobSetId: string) =>
      call(api.api["job-sets"][":id"].recreate.$post({ param: { id: jobSetId } })),
    onSuccess: addJobSet,
  });
}
