import { hostAllowed, type SettingValue, type SpeedId, t } from "@openfield/core";
import {
  type AssetSink,
  type CallContext,
  type FetchLike,
  type Provider,
  ProviderError,
  type RedactingLogger,
} from "@openfield/providers/server";
import type { ProviderConfig } from "../config/config-file";
import type { Logger } from "../log/logger";
import type { CredentialService } from "../services/credentials";

// The only way an adapter reaches the network (§6.2, §6.11): https only, hosts from the adapter's
// own networkHosts and assetHosts ("*.parent" is one label under a parent the company owns), no
// redirects to another host, and a redacted log line per call.

const MAX_REDIRECTS = 3;
/** Bun's own option: only the call's signal ends it, so its 5-minute idle timer can't cut Flex short. */
const NO_IDLE_TIMEOUT = { timeout: false } as RequestInit;

export function providerFetch(base: FetchLike, provider: Provider, log: RedactingLogger): FetchLike {
  const allowed = [...provider.meta.networkHosts, ...provider.meta.assetHosts];

  const refuse = (url: URL, why: string) => {
    log.warn(why, { host: url.host });
    return new ProviderError("provider_error", {
      message: `${why}: ${url.host}`,
      userMessage: t("errors.imageBlocked"),
    });
  };
  const check = (url: URL) => {
    if (url.protocol !== "https:") throw refuse(url, "Refused a request that wasn't https");
    if (!hostAllowed(url.host, allowed))
      throw refuse(url, "Refused a request to a host the adapter didn't declare");
  };

  return async (input, init) => {
    // Read the URL and method without building a Request, which would lock a streamed body.
    let url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    check(url);
    const started = performance.now();
    let res = await base(input, { ...init, ...NO_IDLE_TIMEOUT, redirect: "manual" });

    for (let hop = 0; isRedirect(res.status) && hop < MAX_REDIRECTS; hop++) {
      const next = new URL(res.headers.get("location") ?? "", url);
      if (next.host !== url.host) throw refuse(next, "Refused a redirect to another host");
      if (method !== "GET" && method !== "HEAD") throw refuse(next, "Refused to resend a request body");
      check(next);
      url = next;
      res = await base(next, {
        method,
        headers: init?.headers ?? (input instanceof Request ? input.headers : undefined),
        signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
        ...NO_IDLE_TIMEOUT,
        redirect: "manual",
      });
    }

    log.debug(`${method} ${url.host}${url.pathname} ${res.status}`, {
      ms: Math.round(performance.now() - started),
    });
    return res;
  };
}

const isRedirect = (status: number) => status >= 300 && status < 400 && status !== 304;

export interface ContextOptions {
  /** A key being checked before it's saved. */
  candidate?: ProviderConfig;
  /** The run's frozen company settings (§0.3). Empty for calls that aren't runs. */
  settings?: Readonly<Record<string, SettingValue>>;
  /** The run's resolved speed. Standard for calls that aren't runs. */
  speed?: SpeedId;
}

/**
 * Builds CallContexts for one provider at a time. Null when the provider has no usable key, or
 * was turned off: then nothing can reach its hosts (§0.6).
 */
export class CallContexts {
  constructor(
    private readonly base: FetchLike,
    private readonly credentials: CredentialService,
    private readonly logger: Logger,
    private readonly enabled: (providerId: string) => boolean = () => true,
  ) {}

  for(
    provider: Provider,
    signal: AbortSignal,
    assets: AssetSink,
    opts: ContextOptions = {},
  ): CallContext | null {
    if (!this.enabled(provider.meta.id)) return null;
    const cred = this.credentials.resolve(provider.meta.id, opts.candidate);
    if (!cred.present) return null;
    const log = this.logger.scoped(provider.meta.id);
    return {
      credentials: cred.values,
      fetch: providerFetch(this.base, provider, log),
      signal,
      log,
      now: Date.now,
      assets,
      settings: opts.settings ?? {},
      speed: opts.speed ?? "standard",
    };
  }
}

/** Discovery and key checks never write images. */
export const noWrites = (read: AssetSink["read"]): AssetSink => ({
  write: async () => {
    throw new ProviderError("provider_error", { message: "Nothing should be written here" });
  },
  read,
});
