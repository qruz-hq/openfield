import type { CostActual, JobState, SpeedId } from "@openfield/core";
import type { ProviderError } from "./errors";

// §6.6, §6.7. In-process result types: they never cross HTTP as-is, so they aren't core schemas.

export interface GeneratedImage {
  /** Already written through ctx.assets. */
  assetId: string;
  /** Position within the job set. */
  index: number;
  width: number;
  height: number;
  mimeType: string;
  bytes: number;
  seed?: number;
  /** A progressive preview, superseded by the final frame. */
  partial?: boolean;
}

export interface ProviderUsage {
  inputTextTokens?: number;
  inputImageTokens?: number;
  /** Billed at price.cachedInputPerMTok where reported (§6.9). */
  cachedInputTokens?: number;
  outputImageTokens?: number;
  imagesBilled?: number;
  seconds?: number;
  raw?: Record<string, number>;
}

export interface SafetyVerdict {
  scope: "input" | "output";
  action: "allowed" | "filtered" | "blocked";
  /** Provider vocabulary, passed through verbatim. */
  category?: string;
  message?: string;
}

export interface JobResult {
  images: GeneratedImage[];
  /** Shown in the Info panel as the prompt the model actually used. */
  revisedPrompt?: string;
  usage?: ProviderUsage;
  cost?: CostActual;
  safety?: SafetyVerdict[];
  /** Redacted provider payload minus image bytes, for the error log. */
  providerRaw?: unknown;
  timings: { submittedAt: number; firstOutputAt?: number; completedAt: number };
  /**
   * The speed the company says it served (Google: usageMetadata.serviceTier). Absent: the speed
   * asked for. Cost follows this, never the request (§0.13).
   */
  speedUsed?: SpeedId;
}

export interface JobUpdate {
  state: JobState;
  /** 0 to 100 when the provider reports it. */
  progress?: number;
  etaMs?: number;
  partial?: GeneratedImage;
  /** Present on "succeeded". */
  result?: JobResult;
  /** Present on "failed". */
  error?: ProviderError;
  /** Overrides the runner's poll backoff. */
  nextPollAfterMs?: number;
}
