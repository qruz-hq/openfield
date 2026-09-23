# Adding a provider

A provider is one company's image API. In code it is an **adapter**: a folder in `packages/providers/src/<name>/` that implements the `Provider` interface and describes every model with a **capability manifest**. The app builds each control from the manifest, so a new adapter needs no UI work.

This guide follows section 6 of the [PRD](PRD.md). The exact type names and fields live in code:

- `packages/providers/src/types/`: behaviour (`Provider`, `ImageModel`, `CallContext`, `AssetSink`, `RedactingLogger`, the result types).
- `packages/core/src/schemas/`: data (`ProviderMeta`, `CredentialSchema`, `ModelManifest`, `Capabilities`, `PriceModel`, `NormalizedRequest`, `ErrorCode`).

If this guide and the code disagree, the code wins. Please fix the guide in your pull request.

## Before you start

- Open a **New provider** issue with links to the company's API docs and pricing. A good fit has a public API, takes a key the person owns, and has terms that allow this use.
- You need your own key to record fixtures and for one live test run. Nobody else does: CI runs offline.
- Read §0.3 (the manifest), §6.2 to §6.9, and §6.12 (the authoring rules this guide condenses).

## 1. Create the folder

```
packages/providers/src/acme/
  index.ts          createAcmeProvider(): Provider
  models.ts         static catalog: ModelManifest[]
  capabilities.ts   shared capability fragments and per-model overrides
  pricing.ts        PriceModel per model, with pricedAt and sourceUrl
  map-request.ts    NormalizedRequest to the company's payload
  map-response.ts   the company's response to a JobResult
  errors.ts         mapError()
  discovery.ts      listModels() and recognise()
  README.md         endpoints, auth, gaps, how fixtures were captured
  __fixtures__/     recorded HTTP exchanges, keys removed

packages/providers/src/testing/acme.ts   the offline stand-in for the company's API (step 11)
```

The folder name is the provider id: a lowercase slug with no colon. `types` and `manifest` are reserved.

An adapter imports only `../types`, its own folder and `@openfield/core`. Never another adapter, never `@openfield/db`, never an app. Nothing in the browser may import it: Biome blocks the import and `bun run check:bundle` fails if one slips through.

## 2. Describe the provider

```ts
meta: {
  id: "acme",
  displayName: "Acme",
  docsUrl: "https://docs.acme.example",
  consoleUrl: "https://console.acme.example/keys",
  networkHosts: ["api.acme.example"],
  assetHosts: [],
  stable: true,
},
credentials: {
  fields: [{
    name: "apiKey", label: "API key", secret: true, required: true,
    envVars: ["OPENFIELD_ACME_API_KEY", "ACME_API_KEY"],
  }],
},
```

- `networkHosts` lists every API host. `assetHosts` lists every host an image may be downloaded from. Use `[]` when images arrive inline in the response, which is the safest choice. The server blocks any other host at runtime.
- `envVars` puts `OPENFIELD_<PROVIDER>_<FIELD>` first, then the company's usual variable name.
- `validateCredentials()` checks the shape only, with no network. `verifyCredentials()` makes one cheap call that proves the key works; it powers **Check key**.
- `stable: false` hides the provider behind Settings > Experimental.
- Labels, help text and placeholders are UI copy. Follow the copy rules in [CONTRIBUTING.md](../CONTRIBUTING.md#ui-copy).

## 3. Declare the models

`models.ts` exports the static catalog, one `ModelManifest` per model. It is always available, so the app boots and shows the model with no key and no network.

- `key` is `<providerId>:<modelId>`, and `modelId` is the exact id sent on the wire.
- `displayName` is the company's product name. `description` is our own copy, 90 characters at most.
- Bump `manifestVersion` whenever a capability changes. Runs freeze the version they used.

The capability rules:

1. Declare only what you verified against the live API or the official docs. When unsure, leave it out and note it in the adapter README. A false "yes" breaks the UI; a false "no" only hides a control.
2. Every aspect ratio you declare must map to a valid payload.
3. `quality.levels[].id` is the exact wire value. The label and hint are ours.
4. `batch.native: true` means you return exactly `n` images or an error. Otherwise the runner makes one call per image.
5. If the company rewrites prompts, return `revisedPrompt`. If it always watermarks or moderates, say so in `safety.notices`.
6. `limits.typicalLatencyMs` comes from at least 10 real runs.
7. A control that doesn't work gets an `unsupported` entry whose reason names the model, like "Nano Banana Pro doesn't support seeds." A control the adapter fakes goes in `emulated`.
8. `controlOrder` sets the order of the controls in the composer.

## 4. Add prices

`pricing.ts` declares a `PriceModel` for each model, with `pricedAt` and `sourceUrl`. Use `per_image`, `per_token` (with a table of output tokens per quality and size) or `per_second`, and `unknown` when there is no published price. The UI then shows "Cost unknown".

You don't write an estimate function. The shared, pure `estimate(manifest, request)` in `@openfield/providers/manifest` reads your price data, in the browser and on the server alike. Add `estimateRemote()` only when the company has a documented cost endpoint.

## 5. Map the request

Every method receives a `NormalizedRequest`. Before your code runs, core has already:

- resolved presets, characters and palettes into plain prompt text (`promptAfterPreset`) and plain references;
- checked the request against your manifest;
- resolved the size to pixels, or to an aspect ratio if that's what you declared;
- filled seeds, but only when you declare seed support;
- appended an "Avoid: ..." sentence when the model has no native field for it;
- split the batch into single calls when `batch.native` is false.

`map-request.ts` turns that into the company's payload. Keep it a pure function so golden tests can snapshot it.

Reference, base and mask images arrive as asset ids, never as base64 or file paths. Read their bytes through the call context; see `CallContext` in `packages/providers/src/types/`. Masks follow one rule everywhere: alpha 0 marks the area to change, alpha 255 keeps it. Convert that to whatever the company expects, and cover the conversion with a fixture test.

## 6. Submit, poll and cancel

- **Always call `ctx.fetch`, never the global `fetch`.** The server's version adds timeouts, redacted logging and the host allow-list. Tests pass a stub, and `OPENFIELD_FAKE_PROVIDERS=1` passes your fake (step 11), which is how the whole app runs with no keys.
- Pass `ctx.signal` so a cancel aborts the call.
- If the API honours an idempotency header, send `` `${req.idempotencyKey}:${req.batchIndex}` ``. It stays the same across retries, so a retry can't bill twice.
- Send the key in a header. Never put it in the URL, where it ends up in logs.
- **Synchronous APIs:** `submit()` makes the blocking call and returns a handle that already carries the result. The first `poll()` returns `succeeded`.
- **Queue APIs:** `submit()` returns as soon as the company accepts the job, with `providerRef` or `statusUrl`. Anything needed to resume after a restart goes in `handle.resume`, as plain JSON.
- `poll()` must be safe to call again, including after a terminal state.
- Implement `cancel()` only if the API supports it. Without it the runner stops waiting and tells the person they may still be charged.

## 7. Save the images

`map-response.ts` streams every image into `ctx.assets.write()` and returns asset ids with width, height, MIME type and size. Never return base64 or data URLs. Store the bytes exactly as returned: no re-encoding and no metadata stripping, so provenance watermarks survive.

If images come as URLs, download them only from `assetHosts`, over `https:`. Return `revisedPrompt`, `usage` and safety results when the API provides them.

## 8. Map errors

`errors.ts` exports one function with one signature:

```ts
export async function mapError(res: Response, body?: unknown): Promise<ProviderError>;
// every call site: throw await mapError(res, body)
```

| The company says | `ErrorCode` |
|---|---|
| 401, bad key | `auth_invalid` |
| 403, no access to this model | `auth_forbidden` |
| No credit or payment method | `billing_required` |
| Hard usage limit | `quota_exceeded` |
| 429 | `rate_limited`, with `retryAfterMs` from `Retry-After` |
| 400 about one setting | `unsupported_param` or `invalid_request`, with `field` |
| 413, image too large | `payload_too_large` |
| Output blocked by safety | `content_refused` |
| An input image rejected | `content_flagged_input` |
| 5xx | `provider_unavailable` |
| DNS, TLS or socket failure | `network` |
| Aborted or timed out | `timeout` |
| Anything else | `unknown` |

Only `network`, `timeout`, `rate_limited` and `provider_unavailable` are retryable. Use the shared copy for `userMessage` (§0.5) rather than writing new messages per adapter. Keep the company's own code in `providerCode`: it shows in the Error log, not in the UI. Never put a key or a raw response body in an error.

## 9. Discovery

`listModels()` must return the static catalog. Network discovery is optional: when you add it, keep only ids your `recognise(id)` accepts, let static capabilities win over anything discovered, and fall back to the catalog when discovery fails. Unrecognised ids are listed in Settings as not supported and never reach the model picker.

## 10. Record fixtures

`__fixtures__/` holds recorded HTTP exchanges. Your fake (step 11) replays the error ones, and the conformance suite checks your mapping against them. Follow the format of the existing adapters. Remove keys and auth headers when you capture, and swap large images for small ones.

At minimum, record:

- a success for every operation you declare;
- a 401;
- a 429 with `Retry-After: 12`;
- a 500 or 503;
- a safety refusal;
- a model list response, if you implement discovery.

## 11. Write the fake

The conformance suite and `OPENFIELD_FAKE_PROVIDERS=1` never touch the network. They send every call to a hand-written stand-in for the company's API, and the suite stops with "<id> has no fake in src/testing/" until yours exists.

Write `packages/providers/src/testing/acme.ts` exporting a `FakeRoute` (see `testing/types.ts`), with `testing/google.ts` as the model:

- `hosts` lists the same hosts as `meta.networkHosts`.
- `handle()` checks each request against the company's **documented** rules (ratios, sizes, limits), written out in the fake itself rather than read from your manifests. That's what catches a manifest that declares something the API doesn't take.
- For errors, it replays your fixtures, picked by a `#fake:<name>` tag in the prompt (`FAKE_SCENARIOS`). A key containing "invalid" answers like a rejected key.
- For success, it makes up a small image of the requested size (`gradientPng()` in `testing/png.ts`), in the company's response format.

Then add it to `builtinFakes` in `packages/providers/src/testing/fake-fetch.ts`.

## 12. Pass the conformance suite

```sh
bun test packages/providers/conformance
```

It runs offline against your fake and fixtures and checks, among other things, that:

- every manifest parses in strict mode and its defaults are in its own option lists;
- every declared ratio and quality id maps to a valid payload;
- `estimate()` is pure for your prices;
- handles survive a JSON round trip and `poll()` is safe to repeat;
- batches return exactly `n` images;
- 401, 429, 5xx, refusal and timeout map to the right codes;
- no base64 crosses the interface and no key appears in any log, error or stored response;
- only hosts in `networkHosts` and `assetHosts` are contacted.

Then run it once against the real API with your key, and say so in the pull request:

```sh
OPENFIELD_CONFORMANCE=live bun test packages/providers/conformance
```

## 13. Register the adapter

Add it to `builtinProviders` in `packages/providers/src/registry.ts`. Registration is static: there is no plugin loading and no remote code.

## 14. Write the adapter README

Cover the endpoints, how auth works, the hosts, what you verified and how, known gaps, the date you checked prices, and how the fixtures were captured.

## Pull request checklist

- [ ] `bun run lint`, `bun run typecheck`, `bun test` and `bun run check:bundle` pass.
- [ ] Offline conformance passes, and you ran it live once.
- [ ] Every capability is verified, and anything unverified is left out and listed in the adapter README.
- [ ] Prices carry `pricedAt` and `sourceUrl`, or the price is `unknown`.
- [ ] Fixtures contain no keys.
- [ ] `src/testing/<name>.ts` exists and is listed in `builtinFakes`.
- [ ] All HTTP goes through `ctx.fetch`.
- [ ] Any new UI copy follows the copy rules.
