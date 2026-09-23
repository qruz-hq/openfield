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

// Runs on the feed: placeholders while they work, failed tiles when they don't (§2.4).

export const isActiveJob = (job: Pick<Job, "status">) =>
  (ACTIVE_JOB_STATES as readonly string[]).includes(job.status);

const JOB_SET_LIMIT = 50;

export function useJobSets({ poll }: { poll: boolean }) {
  return useQuery({
    queryKey: queryKeys.jobSets,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets);
      const res = await call(
        api.api["job-sets"].$get(
          { query: { status: "all", limit: String(JOB_SET_LIMIT) } },
          { init: { signal } },
        ),
      );
      // While polling, a run that finished since last time means new images to fetch.
      if (previous && finishedSince(previous, res.items)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.allAssets });
      }
      return mergeOptimistic(res.items);
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

function mergeOptimistic(items: JobSetWithJobs[]): JobSetWithJobs[] {
  const pending = queryClient
    .getQueryData<JobSetWithJobs[]>(queryKeys.jobSets)
    ?.filter((s) => isOptimistic(s.jobSet.id));
  return pending?.length ? [...pending, ...items] : items;
}

/**
 * Add or replace a run in the loaded list. With nothing loaded yet it does nothing: seeding the
 * cache with one run would pass for the whole list and skip the real fetch.
 */
export function upsertJobSet(next: JobSetWithJobs) {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, (list) => {
    if (!list) return list;
    const at = list.findIndex((s) => s.jobSet.id === next.jobSet.id);
    if (at < 0) return [next, ...list];
    const copy = list.slice();
    copy[at] = next;
    return copy;
  });
}

/**
 * A new run the server just accepted. The stream may have sent it already and moved its jobs on
 * (job_set.created, then job.started, before the 202 lands), so a copy already here wins.
 */
export function addJobSet(accepted: JobSetWithJobs) {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, (list) => {
    if (!list || list.some((s) => s.jobSet.id === accepted.jobSet.id)) return list;
    return [accepted, ...list];
  });
}

export function patchJobSet(jobSetId: string, patch: Partial<JobSet>) {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, (list) =>
    list?.map((s) => (s.jobSet.id === jobSetId ? { ...s, jobSet: { ...s.jobSet, ...patch } } : s)),
  );
}

/** A Batch run's provider batch changed state (batch.updated). */
export function patchBatch(jobSetId: string, batch: BatchSummary) {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, (list) =>
    list?.map((s) => (s.jobSet.id === jobSetId ? { ...s, batch } : s)),
  );
}

export function patchJob(jobSetId: string, jobId: string, patch: Partial<Job>) {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, (list) =>
    list?.map((s) =>
      s.jobSet.id === jobSetId
        ? { ...s, jobs: s.jobs.map((job) => (job.id === jobId ? { ...job, ...patch } : job)) }
        : s,
    ),
  );
}

function removeJobSet(jobSetId: string) {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, (list) =>
    list?.filter((s) => s.jobSet.id !== jobSetId),
  );
}

function optimisticJobSet(body: GenerateBody, size: PixelSize, speed: SpeedId): JobSetWithJobs {
  const now = new Date().toISOString();
  const id = `${OPTIMISTIC}${body.idempotencyKey}`;
  return {
    jobSet: {
      id,
      status: "pending",
      op: body.op,
      model: body.model,
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
}

export function useGenerate() {
  return useMutation({
    mutationFn: ({ body }: GenerateInput) => call(api.api.generate.$post({ json: body })),
    onMutate: ({ body, placeholder, speed }) => {
      upsertJobSet(optimisticJobSet(body, placeholder, speed));
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
