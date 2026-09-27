import { type ErrorCode, t } from "@openfield/core";
import { errorCodeForStatus, ProviderError, readBody, retryAfterFromHeaders } from "../types";
import { COMPANY } from "./capabilities";

// OpenAI errors to §0.5 codes, from the error codes guide, the rate limits guide and the image
// generation guide's "Handling blocked requests" (2026-09-27). Every error has one envelope:
//   { "error": { "message": "...", "type": "...", "param": "size", "code": "..." } }

interface OpenAiError {
  message?: string;
  type?: string;
  param?: string | null;
  code?: string | null;
  moderation_details?: { moderation_stage?: string; categories?: string[] };
}

/** 429s that are about money, not speed. The first two mean no credit; the rest a spend limit. */
const NO_CREDIT = new Set(["insufficient_quota", "credit_balance_exhausted"]);
const SPEND_LIMIT = new Set([
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

/** The request field a 400 names, as the canonical field it came from. */
const FIELDS: Record<string, string> = {
  size: "size",
  quality: "quality",
  n: "batch",
  background: "background",
  output_format: "outputFormat",
  output_compression: "outputFormat",
  moderation: "moderation",
  image: "references",
  "image[]": "references",
  mask: "mask",
  model: "model",
  prompt: "prompt",
};

export async function mapError(res: Response, body?: unknown): Promise<ProviderError> {
  const data = body === undefined ? await readBody(res) : body;
  const err = asOpenAiError(data);
  const code = err?.code ?? undefined;
  const type = err?.type ?? undefined;
  const message = scrubKeys(err?.message ?? (typeof data === "string" ? data : res.statusText));
  const base = {
    httpStatus: res.status,
    providerCode: [type, code].filter(Boolean).join(":") || String(res.status),
    message: message || `HTTP ${res.status}`,
  };
  const fail = (
    errorCode: ErrorCode,
    extra: { field?: string; retryAfterMs?: number; userMessage?: string } = {},
  ) => new ProviderError(errorCode, { ...base, ...extra });

  if (res.status === 401 || code === "invalid_api_key") return fail("auth_invalid");
  if (code === "moderation_blocked" || err?.moderation_details) return fail("content_refused");
  if (res.status === 403) {
    // GPT Image models may need API Organization Verification first.
    return /verif/i.test(message)
      ? fail("auth_forbidden", { userMessage: t("errors.verifyOrg", { company: COMPANY }) })
      : fail("auth_forbidden");
  }
  if (res.status === 429) {
    if (NO_CREDIT.has(code ?? "") || type === "insufficient_quota") return fail("billing_required");
    if (SPEND_LIMIT.has(code ?? "")) return fail("quota_exceeded");
    const retryAfterMs = retryAfterFromHeaders(res.headers);
    const seconds = retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000);
    return fail("rate_limited", {
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      ...(seconds !== undefined && { userMessage: t("errors.rateLimitedIn", { seconds }) }),
    });
  }
  if (res.status === 413 || /too large|exceeds the maximum/i.test(message)) return fail("payload_too_large");
  if (res.status === 404) return fail("invalid_request", { field: "model" });
  if (res.status === 400) {
    const field = err?.param ? FIELDS[err.param] : undefined;
    return field ? fail("unsupported_param", { field }) : fail("invalid_request");
  }
  if (res.status >= 500) {
    const retryAfterMs = retryAfterFromHeaders(res.headers);
    return fail("provider_unavailable", { ...(retryAfterMs !== undefined && { retryAfterMs }) });
  }
  return fail(errorCodeForStatus(res.status));
}

function asOpenAiError(data: unknown): OpenAiError | undefined {
  const error = (data as { error?: unknown } | undefined)?.error;
  return error && typeof error === "object" ? (error as OpenAiError) : undefined;
}

/** OpenAI echoes the start of a rejected key in some messages. A second net costs nothing. */
function scrubKeys(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_*-]{8,}/g, "[hidden]");
}
