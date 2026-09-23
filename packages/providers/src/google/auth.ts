import { type CallContext, ProviderError } from "../types";

/** The key goes in a header, never the ?key= query form, which ends up in logs (§6.13). */
export function authHeaders(ctx: CallContext): Record<string, string> {
  const key = ctx.credentials.apiKey?.trim();
  if (!key) throw new ProviderError("auth_missing", { message: "No Google key is set" });
  return { "x-goog-api-key": key };
}
