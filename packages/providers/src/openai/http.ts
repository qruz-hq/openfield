import { type CallContext, errorFromFetchFailure, readBody, redactError } from "../types";
import { authHeaders } from "./auth";

export interface OpenAiInit extends Omit<RequestInit, "headers" | "signal"> {
  headers?: Record<string, string>;
}

/**
 * Every call to OpenAI goes through here: ctx.fetch with the key header and the call's signal, the
 * body read, and a failed fetch turned into a redacted ProviderError. `text` keeps the whole body
 * (a JSONL batch file); the default parses JSON.
 */
export async function openAiFetch(
  ctx: CallContext,
  url: string | URL,
  init: OpenAiInit = {},
  opts: { as?: "json" | "text" } = {},
): Promise<{ res: Response; body: unknown }> {
  const headers = { ...authHeaders(ctx), ...init.headers };
  try {
    const res = await ctx.fetch(url, { ...init, headers, signal: ctx.signal });
    return { res, body: opts.as === "text" ? await res.text() : await readBody(res) };
  } catch (err) {
    throw redactError(errorFromFetchFailure(err, ctx.signal), ctx.log);
  }
}
