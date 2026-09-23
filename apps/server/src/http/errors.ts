import type { ApiErrorCode, ErrorEnvelope } from "@openfield/core";
import { InvalidCursorError } from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

// The one error shape every non-2xx JSON reply uses (§8.3). Messages are detail for the error
// log. The browser shows its own copy for the code, unless the reply carries ours as userMessage.

export interface ApiFailureOptions {
  field?: string | undefined;
  retryable?: boolean;
  /** Catalogue copy that says more than the code's usual words. Shown as is. */
  userMessage?: string | undefined;
}

export class ApiFailure extends Error {
  override readonly name = "ApiFailure";
  readonly field: string | undefined;
  readonly retryable: boolean;
  readonly userMessage: string | undefined;

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    opts: ApiFailureOptions = {},
  ) {
    super(message);
    this.field = opts.field;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage;
  }
}

export function envelope(code: ApiErrorCode, message: string, extra: ApiFailureOptions = {}): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      retryable: extra.retryable ?? false,
      ...(extra.field && { field: extra.field }),
      ...(extra.userMessage && { userMessage: extra.userMessage }),
    },
  };
}

type ValidationResult =
  | { success: true; data: unknown }
  | { success: false; error: z.core.$ZodError; data: unknown };

/** The shared @hono/zod-validator hook: 400, bad_request, and the first failing field (§8.3.3). */
export function onInvalid(result: ValidationResult, c: Context) {
  if (result.success) return;
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join(".") || undefined;
  const detail = issue?.message ?? "Invalid request";
  return c.json(envelope("bad_request", field ? `${field}: ${detail}` : detail, { field }), 400);
}

/** app.onError: known failures keep their code, anything else is logged and answered as internal. */
export function toErrorResponse(err: Error, c: Context, log: (msg: string, data: unknown) => void): Response {
  if (err instanceof ApiFailure) return c.json(envelope(err.code, err.message, err), err.status);
  if (err instanceof InvalidCursorError) {
    return c.json(envelope("bad_request", err.message, { field: "cursor" }), 400);
  }
  if (err instanceof HTTPException && err.status < 500) {
    // Hono's own body parsing, e.g. malformed JSON.
    return c.json(envelope("bad_request", err.message || "Invalid request"), 400);
  }
  if (isProviderError(err)) return c.json(envelope(err.code, err.message, err), 502);
  log("Request failed", { method: c.req.method, path: c.req.path, error: err });
  return c.json(envelope("internal", "Something went wrong on the server"), 500);
}

export const notFound = (c: Context, what = "That") =>
  c.json(envelope("not_found", `${what} doesn't exist`), 404);
