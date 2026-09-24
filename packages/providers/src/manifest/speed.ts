import {
  type AdapterOp,
  adapterOpFor,
  BATCH_DEADLINE_GRACE_MS,
  FLEX_JOB_DEADLINE_MS,
  type ModelManifest,
  type Op,
  type PriceModel,
  SPEED_IDS,
  type SpeedId,
  type SpeedOffer,
} from "@openfield/core";

// Speeds (§0.3). Pure and browser-safe: the composer, the canvas pills, the server and the usage log
// all read offers through these, so a model that lacks the chosen speed runs at Standard everywhere.

type Speeds = Pick<ModelManifest, "speeds">;

/** The offer for a speed, or undefined for Standard and for speeds the model doesn't offer. */
export function speedOffer(manifest: Speeds, speed: SpeedId): SpeedOffer | undefined {
  return speed === "standard" ? undefined : manifest.speeds?.find((o) => o.id === speed);
}

/** What a model runs at when its company's settings ask for `requested`. */
export function resolveSpeed(
  manifest: Speeds,
  requested: SpeedId,
  op: AdapterOp = "generate",
): { speed: SpeedId; fellBack: boolean } {
  if (requested === "standard") return { speed: "standard", fellBack: false };
  const offer = speedOffer(manifest, requested);
  if (offer && (!offer.ops || offer.ops.includes(op))) return { speed: requested, fellBack: false };
  return { speed: "standard", fellBack: true };
}

/** The price at a speed: the offer's, or the manifest's own Standard price. */
export function priceFor(manifest: Pick<ModelManifest, "price" | "speeds">, speed: SpeedId): PriceModel {
  return speedOffer(manifest, speed)?.price ?? manifest.price;
}

/** Every speed a model offers for an op, Standard first, in SPEED_IDS order. */
export function offeredSpeeds(manifest: Speeds, op: AdapterOp = "generate"): SpeedId[] {
  return SPEED_IDS.filter((id) => !resolveSpeed(manifest, id, op).fellBack);
}

/**
 * Whether a call sent at `speed` survives a restart (§0.4, §6.3): a Batch run always does, from its
 * provider batch row, and a sync speed only when the manifest lists it in `resumableSpeeds`. The
 * runner writes this to jobs.resumable when it sends a call and stores the handle only when it's
 * true, so a call that can't resume is never polled by an id it doesn't have after a restart.
 */
export function resumesAfterRestart(
  manifest: Pick<ModelManifest, "resumableSpeeds">,
  speed: SpeedId,
): boolean {
  if (speed === "batch") return true;
  return (manifest.resumableSpeeds as readonly SpeedId[] | undefined)?.includes(speed) ?? false;
}

/** The adapter op a recorded op prices as. Local and plugin ops fall back to generate. */
export function pricedOp(op: Op | undefined): AdapterOp {
  return (op && adapterOpFor(op, { hasMask: false, canInpaint: false })) ?? "generate";
}

export interface SpeedTimeouts {
  /** One call's timeout. For Batch, the create, poll and cancel calls. */
  attemptTimeoutMs: number;
  /** Whole-job wall clock, busy waits included. For Batch, the company's expiry plus a grace. */
  jobDeadlineMs: number;
}

/**
 * Timeouts for a run at `speed` (§0.12). `base` is the runner's own Standard deadline. Flex takes
 * its offer's attempt timeout (Google asks for 10 minutes or more) and an hour overall.
 */
export function speedTimeouts(
  manifest: Pick<ModelManifest, "capabilities" | "speeds">,
  speed: SpeedId,
  base: { jobDeadlineMs: number },
): SpeedTimeouts {
  const attempt = manifest.capabilities.limits.requestTimeoutMs;
  const offer = speedOffer(manifest, speed);
  switch (speed) {
    case "flex":
      return { attemptTimeoutMs: offer?.requestTimeoutMs ?? attempt, jobDeadlineMs: FLEX_JOB_DEADLINE_MS };
    case "batch":
      return {
        attemptTimeoutMs: attempt,
        jobDeadlineMs: (offer?.waitMs.max ?? 0) + BATCH_DEADLINE_GRACE_MS,
      };
    default:
      return { attemptTimeoutMs: offer?.requestTimeoutMs ?? attempt, jobDeadlineMs: base.jobDeadlineMs };
  }
}
