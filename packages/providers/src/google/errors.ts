import { type ErrorCode, t } from "@openfield/core";
import { errorCodeForStatus, ProviderError, readBody, retryAfterFromHeaders } from "../types";

// Gemini errors to §0.5 codes. generateContent answers with a google.rpc.Status body:
//   { "error": { "code": 429, "message": "...", "status": "RESOURCE_EXHAUSTED", "details": [...] } }
// Google's current error page documents the Interactions API's snake_case codes instead
// ("rate_limit_exceeded", "payment_required"), so both spellings are read.

interface GoogleErrorDetail {
  "@type"?: string;
  reason?: string;
  retryDelay?: string;
  violations?: { quotaId?: string; quotaMetric?: string; quotaValue?: string }[];
  fieldViolations?: { field?: string; description?: string }[];
}

interface GoogleError {
  code?: number | string;
  message?: string;
  status?: string;
  details?: GoogleErrorDetail[];
}

interface GeminiBody {
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  candidates?: {
    finishReason?: string;
    finishMessage?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
}

/** Output stopped by a content rule. Never retried; the person can change the prompt. */
const REFUSALS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_RECITATION",
  "LANGUAGE",
  "ESCALATION",
]);

export async function mapError(res: Response, body?: unknown): Promise<ProviderError> {
  const data = body === undefined ? await readBody(res) : body;
  if (res.ok) {
    return (
      refusal(data) ??
      new ProviderError("provider_error", { httpStatus: res.status, message: "The response held no image" })
    );
  }

  const err = asGoogleError(data);
  const status = normaliseStatus(err);
  const reason = err?.details?.find((d) => d.reason)?.reason;
  const message = scrubKeys(err?.message ?? (typeof data === "string" ? data : res.statusText));
  const base = {
    httpStatus: res.status,
    providerCode: [status, reason].filter(Boolean).join(":") || String(res.status),
    message: message || `HTTP ${res.status}`,
  };
  const fail = (
    code: ErrorCode,
    extra: { field?: string; retryAfterMs?: number; userMessage?: string } = {},
  ) => new ProviderError(code, { ...base, ...extra });

  // A bad key on generateContent is a 400 INVALID_ARGUMENT with reason API_KEY_INVALID, not a 401.
  if (
    reason === "API_KEY_INVALID" ||
    /api key (not valid|expired)/i.test(message) ||
    res.status === 401 ||
    status === "UNAUTHENTICATED" ||
    status === "AUTHENTICATION"
  ) {
    return fail("auth_invalid");
  }
  if (res.status === 402 || status === "PAYMENT_REQUIRED") return fail("billing_required");
  if (res.status === 403 || status === "PERMISSION_DENIED") return fail("auth_forbidden");
  if (res.status === 429 || isQuotaStatus(status)) return rateLimit(res, err, status, fail);
  if (status === "FAILED_PRECONDITION") {
    // Documented as "a prerequisite is not met (for example, disabled billing)". The other common
    // one is an unsupported country, which is about access, not credit.
    return /location|region|country/i.test(message) && !/billing/i.test(message)
      ? fail("auth_forbidden")
      : fail("billing_required");
  }
  if (
    res.status === 413 ||
    /payload size|request (is )?too large|exceeds the (maximum|limit)/i.test(message)
  ) {
    return fail("payload_too_large");
  }
  if (res.status === 404 || status === "NOT_FOUND" || status === "MODEL_NOT_FOUND") {
    return fail("invalid_request", { field: "model" });
  }
  if (res.status === 400 || status === "INVALID_ARGUMENT" || status === "INVALID_REQUEST") {
    const field = fieldOf(err, message);
    return field ? fail("unsupported_param", { field }) : fail("invalid_request");
  }
  if (status === "DEADLINE_EXCEEDED") return fail("timeout");
  if (status === "CANCELLED") return fail("canceled");
  return fail(errorCodeForStatus(res.status));
}

/** A 200 whose content was blocked or held no image. Undefined when the body looks fine. */
export function refusal(body: unknown): ProviderError | undefined {
  const data = body as GeminiBody | undefined;
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    return new ProviderError("content_refused", {
      httpStatus: 200,
      providerCode: `blockReason:${blockReason}`,
      message: data.promptFeedback?.blockReasonMessage ?? `The prompt was blocked (${blockReason})`,
    });
  }
  const candidate = data?.candidates?.[0];
  if (!candidate) return undefined;
  const finish = candidate.finishReason ?? "";
  const detail =
    candidate.finishMessage ??
    candidate.content?.parts
      ?.filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join(" ")
      .slice(0, 500);
  const providerCode = `finishReason:${finish || "NONE"}`;
  if (REFUSALS.has(finish)) {
    return new ProviderError("content_refused", { httpStatus: 200, providerCode, message: detail || finish });
  }
  // NO_IMAGE, or a clean stop with words and no picture: the model declined in its own way.
  if (finish === "NO_IMAGE" || finish === "STOP" || finish === "") {
    return new ProviderError("content_refused", {
      httpStatus: 200,
      providerCode,
      message: detail || "The model answered without an image",
    });
  }
  return new ProviderError("provider_error", { httpStatus: 200, providerCode, message: detail || finish });
}

function rateLimit(
  res: Response,
  err: GoogleError | undefined,
  status: string | undefined,
  fail: (code: ErrorCode, extra?: { retryAfterMs?: number; userMessage?: string }) => ProviderError,
): ProviderError {
  const violations = err?.details?.flatMap((d) => d.violations ?? []) ?? [];
  // These models have no free tier, so a quota of zero means the project has no billing.
  if (violations.some((v) => v.quotaValue === "0") || /\blimit: 0\b/.test(err?.message ?? "")) {
    return fail("billing_required");
  }
  if (status === "QUOTA_EXCEEDED" || violations.some((v) => /per_?day/i.test(v.quotaId ?? ""))) {
    return fail("quota_exceeded");
  }
  // Retry-After isn't documented for Gemini; RetryInfo.retryDelay ("12s") is. Read both.
  const retryAfterMs = retryAfterFromHeaders(res.headers) ?? retryDelayMs(err);
  const seconds = retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000);
  return fail("rate_limited", {
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    ...(seconds !== undefined && { userMessage: t("errors.rateLimitedIn", { seconds }) }),
  });
}

function retryDelayMs(err: GoogleError | undefined): number | undefined {
  const delay = err?.details?.find((d) => d["@type"]?.endsWith("google.rpc.RetryInfo"))?.retryDelay;
  const match = delay && /^(\d+(?:\.\d+)?)s$/.exec(delay);
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function asGoogleError(data: unknown): GoogleError | undefined {
  const error = (data as { error?: unknown } | undefined)?.error;
  return error && typeof error === "object" ? (error as GoogleError) : undefined;
}

/** "RESOURCE_EXHAUSTED" from google.rpc.Status, or the Interactions-style snake_case code, uppercased. */
function normaliseStatus(err: GoogleError | undefined): string | undefined {
  if (err?.status) return err.status.toUpperCase();
  return typeof err?.code === "string" ? err.code.toUpperCase() : undefined;
}

function isQuotaStatus(status: string | undefined): boolean {
  return (
    status === "RESOURCE_EXHAUSTED" ||
    status === "RATE_LIMIT_EXCEEDED" ||
    status === "QUOTA_EXCEEDED" ||
    status === "TOO_MANY_REQUESTS"
  );
}

/** The canonical field a 400 is about, when Google names one we map. */
function fieldOf(err: GoogleError | undefined, message: string): string | undefined {
  const named = err?.details?.flatMap((d) => d.fieldViolations ?? []).map((v) => v.field ?? "") ?? [];
  const text = [...named, message].join(" ");
  if (/aspect[_ ]?ratio/i.test(text)) return "size";
  if (/image[_ ]?size/i.test(text)) return "resolution";
  if (/thinking/i.test(text)) return "providerOptions.thinking";
  if (/inline[_ ]?data|mime[_ ]?type/i.test(text)) return "references";
  return undefined;
}

/** Google's messages don't echo keys, but a second net costs nothing. */
function scrubKeys(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[hidden]").replace(/([?&]key=)[^&\s]+/g, "$1[hidden]");
}
