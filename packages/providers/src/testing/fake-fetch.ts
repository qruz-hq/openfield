import type { FetchLike } from "../types";
import { googleFake } from "./google";
import { higgsfieldFake } from "./higgsfield";
import { openAiFake } from "./openai";
import { resumableFake } from "./resumable";
import { type FakeRoute, type FakeScenario, wait } from "./types";

// OPENFIELD_FAKE_PROVIDERS=1 hands this to every adapter as ctx.fetch, so the whole app runs end
// to end with no keys, no network and no cost (§6.12). Tests use it with a forced scenario.

/**
 * One fake per built-in adapter (docs/adding-a-provider.md, step 14), plus the test company that
 * only exists in fake mode (testing/resumable.ts).
 */
export const builtinFakes: readonly FakeRoute[] = [googleFake, openAiFake, higgsfieldFake, resumableFake];

export interface FakeFetchOptions {
  /** Forces one outcome for every call. Otherwise a "#fake:<name>" prompt tag picks it. */
  scenario?: FakeScenario;
  /** Milliseconds before each answer, or a [min, max] range. Default 900 to 2200, like a fast model. */
  delayMs?: number | readonly [number, number];
  /** Longest edge of generated images. Default 768, small enough to keep tests and e2e quick. */
  maxEdge?: number;
  /** Model ids to leave out of model list answers, to test discovery. */
  hiddenModels?: readonly string[];
  routes?: readonly FakeRoute[];
  /** The clock batch and resumable timelines follow. Default Date.now; tests move it by hand. */
  now?: () => number;
  /** How long a "#fake:slow" call holds its answer. Default 30 seconds. */
  slowMs?: number;
  /** How long a "#fake:resume_slow" call to the resumable test model runs. Default 60 seconds. */
  resumeSlowMs?: number;
}

export interface FakeCall {
  method: string;
  url: string;
  host: string;
}

export interface FakeFetch extends FetchLike {
  /** Every request, in order, for host allow-list and "only ctx.fetch" checks. */
  readonly calls: FakeCall[];
}

export function createFakeFetch(opts: FakeFetchOptions = {}): FakeFetch {
  const routes = opts.routes ?? builtinFakes;
  const calls: FakeCall[] = [];
  let counter = 0;
  const env = {
    ...(opts.scenario && { scenario: opts.scenario }),
    nextSeed: () => counter++,
    maxEdge: opts.maxEdge ?? 768,
    hiddenModels: opts.hiddenModels ?? [],
    now: opts.now ?? Date.now,
    slowMs: opts.slowMs ?? 30_000,
    resumeSlowMs: opts.resumeSlowMs ?? 60_000,
    store: new Map<string, unknown>(),
  };

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(typeof input === "string" ? input : input.href, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, url: url.origin + url.pathname, host: url.host });

    const route = routes.find((r) => r.hosts.includes(url.host));
    // An unknown host is a bug in the caller; fail the way a real network error would.
    if (!route) throw new TypeError(`fetch failed: ${url.host} has no fake`);

    await wait(pickDelay(opts.delayMs), request.signal);
    return route.handle(request, env);
  };
  return Object.assign(fakeFetch, { calls });
}

function pickDelay(delay: FakeFetchOptions["delayMs"] = [900, 2200]): number {
  if (typeof delay === "number") return delay;
  const [min, max] = delay;
  return min + Math.random() * (max - min);
}
