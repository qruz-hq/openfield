import badKey from "../openai/__fixtures__/bad-key.json";
import forbidden from "../openai/__fixtures__/forbidden.json";
import foreignAsset from "../openai/__fixtures__/foreign-asset.json";
import invalidSize from "../openai/__fixtures__/invalid-size.json";
import modelsList from "../openai/__fixtures__/models-list.json";
import moderationInput from "../openai/__fixtures__/moderation-input.json";
import moderationOutput from "../openai/__fixtures__/moderation-output.json";
import noCredit from "../openai/__fixtures__/no-credit.json";
import rateLimited from "../openai/__fixtures__/rate-limited.json";
import serverError from "../openai/__fixtures__/server-error.json";
import unavailable from "../openai/__fixtures__/unavailable.json";
import { openAiBatchRoutes } from "./openai-batch";
import { badRequest, type ImageRequest, imagesResponse, json, planImages } from "./openai-common";
import { probeImage } from "./png";
import {
  type FakeRoute,
  type FakeScenario,
  type RecordedExchange,
  replay,
  taggedScenario,
  wait,
} from "./types";

// A stand-in for api.openai.com: the Image API, the model list, and the Files and Batch APIs a
// Batch run uses. It checks requests against OpenAI's documented rules on its own
// (openai-common.ts), so a manifest that declares something the API doesn't take fails conformance.

const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: badKey,
  forbidden,
  invalid: invalidSize,
  rate_limited: rateLimited,
  no_billing: noCredit,
  server_error: serverError,
  unavailable,
  refused: moderationOutput,
  blocked: moderationInput,
  foreign_asset: foreignAsset,
};

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export const openAiFake: FakeRoute = {
  providerId: "openai",
  hosts: ["api.openai.com"],
  fixtures,

  async handle(request, env) {
    const url = new URL(request.url);
    const key = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!key) return replay(badKey);
    // Any key works, except one containing "invalid", so first-run tests can see a rejection.
    const keyScenario: FakeScenario | undefined = key.includes("invalid") ? "bad_key" : undefined;
    const forced = env.scenario ?? keyScenario;
    const failure = forced && fixtures[forced];

    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (forced && forced !== "success" && forced !== "slow") return replay(failure ?? serverError);
      const data = modelsList.response.body.data.filter((m) => !env.hiddenModels.includes(m.id));
      return replay(modelsList, { ...modelsList.response.body, data });
    }

    const batch = openAiBatchRoutes(request, url, env);
    if (batch) return failure ? replay(failure) : batch;

    if (request.method !== "POST")
      return json(404, { error: { message: "Not found", type: "invalid_request_error" } });
    let body: ImageRequest;
    let inputs: { width: number; height: number }[] = [];
    if (url.pathname === "/v1/images/generations") {
      body = (await request.json()) as ImageRequest;
    } else if (url.pathname === "/v1/images/edits") {
      const parsed = await editBody(request);
      if (parsed instanceof Response) return parsed;
      ({ body, inputs } = parsed);
    } else {
      return json(404, { error: { message: `Unknown path ${url.pathname}`, type: "invalid_request_error" } });
    }

    const scenario = forced ?? taggedScenario(String(body.prompt ?? "")) ?? "success";
    const recorded = fixtures[scenario];
    if (recorded) return replay(recorded);
    const planned = planImages(body, env, inputs);
    if (planned instanceof Response) return planned;
    // A blocking call held open, so stopping or killing the server lands mid-call. OpenAI keeps no
    // id for it, so a call cut off here can only run again (§0.4).
    if (scenario === "slow") await wait(env.slowMs, request.signal);
    return json(200, await imagesResponse(planned, body));
  },
};

/** A multipart edit: its fields, and the sizes of image[] (1 to 16) and the mask, checked. */
async function editBody(
  request: Request,
): Promise<{ body: ImageRequest; inputs: { width: number; height: number }[] } | Response> {
  const form = await request.formData();
  const body: Record<string, unknown> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string")
      body[name] = name === "n" || name === "output_compression" ? Number(value) : value;
  }
  const images = form.getAll("image[]").filter((v) => typeof v !== "string") as unknown as Blob[];
  if (!images.length)
    return badRequest("Missing required parameter: 'image'.", "image", "missing_required_parameter");
  if (images.length > 16) return badRequest("At most 16 images can be edited at once.", "image");
  const inputs = [];
  for (const image of images) {
    const probed = probeImage(new Uint8Array(await image.arrayBuffer()));
    if (!probed || !IMAGE_TYPES.includes(probed.mimeType))
      return badRequest("Images must be png, webp or jpg.", "image", "invalid_image_format");
    if (image.size > 50 * 1024 * 1024) return badRequest("Images must be under 50MB.", "image");
    inputs.push({ width: probed.width, height: probed.height });
  }
  const mask = form.get("mask");
  if (mask && typeof mask !== "string") {
    const probed = probeImage(new Uint8Array(await mask.arrayBuffer()));
    if (probed?.mimeType !== "image/png")
      return badRequest("The mask must be a PNG with an alpha channel.", "mask");
    if (probed.width !== inputs[0]!.width || probed.height !== inputs[0]!.height)
      return badRequest("The mask must be the same size as the first image.", "mask");
  }
  return { body: body as ImageRequest, inputs };
}
