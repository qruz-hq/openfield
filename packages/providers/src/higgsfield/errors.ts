import { type ErrorCode, t } from "@openfield/core";
import { errorCodeForStatus, ProviderError, readBody, retryAfterFromHeaders } from "../types";
import { COMPANY } from "./capabilities";

// Higgsfield errors to §0.5 codes (docs.higgsfield.ai/docs/concepts/errors). Bodies are FastAPI's
// envelope: {"detail": "Invalid credentials"}, or a list of {loc, msg, type} for a 422.

interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

/**
 * Concurrency is Higgsfield's main limit, answered with a 400 and no Retry-After. A slot frees when
 * one of the account's requests ends, typically within tens of seconds.
 */
export const CONCURRENCY_WAIT_MS = 12_000;

/** The wire field a 422 names, as the control it came from, so the tile can point at it. */
const FIELDS: Record<string, string> = {
  prompt: "prompt",
  aspect_ratio: "aspect",
  resolution: "resolution",
  quality: "quality",
  rendering_speed: "quality",
  seed: "seed",
  negative_prompt: "negativePrompt",
  enhance_prompt: "promptEnhance",
  prompt_extend: "promptEnhance",
  moderation: "moderation",
  output_format: "outputFormat",
};

export async function mapError(res: Response, body?: unknown): Promise<ProviderError> {
  const data = body === undefined ? await readBody(res) : body;
  const detail = (data as { detail?: unknown } | undefined)?.detail;
  const items = Array.isArray(detail) ? (detail as ValidationItem[]) : [];
  const text =
    typeof detail === "string"
      ? detail
      : items.length
        ? items.map((i) => `${(i.loc ?? []).join(".")}: ${i.msg ?? i.type ?? "invalid"}`).join("; ")
        : typeof data === "string"
          ? data
          : res.statusText;
  // Higgsfield asks for this id with the request id when reporting a problem.
  const correlation = res.headers.get("x-correlation-id");
  const base = {
    httpStatus: res.status,
    providerCode: String(res.status),
    message: `${text || `HTTP ${res.status}`}${correlation ? ` (correlation id ${correlation})` : ""}`,
  };
  const fail = (
    code: ErrorCode,
    extra: { field?: string; retryAfterMs?: number; userMessage?: string } = {},
  ) => new ProviderError(code, { ...base, ...extra });

  const retryAfterMs = retryAfterFromHeaders(res.headers);
  switch (res.status) {
    case 400:
      if (/concurrent requests/i.test(text)) {
        return fail("rate_limited", {
          retryAfterMs: retryAfterMs ?? CONCURRENCY_WAIT_MS,
          userMessage: t("errors.rateLimitedIn", {
            seconds: Math.round((retryAfterMs ?? CONCURRENCY_WAIT_MS) / 1000),
          }),
        });
      }
      return fail("invalid_request");
    case 401:
      return fail("auth_invalid");
    case 403:
      // Higgsfield's 403 means the account is out of credits.
      return fail("billing_required");
    case 404:
      // A model this account can't reach. A status read's 404 is handled where it's read.
      return fail("auth_forbidden");
    case 422: {
      const wire = items.map((i) => i.loc?.at(-1)).find((f) => typeof f === "string");
      const field = typeof wire === "string" ? (FIELDS[wire] ?? wire) : undefined;
      return fail("invalid_request", field ? { field } : {});
    }
    case 423:
      // The model is blocked for now; it comes back on its own.
      return fail("provider_unavailable", retryAfterMs === undefined ? {} : { retryAfterMs });
    case 429:
      return fail("rate_limited", { retryAfterMs: retryAfterMs ?? CONCURRENCY_WAIT_MS });
    default:
      return fail(errorCodeForStatus(res.status), retryAfterMs === undefined ? {} : { retryAfterMs });
  }
}

/** A request Higgsfield accepted and later ended without an image. */
export function statusError(status: "failed" | "nsfw", error: unknown): ProviderError {
  const detail = typeof error === "string" && error ? error : undefined;
  if (status === "nsfw") {
    // Refunded, and never sent again: the person can change the prompt.
    return new ProviderError("content_refused", {
      providerCode: "nsfw",
      message: detail ?? `${COMPANY} flagged the result and held it back`,
    });
  }
  return new ProviderError("provider_error", {
    providerCode: "failed",
    message: detail ?? "Generation failed",
  });
}
