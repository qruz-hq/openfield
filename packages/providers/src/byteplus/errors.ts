import { type ErrorCode, t } from "@openfield/core";
import { errorCodeForStatus, ProviderError, readBody, retryAfterFromHeaders } from "../types";
import { COMPANY } from "./capabilities";

// BytePlus errors to §0.5 codes (docs.byteplus.com/en/docs/ModelArk/1299023). Every answer that
// isn't a success carries {"error": {"code", "message"}}; a task that failed later carries the same
// pair on its status read. The code is what decides, since one status covers many causes.

export interface ByteplusErrorBody {
  code?: string;
  message?: string;
  param?: string;
  type?: string;
}

/** No Retry-After on most 429s; RPM limits clear within the minute. */
export const RATE_LIMIT_WAIT_MS = 12_000;

/** The wire field a 400 names, as the control it came from, so the tile can point at it. */
const FIELDS: Record<string, string> = {
  content: "prompt",
  text: "prompt",
  ratio: "aspect",
  resolution: "video.resolution",
  duration: "video.seconds",
  generate_audio: "video.audio",
  camera_fixed: "video.cameraFixed",
  seed: "seed",
  image_url: "video.startFrame",
};

interface Context {
  /** The model's display name, for copy that names it. */
  model?: string;
  status?: number;
  retryAfterMs?: number;
}

/** The part of a mapping that doesn't depend on HTTP: shared by errors and failed tasks. */
export function errorFor(error: ByteplusErrorBody | undefined, ctx: Context = {}): ProviderError {
  const code = error?.code ?? "";
  const message = error?.message || (ctx.status ? `HTTP ${ctx.status}` : "The task failed");
  const model = ctx.model ?? "this model";
  const base = {
    message: code ? `${code}: ${message}` : message,
    ...(ctx.status !== undefined && { httpStatus: ctx.status }),
    ...(code && { providerCode: code }),
  };
  const fail = (
    errorCode: ErrorCode,
    extra: { userMessage?: string; field?: string; retryAfterMs?: number } = {},
  ) => new ProviderError(errorCode, { ...base, ...extra });

  // Safety first: the same codes arrive as a 400 on create and on a failed task.
  if (/^Input(Image|Video|Audio)SensitiveContentDetected/.test(code)) return fail("content_flagged_input");
  if (/SensitiveContentDetected/.test(code)) return fail("content_refused");

  if (code === "AuthenticationError" || ctx.status === 401) return fail("auth_invalid");
  if (code === "AccountOverdueError") {
    return fail("billing_required", { userMessage: t("errors.accountOverdue", { company: COMPANY }) });
  }
  // A model that isn't turned on for the account: 2.x needs activation in the console first.
  if (code === "ModelNotOpen" || code.startsWith("OperationDenied.ServiceNotOpen")) {
    return fail("auth_forbidden", {
      userMessage: t("errors.modelNotActivated", { model, company: COMPANY }),
    });
  }
  if (code.startsWith("InvalidEndpointOrModel")) {
    return fail("auth_forbidden", { userMessage: t("errors.forbiddenModel", { model }) });
  }
  if (code === "SetLimitExceeded") {
    // Safe Experience Mode paused the model: waiting won't lift it, the person has to.
    return fail("quota_exceeded", { userMessage: t("errors.spendLimit", { model, company: COMPANY }) });
  }
  if (code === "QuotaExceeded") {
    return fail("quota_exceeded", { userMessage: t("errors.usageQuota", { company: COMPANY }) });
  }
  if (code === "ServerOverloaded") {
    return fail("provider_unavailable", { retryAfterMs: ctx.retryAfterMs ?? RATE_LIMIT_WAIT_MS });
  }
  if (/RateLimitExceeded/.test(code) || ctx.status === 429) {
    const wait = ctx.retryAfterMs ?? RATE_LIMIT_WAIT_MS;
    return fail("rate_limited", {
      retryAfterMs: wait,
      userMessage: t("errors.rateLimitedIn", { seconds: Math.round(wait / 1000) }),
    });
  }
  if (ctx.status === 403 || code === "AccessDenied" || code.startsWith("OperationDenied")) {
    return fail("auth_forbidden", {
      userMessage: t("errors.modelNotActivated", { model, company: COMPANY }),
    });
  }
  if (code.startsWith("InvalidParameter") || ctx.status === 400) {
    const wire =
      error?.param ??
      /\b(content|ratio|resolution|duration|generate_audio|camera_fixed|seed|image_url)\b/.exec(message)?.[1];
    const field = wire ? (FIELDS[wire] ?? wire) : undefined;
    return fail("invalid_request", field ? { field } : {});
  }
  if (code === "InternalServiceError") return fail("provider_unavailable");
  if (ctx.status !== undefined) {
    const mapped = errorCodeForStatus(ctx.status);
    return fail(mapped, ctx.retryAfterMs === undefined ? {} : { retryAfterMs: ctx.retryAfterMs });
  }
  return fail("provider_error");
}

/** An answer that wasn't a success. Every call site: throw await mapError(res, body, model). */
export async function mapError(res: Response, body?: unknown, model?: string): Promise<ProviderError> {
  const data = body === undefined ? await readBody(res) : body;
  const error =
    typeof data === "object" && data !== null
      ? ((data as { error?: ByteplusErrorBody }).error ?? undefined)
      : typeof data === "string" && data
        ? { message: data.slice(0, 500) }
        : undefined;
  const retryAfterMs = retryAfterFromHeaders(res.headers);
  return errorFor(error, {
    status: res.status,
    ...(model && { model }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });
}
