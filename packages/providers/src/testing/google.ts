import badKey from "../google/__fixtures__/bad-key.json";
import blockedPrompt from "../google/__fixtures__/blocked-prompt.json";
import flexBusy from "../google/__fixtures__/flex-busy.json";
import forbidden from "../google/__fixtures__/forbidden.json";
import foreignAsset from "../google/__fixtures__/foreign-asset.json";
import invalidArgument from "../google/__fixtures__/invalid-argument.json";
import modelsList from "../google/__fixtures__/models-list.json";
import noBilling from "../google/__fixtures__/no-billing.json";
import noImage from "../google/__fixtures__/no-image.json";
import rateLimited from "../google/__fixtures__/rate-limited.json";
import refused from "../google/__fixtures__/refused-image-safety.json";
import serverError from "../google/__fixtures__/server-error.json";
import unavailable from "../google/__fixtures__/unavailable.json";
import { batchRoutes } from "./google-batch";
import {
  badRequest,
  files,
  type GenerateBody,
  imageResponse,
  json,
  notFound,
  planImage,
  promptOf,
  storeMap,
} from "./google-common";
import {
  type FakeEnv,
  type FakeRoute,
  type FakeScenario,
  type RecordedExchange,
  replay,
  taggedScenario,
} from "./types";

// A stand-in for generativelanguage.googleapis.com. It checks requests against Google's documented
// tables on its own, rather than against our manifests, so a manifest that declares something the
// API doesn't take fails the conformance suite.

const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: badKey,
  forbidden,
  invalid: invalidArgument,
  rate_limited: rateLimited,
  no_billing: noBilling,
  server_error: serverError,
  unavailable,
  blocked: blockedPrompt,
  refused,
  no_image: noImage,
  foreign_asset: foreignAsset,
};

export const googleFake: FakeRoute = {
  providerId: "google",
  hosts: ["generativelanguage.googleapis.com"],
  fixtures,

  async handle(request, env) {
    const url = new URL(request.url);
    const key = request.headers.get("x-goog-api-key");
    if (!key) return replay(forbidden);
    if (url.searchParams.has("key")) return badRequest("Pass the key in the x-goog-api-key header.");
    // Any key works, except one containing "invalid", so first-run tests can see a rejection.
    const keyScenario: FakeScenario | undefined = key.includes("invalid") ? "bad_key" : undefined;
    const forced = env.scenario ?? keyScenario;
    const failure = forced && fixtures[forced];

    if (request.method === "GET" && url.pathname === "/v1beta/models") {
      if (forced && forced !== "success") return replay(failure ?? serverError);
      const models = modelsList.response.body.models.filter(
        (m) => !env.hiddenModels.includes(m.name.replace(/^models\//, "")),
      );
      return replay(modelsList, { ...modelsList.response.body, models });
    }

    const batch = batchRoutes(request, url, env);
    if (batch) return failure ? replay(failure) : batch;

    const match = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return notFound(url.pathname);

    const body = (await request.json()) as GenerateBody;
    const text = promptOf(body);
    const scenario = forced ?? taggedScenario(text) ?? "success";
    const recorded = fixtures[scenario];
    if (recorded) return replay(recorded);

    const modelId = decodeURIComponent(match[1]!);
    const planned = planImage(modelId, body, env, (name) => files(env).get(name));
    if (planned instanceof Response) return planned;

    // Google refuses Flex for capacity with a 503, and never moves it up to Standard itself.
    const tier = body.serviceTier;
    if (scenario === "flex_busy" && tier === "flex") {
      const busy = counters(env);
      const seen = busy.get(`${modelId}|${text}`) ?? 0;
      busy.set(`${modelId}|${text}`, seen + 1);
      // Google documents no wait for Flex; a short Retry-After keeps fake runs quick.
      if (seen % 2 === 0) return replay(flexBusy, flexBusy.response.body, { "retry-after": "2" });
    }
    // Priority over its limits is served, and billed, at Standard without an error.
    const served =
      scenario === "priority_standard" && tier === "priority" ? "standard" : (tier ?? "standard");
    return json(200, await imageResponse(planned, { serviceTier: served, responseId: true, env }));
  },
};

const counters = (env: FakeEnv) => storeMap<string, number>(env, "google:flex-busy");
