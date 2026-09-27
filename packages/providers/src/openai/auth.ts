import { type CallContext, ProviderError } from "../types";

/** A bearer key in the Authorization header, as OpenAI documents it. */
export function authHeaders(ctx: CallContext): Record<string, string> {
  const key = ctx.credentials.apiKey?.trim();
  if (!key) throw new ProviderError("auth_missing", { message: "No OpenAI key is set" });
  return { authorization: `Bearer ${key}` };
}
