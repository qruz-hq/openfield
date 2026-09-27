import {
  type ErrorCode,
  type ErrorHintAction,
  isRetryable,
  type ProviderErrorData,
  t,
} from "@openfield/core";
import type { RedactingLogger } from "./provider";

// §0.5, §6.8. The data shape lives in core; this class carries it through throw/catch.

export interface ProviderErrorOptions {
  /** Detail for the error log. Never shown on a tile, never holds a key. */
  message?: string;
  /** Overrides the shared copy, e.g. with a diagnostic that names the setting. */
  userMessage?: string;
  retryAfterMs?: number;
  httpStatus?: number;
  providerCode?: string;
  field?: string;
  hint?: { action: ErrorHintAction; label: string };
  /** The company refused for capacity at this speed (Flex). The runner waits instead of retrying. */
  busy?: boolean;
  /**
   * A status read of a resumable call's id the company no longer has (§6.8). Use with
   * provider_error: the runner fails the job and never sends the call again. See notFoundError().
   */
  notFound?: boolean;
  /**
   * The company's answer can't be used, and reading the same id again won't change it: a finished
   * image from a host the adapter doesn't declare, say. The runner ends the run at once instead of
   * reading again until the deadline.
   */
  final?: boolean;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly field?: string;
  readonly hint?: { action: ErrorHintAction; label: string };
  readonly busy?: boolean;
  readonly notFound?: boolean;
  readonly final?: boolean;

  constructor(code: ErrorCode, opts: ProviderErrorOptions = {}) {
    super(opts.message ?? code, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    this.code = code;
    this.retryable = isRetryable(code);
    this.userMessage = opts.userMessage ?? t(`errors.${code}.reason`);
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts.providerCode !== undefined) this.providerCode = opts.providerCode;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.busy) this.busy = true;
    if (opts.notFound) this.notFound = true;
    if (opts.final) this.final = true;
  }

  toJSON(): ProviderErrorData {
    return {
      code: this.code,
      retryable: this.retryable,
      userMessage: this.userMessage,
      ...(this.retryAfterMs !== undefined && { retryAfterMs: this.retryAfterMs }),
      ...(this.httpStatus !== undefined && { httpStatus: this.httpStatus }),
      ...(this.providerCode !== undefined && { providerCode: this.providerCode }),
      ...(this.field !== undefined && { field: this.field }),
      ...(this.hint !== undefined && { hint: this.hint }),
      ...(this.busy && { busy: true }),
      ...(this.notFound && { notFound: true }),
    };
  }
}

/**
 * The company answered a status read by id with "not found": the call a restart left behind is gone
 * (§0.5, §8.4.5). Never retried. `company` is the adapter's meta.displayName.
 */
export function notFoundError(company: string, opts: Omit<ProviderErrorOptions, "notFound"> = {}) {
  return new ProviderError("provider_error", {
    message: `${company} has no call with this id`,
    userMessage: t("errors.resumeGone", { company }),
    ...opts,
    notFound: true,
  });
}

export const isProviderError = (value: unknown): value is ProviderError => value instanceof ProviderError;

/**
 * A fetch that threw instead of answering. A timeout abort (AbortSignal.timeout, or the server's
 * attempt timer) is `timeout`; any other abort is the person canceling; everything else is `network`.
 */
export function errorFromFetchFailure(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  const reasonName = (signal?.reason as { name?: unknown } | undefined)?.name;
  if (name === "TimeoutError" || reasonName === "TimeoutError") {
    return new ProviderError("timeout", { message: "The request timed out", cause: err });
  }
  if (name === "AbortError" || signal?.aborted) {
    return new ProviderError("canceled", { message: "The request was aborted", cause: err });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ProviderError("network", { message: `Couldn't reach the server: ${detail}`, cause: err });
}

/** Fallback when a provider body says nothing more specific. */
export function errorCodeForStatus(status: number): ErrorCode {
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status === 401) return "auth_invalid";
  if (status === 402) return "billing_required";
  if (status === 403) return "auth_forbidden";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 499) return "canceled";
  if (status >= 500) return "provider_unavailable";
  return "unknown";
}

/** Retry-After as seconds or an HTTP date. Undefined when absent or unreadable. */
export function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Reads a JSON body without throwing. Non-JSON bodies come back as a short string for the error log. */
export async function readBody(res: Response): Promise<unknown> {
  if (res.bodyUsed) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

/** Runs the error's detail through the logger's redaction before it leaves the adapter. */
export function redactError(err: ProviderError, log: Pick<RedactingLogger, "scrub">): ProviderError {
  err.message = log.scrub(err.message);
  return err;
}
