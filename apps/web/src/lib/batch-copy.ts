import { type BatchUpdated, DEFAULT_BATCH_EXPIRY_MS, type Job, t } from "@openfield/core";

// What the finish toast and the system notification say for a Batch run (§2.4). Pure, so the
// wording for every outcome is unit tested.

export interface BatchDoneInput {
  frame: Pick<BatchUpdated, "state" | "counts" | "submittedAt" | "expiresAt">;
  /** The run's jobs as the feed last saw them, when the frame carries no counts. */
  jobs?: readonly Pick<Job, "status">[];
  /** Unknown when the models couldn't be loaded: the copy then leaves the name out. */
  model?: string | undefined;
  company?: string | undefined;
}

export interface BatchDoneCopy {
  title: string;
  detail?: string;
  /** Some images were made. */
  made: boolean;
  /** Title and detail as one line, for the notification and screen readers. */
  body: string;
}

const HOUR_MS = 3_600_000;

export function batchDoneCopy({ frame, jobs = [], model, company }: BatchDoneInput): BatchDoneCopy {
  const total = frame.counts?.total ?? jobs.length;
  const made = frame.counts?.succeeded ?? jobs.filter((job) => job.status === "succeeded").length;
  let detail: string | undefined;
  if (made > 0 && made >= total) {
    detail = model
      ? t("speed.done.images", { count: made, model })
      : t("speed.done.imagesOnly", { count: made });
  } else if (made > 0) {
    detail = model ? t("speed.done.some", { made, total, model }) : t("speed.done.someOnly", { made, total });
  }

  let title: string;
  if (frame.state === "expired") {
    const span =
      frame.submittedAt && frame.expiresAt
        ? Math.round((Date.parse(frame.expiresAt) - Date.parse(frame.submittedAt)) / HOUR_MS)
        : 0;
    const hours = span > 0 ? span : Math.round(DEFAULT_BATCH_EXPIRY_MS / HOUR_MS);
    title = company ? t("speed.done.expired", { company, hours }) : t("speed.done.expiredPlain", { hours });
  } else {
    title = made > 0 ? t("speed.done.ready") : t("speed.done.none");
  }
  return {
    title,
    detail,
    made: made > 0,
    body: detail ? t("speed.done.body", { title, detail }) : title,
  };
}

/** Where the notice finds the model's and the company's names, loading them if they aren't yet. */
export interface BatchNameLookups {
  model: (modelKey: string) => Promise<string | undefined>;
  company: (providerId: string) => Promise<string | undefined>;
}

/**
 * The notice for a finished run. A tab that opens after the run ended hears about it in the first
 * frame, before its lists have loaded, so the names are awaited rather than read from what's there.
 */
export async function batchNotice(
  frame: Pick<BatchUpdated, "state" | "counts" | "submittedAt" | "expiresAt" | "modelKey" | "providerId">,
  jobs: readonly Pick<Job, "status">[] | undefined,
  lookups: BatchNameLookups,
): Promise<BatchDoneCopy> {
  const quietly = <T>(work: Promise<T>) => work.catch(() => undefined);
  const [model, company] = await Promise.all([
    quietly(lookups.model(frame.modelKey)),
    quietly(lookups.company(frame.providerId)),
  ]);
  return batchDoneCopy({ frame, jobs, model, company });
}
