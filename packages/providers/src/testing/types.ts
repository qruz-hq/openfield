// Shared shapes for the fake HTTP layer. Each adapter ships a FakeRoute that answers like its API.

/** Outcomes every fake can play back. Pick one per call with a "#fake:<name>" tag in the prompt. */
export const FAKE_SCENARIOS = [
  "success",
  "bad_key",
  "forbidden",
  "invalid",
  "rate_limited",
  "no_billing",
  "server_error",
  "unavailable",
  "blocked",
  "refused",
  "no_image",
  "foreign_asset",
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

/** One recorded (or, until we have a key, hand-made) HTTP exchange. */
export interface RecordedExchange {
  request: { method: string; path: string };
  response: { status: number; headers?: Record<string, string>; body: unknown };
}

export interface FakeEnv {
  /** Forced outcome for every call. Otherwise the prompt tag, then the key, decide. */
  scenario?: FakeScenario;
  /** A new number per call, so a batch of the same prompt still gives different images. */
  nextSeed(): number;
  /** Longest edge of generated images. */
  maxEdge: number;
  /** Model ids to leave out of model list answers, to test discovery. */
  hiddenModels: readonly string[];
}

export interface FakeRoute {
  providerId: string;
  hosts: readonly string[];
  handle(request: Request, env: FakeEnv): Promise<Response>;
  fixtures: Partial<Record<FakeScenario, RecordedExchange>>;
}

export function replay(exchange: RecordedExchange, body: unknown = exchange.response.body): Response {
  return new Response(JSON.stringify(body), {
    status: exchange.response.status,
    headers: { "content-type": "application/json; charset=UTF-8", ...exchange.response.headers },
  });
}

/** The scenario named by a "#fake:<name>" tag, if any. */
export function taggedScenario(text: string): FakeScenario | undefined {
  const tag = /#fake:([a-z_]+)/.exec(text)?.[1];
  return (FAKE_SCENARIOS as readonly string[]).includes(tag ?? "") ? (tag as FakeScenario) : undefined;
}
