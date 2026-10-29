import {
  type EditBody,
  formatBytes,
  isTerminalState,
  type Job,
  type JobSetAccepted,
  type JobSetWithJobs,
  type SseEvent,
  TERMINAL_JOB_STATES,
  t,
  UPLOAD_MAX_BYTES,
  type UploadResponse,
} from "@openfield/core";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "../../lib/live";
import { api, call } from "../client";
import { subscribeEvents } from "../events";
import { ApiError } from "../raw";
import { addJobSet, useCancelJobSet } from "./job-sets";

// The detail view's Edit tab (§0.9): save the painted area once (POST /api/masks), run the edit by
// the saved mask's id (POST /api/edit), then follow that run on the event stream, as the canvas
// follows its own. The feed gets the run like any other, from the stream and the 202.

/** POST /api/masks: the area to change on `baseAssetId`, a PNG at its exact size, alpha 0 to change. */
export function saveMask(png: Blob, baseAssetId: string): Promise<UploadResponse> {
  // Checked here too: past the server's limit the request never reaches a route that could say why.
  if (png.size > UPLOAD_MAX_BYTES) {
    return Promise.reject(
      new ApiError(
        413,
        "payload_too_large",
        `The mask is ${png.size} bytes`,
        false,
        "mask",
        t("errors.maskTooLarge", { size: formatBytes(UPLOAD_MAX_BYTES) }),
      ),
    );
  }
  const mask = new File([png], "mask.png", { type: "image/png" });
  return call(api.api.masks.$post({ form: { mask, baseAssetId } }));
}

export interface EditInput {
  /** The image being edited. */
  baseAssetId: string;
  /** The area to change: a painted PNG, saved first, or the id of a mask already saved. */
  mask?: Blob | string;
  /** POST /api/edit's body, around the saved mask (editBody). */
  body: (maskAssetId: string | undefined) => EditBody;
}

export interface EditStarted {
  accepted: JobSetAccepted;
  /** The saved mask, to send again by id while it doesn't change. */
  maskAssetId?: string;
}

/** Saves the mask when it's new, then asks for the edit. Nothing is posted if the mask isn't saved. */
export async function runEdit(input: EditInput): Promise<EditStarted> {
  const maskAssetId =
    input.mask instanceof Blob ? (await saveMask(input.mask, input.baseAssetId)).asset.id : input.mask;
  const accepted = await call(api.api.edit.$post({ json: input.body(maskAssetId) }));
  return { accepted, ...(maskAssetId && { maskAssetId }) };
}

/** The server refused because the photo is stored on its side (EXIF), at either step. */
export const isTurnedPhoto = (error: unknown): boolean =>
  error instanceof ApiError && error.userMessage === t("masks.turned");

const isTerminalJob = (job: Pick<Job, "status">) =>
  (TERMINAL_JOB_STATES as readonly string[]).includes(job.status);

/**
 * A newer copy of a run (a snapshot, a poll) laid over the one held. A job or run that has already
 * ended keeps its ending: a copy that says otherwise was read before it ended.
 */
export function mergeJobSet(held: JobSetWithJobs, fresh: JobSetWithJobs): JobSetWithJobs {
  if (fresh.jobSet.id !== held.jobSet.id) return held;
  const jobs = fresh.jobs.map((job) => {
    const before = held.jobs.find((j) => j.id === job.id);
    return before && isTerminalJob(before) && !isTerminalJob(job) ? before : job;
  });
  const ended = isTerminalState(held.jobSet.status) && !isTerminalState(fresh.jobSet.status);
  return { ...fresh, jobSet: ended ? held.jobSet : fresh.jobSet, jobs };
}

/**
 * One frame applied to a run, the way the feed's cache takes it (../events.ts). Frames for other
 * runs leave it as it is, and a job that has ended stays ended.
 */
export function followJobSet(set: JobSetWithJobs, event: SseEvent): JobSetWithJobs {
  const id = set.jobSet.id;
  const patch = (jobId: string, next: Partial<Job>, ending = false): JobSetWithJobs => ({
    ...set,
    jobs: set.jobs.map((job) =>
      job.id === jobId && (ending || !isTerminalJob(job)) ? { ...job, ...next } : job,
    ),
  });
  switch (event.event) {
    case "snapshot": {
      const fresh = event.data.activeJobSets.find((s) => s.jobSet.id === id);
      return fresh ? mergeJobSet(set, fresh) : set;
    }
    case "job_set.created":
      return event.data.jobSet.id === id ? mergeJobSet(set, event.data) : set;
    case "job.queued":
      if (event.data.jobSetId !== id) return set;
      return patch(event.data.jobId, { status: "queued", nextAttemptAt: event.data.retryAt ?? null });
    case "job.started":
      if (event.data.jobSetId !== id) return set;
      return patch(event.data.jobId, {
        status: "running",
        startedAt: event.data.startedAt,
        nextAttemptAt: null,
      });
    case "job.progress":
      if (event.data.jobSetId !== id) return set;
      return patch(event.data.jobId, { progress: event.data.progress });
    case "job.output":
      if (event.data.jobSetId !== id) return set;
      return patch(event.data.jobId, { status: "succeeded", assetId: event.data.asset.id }, true);
    case "job.failed": {
      if (event.data.jobSetId !== id) return set;
      const { error } = event.data;
      return patch(
        event.data.jobId,
        {
          status: "failed",
          errorCode: error.code,
          errorMessage: error.message,
          errorReason: error.reason ?? null,
          errorAction: error.action ?? null,
          finishedAt: new Date().toISOString(),
        },
        true,
      );
    }
    case "job.canceled":
      if (event.data.jobSetId !== id) return set;
      return patch(event.data.jobId, { status: "canceled", errorCode: "canceled" }, true);
    case "job_set.completed":
      if (event.data.jobSetId !== id) return set;
      return {
        ...set,
        jobSet: { ...set.jobSet, status: event.data.status, costActualUsd: event.data.costActualUsd },
      };
    default:
      return set;
  }
}

/** The run's frames, as job_set.* and job.* frames name it. */
const jobSetIdOf = (event: SseEvent): string | undefined => {
  switch (event.event) {
    case "job_set.created":
      return event.data.jobSet.id;
    case "job.queued":
    case "job.started":
    case "job.progress":
    case "job.output":
    case "job.failed":
    case "job.canceled":
    case "job_set.completed":
      return event.data.jobSetId;
    default:
      return undefined;
  }
};

/** Frames kept while the run's id isn't known yet: a few per image is plenty. */
const BUFFER_MAX = 256;

export interface RunFollower {
  /** The 202 named the run: frames that came before it are applied, and later ones as they come. */
  accept(set: JobSetWithJobs): void;
  /** Asks the server for the run again, for when the stream was down. */
  refresh(): Promise<void>;
  stop(): void;
}

export interface FollowDeps {
  onChange: (set: JobSetWithJobs) => void;
  // Seams for tests.
  subscribe?: (listener: (event: SseEvent) => void) => () => void;
  fetchJobSet?: (jobSetId: string) => Promise<JobSetWithJobs | undefined>;
}

/**
 * Follows one run from before it exists. Started before the edit is posted, it keeps the frames
 * that land ahead of the 202 (job_set.created, even job.output on a quick run) and applies them
 * once accept() names the run. A snapshot after a reconnect that no longer lists the run means it
 * ended while the stream was down, so the run is asked for again.
 */
export function followRun({
  onChange,
  subscribe = subscribeEvents,
  fetchJobSet = fetchRecentJobSet,
}: FollowDeps): RunFollower {
  let set: JobSetWithJobs | undefined;
  let stopped = false;
  const early: SseEvent[] = [];

  const update = (next: JobSetWithJobs) => {
    if (stopped || next === set) return;
    set = next;
    onChange(next);
  };
  const refresh = async () => {
    const id = set?.jobSet.id;
    if (!id || stopped) return;
    const fresh = await fetchJobSet(id).catch(() => undefined);
    if (fresh && set) update(mergeJobSet(set, fresh));
  };
  const unsubscribe = subscribe((event) => {
    if (stopped) return;
    if (!set) {
      if (jobSetIdOf(event) && early.push(event) > BUFFER_MAX) early.shift();
      return;
    }
    update(followJobSet(set, event));
    const missing =
      event.event === "snapshot" &&
      !isTerminalState(set.jobSet.status) &&
      !event.data.activeJobSets.some((s) => s.jobSet.id === set?.jobSet.id);
    if (missing) void refresh();
  });

  return {
    accept(accepted) {
      if (stopped) return;
      let next = accepted;
      for (const event of early.splice(0)) next = followJobSet(next, event);
      update(next);
    },
    refresh,
    stop() {
      stopped = true;
      early.length = 0;
      unsubscribe();
    },
  };
}

/** A recent run by id, from the list the feed reads. An edit is always among the latest. */
async function fetchRecentJobSet(jobSetId: string): Promise<JobSetWithJobs | undefined> {
  const res = await call(
    api.api["job-sets"].$get({ query: { status: "all", limit: "50", modality: "image" } }),
  );
  return res.items.find((s) => s.jobSet.id === jobSetId);
}

export interface PendingStop {
  /** A new run is being asked for: a Stop pressed for the last one doesn't carry over. */
  begin(): void;
  /** The 202 named the run. */
  accept(jobSetId: string): void;
  stop(): void;
}

/**
 * Stop for a run that may not have its id yet. Pressed while the mask is saving or the edit is
 * being asked for, it's kept, and the run stops as soon as the 202 names it rather than going on.
 */
export function pendingStop(cancel: (jobSetId: string) => void): PendingStop {
  let named: string | null = null;
  let asked = false;
  return {
    begin() {
      named = null;
      asked = false;
    },
    accept(jobSetId) {
      named = jobSetId;
      if (asked) {
        asked = false;
        cancel(jobSetId);
      }
    },
    stop() {
      if (named) cancel(named);
      else asked = true;
    },
  };
}

/** While the stream is down, the run is asked for this often, as the feed polls. */
const POLL_MS = 2000;

/**
 * The Edit tab's runs, one at a time: `start` saves the mask and asks for the edit, and `run` is
 * that run as it goes, from the stream (or polled while the stream is down). A new start follows
 * the new run instead.
 */
export function useEditRun({ onStopFailed }: { onStopFailed?: (error: unknown) => void } = {}) {
  const [run, setRun] = useState<JobSetWithJobs>();
  const follower = useRef<RunFollower | undefined>(undefined);
  const connected = useLive((s) => s.connected);
  const { mutate: cancel } = useCancelJobSet();
  const stopFailed = useRef(onStopFailed);
  stopFailed.current = onStopFailed;
  const [stops] = useState(() =>
    pendingStop((jobSetId) => cancel(jobSetId, { onError: (error) => stopFailed.current?.(error) })),
  );

  const mutation = useMutation({
    mutationFn: async (input: EditInput) => {
      follower.current?.stop();
      stops.begin();
      setRun(undefined);
      const following = followRun({ onChange: setRun });
      follower.current = following;
      try {
        const started = await runEdit(input);
        following.accept(started.accepted);
        addJobSet(started.accepted);
        if (follower.current === following) stops.accept(started.accepted.jobSet.id);
        return started;
      } catch (error) {
        following.stop();
        throw error;
      }
    },
  });

  useEffect(() => () => follower.current?.stop(), []);

  const active = run !== undefined && !isTerminalState(run.jobSet.status);
  useEffect(() => {
    if (connected || !active) return;
    const timer = setInterval(() => void follower.current?.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [connected, active]);

  const { reset: resetMutation } = mutation;
  /** Forget the run, as when the person goes back to painting. */
  const reset = useCallback(() => {
    follower.current?.stop();
    follower.current = undefined;
    stops.begin();
    setRun(undefined);
    resetMutation();
  }, [resetMutation, stops]);

  return {
    run,
    /** Saving the mask or asking for the edit: nothing to follow yet. */
    starting: mutation.isPending,
    error: mutation.error,
    /** Takes onSuccess and onError like any mutation; onSuccess gets the saved mask's id. */
    start: mutation.mutate,
    /** Stops the run, or, while it's still being asked for, as soon as it has an id. */
    stop: stops.stop,
    reset,
  };
}
