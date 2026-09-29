import { type CallContext, errorFromFetchFailure, ProviderError, readBody, redactError } from "../types";
import { COMPANY } from "./capabilities";

export interface ByteplusInit {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

/**
 * Every call to the ModelArk API goes through here: the key as a Bearer token in the header
 * (never the URL), the call's signal, the body read, and a failed fetch turned into a redacted
 * ProviderError.
 */
export async function byteplusFetch(
  ctx: CallContext,
  url: string,
  init: ByteplusInit = {},
): Promise<{ res: Response; body: unknown }> {
  const key = ctx.credentials.apiKey?.trim();
  if (!key) throw new ProviderError("auth_missing", { message: `No ${COMPANY} key is set` });
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await ctx.fetch(url, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: ctx.signal,
    });
    return { res, body: await readBody(res) };
  } catch (err) {
    throw redactError(errorFromFetchFailure(err, ctx.signal), ctx.log);
  }
}
