# Adding a provider

A provider is one company's image API. In code it is an **adapter**: a folder in `packages/providers/src/<name>/` that implements the `Provider` interface and describes every model with a **capability manifest**. The app builds each control from the manifest, and draws the company's own settings from a schema the adapter declares, so a new adapter needs no UI work.

This guide follows section 6 of the [PRD](PRD.md). The exact type names and fields live in code:

- `packages/providers/src/types/`: behaviour (`Provider`, `ImageModel`, `CallContext`, `AssetSink`, `RedactingLogger`, the result types).
- `packages/core/src/schemas/`: data (`ProviderMeta`, `CredentialSchema`, `ModelManifest`, `Capabilities`, `PriceModel`, `SpeedOffer`, `ProviderSettingsSchema`, `BatchHandle`, `NormalizedRequest`, `ErrorCode`).

If this guide and the code disagree, the code wins. Please fix the guide in your pull request.

## Before you start

- Open a **New provider** issue with links to the company's API docs and pricing. A good fit has a public API, takes a key the person owns, and has terms that allow this use.
- You need your own key to record fixtures and for one live test run. Nobody else does: CI runs offline.
- Read §0.3 (the manifest, speeds and provider settings), §0.4 (how each speed runs), §6.2 to §6.9, and §6.12 (the authoring rules this guide condenses).

## 1. Create the folder

```
packages/providers/src/acme/
  index.ts          createAcmeProvider(): Provider
  models.ts         static catalog: ModelManifest[]
  capabilities.ts   shared capability fragments and per-model overrides
  pricing.ts        PriceModel per model and per speed, with pricedAt and sourceUrl
  settings.ts       the company's settings panels, if it has any (step 6)
  batch.ts          the batch path, if a model offers the Batch speed (step 9)
  map-request.ts    NormalizedRequest to the company's payload
  map-response.ts   the company's response to a JobResult
  errors.ts         mapError()
  discovery.ts      listModels() and recognise()
  README.md         endpoints, auth, gaps, how fixtures were captured
  __fixtures__/     recorded HTTP exchanges, keys removed

packages/providers/src/testing/acme.ts   the offline stand-in for the company's API (step 14)
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

You don't write an estimate function. The shared, pure `estimate(manifest, request)` in `@openfield/providers/manifest` reads your price data, in the browser and on the server alike. Add `estimateRemote()` only when the company has a documented cost endpoint, and give those models `price.kind: "provider_estimate"`. The server then asks it for the composer, the canvas, Settings and each run, through one cache that keeps each answer for a day (`apps/server/src/services/remote-prices.ts`). It swaps the prompt and seed for fixed ones before asking, so check that your company's price doesn't depend on them. Return `confidence: "unknown"` when the company answers without an amount.

## 5. Offer speeds (optional)

Some companies sell the same model at more than one speed: cheaper and slower, or dearer and first in line. `price` on the manifest is always the **Standard** price. Declare every other speed the model offers in `speeds`, each with its own price in the same `PriceModel` union:

```ts
speeds: [
  { id: "batch", price: BATCH_PRICE, delivery: "async", waitMs: { target: 24 * HOUR, max: 48 * HOUR } },
  { id: "flex", price: FLEX_PRICE, delivery: "sync", waitMs: { target: 60_000, max: 900_000 }, requestTimeoutMs: 900_000 },
],
```

- The ids are `SPEED_IDS` in `packages/core/src/constants.ts`: `flex`, `priority` and `batch`. Leave `speeds` out for a model that runs at Standard only.
- `delivery` is `"async"` exactly for `batch`: its results arrive later, from a provider batch (step 9).
- `waitMs` comes from the company's docs. It drives copy and timers, never correctness. `requestTimeoutMs` gives a slow sync speed a longer call timeout. `ops` limits an offer to some operations.
- Declare an offer only when the company's own pricing page lists it for that model, with `pricedAt` and `sourceUrl`. A change to `speeds` bumps `manifestVersion`.

Nobody picks a speed in the composer. The person picks it once, in your company's settings (step 6), and a model that lacks the chosen speed runs at Standard, which the app says where the price shows. The estimate, the Generate price, the usage log and the spend totals all follow the speed a run actually used.

## 6. Declare company settings (optional)

A company with choices of its own, like a speed or a rule for what to do when it's busy, declares them as data on `Provider.settings`: a `ProviderSettingsSchema` of panels, each holding fields. Openfield draws them in the company's settings modal (Settings > API keys > **Settings** on your card), checks and stores the values, and hands you the resolved values on every call. Adapters never draw UI and never read storage. Google's is `packages/providers/src/google/settings.ts`:

```ts
export const ACME_SETTINGS: ProviderSettingsSchema = {
  version: 1,
  panels: [
    {
      id: "speed",
      label: "Speed",
      description: "How quickly Acme makes your images. Waiting longer costs less.",
      fields: [
        {
          id: "speed", kind: "select", role: "speed", label: "Speed", default: "standard",
          options: [
            { value: "standard", label: "Standard", description: "Images arrive in seconds." },
            { value: "flex", label: "Flex", speed: "flex", description: "Half price. Takes a few minutes." },
          ],
        },
      ],
    },
    {
      // Its own panel, so it stays in view (muted, with a note) while Speed isn't Flex.
      id: "flexBusy",
      label: "When it's busy",
      fields: [
        {
          id: "flexBusy", kind: "select", label: "When Flex is busy", default: "wait",
          showWhen: [{ field: "speed", in: ["flex"] }],
          options: [
            { value: "wait", label: "Keep trying at Flex price", priceAt: "flex" },
            { value: "standard", label: "Switch to Standard", priceAt: "standard" },
          ],
        },
      ],
    },
  ],
};
```

Field kinds are `select` (option cards, each with a one-line description), `toggle`, `number` (a `stepper` or an `input`, with `min`, `max` and `step`) and `text` (with `maxLength`). Every field has a `default`, and may have a `description`, `showWhen` conditions on other fields, and `models` when it applies to only some of your models. A select option may list `models` too, and `priceAt` names the speed a run bills at under that choice, so its card shows that price. The modal holds at most 12 panels, Limits included, and 8 options per select.

A field whose condition reads a field in the same panel is hidden while the condition fails. One whose condition reads a field in another panel stays in view, muted, with a note that names the condition and jumps to that panel. Put a choice that only matters at some speeds in its own panel, as above, so people can see it before they pick that speed.

The rules, which `providerSettingsSchemaSchema` and the conformance suite enforce (§0.3):

1. No secrets. A key is a credential field (step 2), never a setting.
2. The panel id `limits` and the field id `concurrencyCap` are Openfield's. Every modal ends with Openfield's own **Limits** panel ("Runs at once"), which the server adds. Don't declare it.
3. Every default is a legal value for every model the field applies to.
4. At most one field has `role: "speed"`. Its option values are speed ids, it includes and defaults to `"standard"`, each other option sets `speed` to its own value, and no speed option lists `models`: which models offer a speed, and at what price, comes from each manifest's `speeds` (step 5), so prices live in one place and the modal shows them per option.
5. `showWhen` may only point at fields declared earlier, so conditions never loop.

Labels and descriptions are UI copy: use the company's own names for its options ("Flex", "Batch"), and follow the copy rules in [CONTRIBUTING.md](../CONTRIBUTING.md#ui-copy). Bump `version` when a field's meaning changes. A stored value that no longer fits the schema is skipped and its default used.

At submit, Openfield resolves the settings for the run's model and freezes them on the request, so a later change never touches a run in flight, and **Recreate** replays the same choices. Every call then gets them on the context:

- `ctx.speed` is the speed to ask for, already checked against the model's offers. Outside runs, such as **Check key**, it's `"standard"`.
- `ctx.settings` holds every field of your schema, defaults filled. Parse what you need on every call and treat anything odd as the default (Google's `parseGoogleSettings()` does this).

## 7. Map the request

Every method receives a `NormalizedRequest`. Before your code runs, core has already:

- resolved presets, characters and palettes into plain prompt text (`promptAfterPreset`) and plain references;
- checked the request against your manifest;
- resolved the size to pixels, or to an aspect ratio if that's what you declared;
- filled seeds, but only when you declare seed support;
- appended an "Avoid: ..." sentence when the model has no native field for it;
- split the batch into single calls when `batch.native` is false.

`map-request.ts` turns that into the company's payload. Keep it a pure function so golden tests can snapshot it.

Reference, base and mask images arrive as asset ids, never as base64 or file paths. Read their bytes through the call context; see `CallContext` in `packages/providers/src/types/`. Masks follow one rule everywhere: alpha 0 marks the area to change, alpha 255 keeps it. Convert that to whatever the company expects, and cover the conversion with a fixture test.

A sync speed (Flex, Priority) usually adds one field to the same payload. Read it from `ctx.speed`, never from the request itself.

## 8. Submit, poll and cancel

- **Always call `ctx.fetch`, never the global `fetch`.** The server's version adds timeouts, redacted logging and the host allow-list. Tests pass a stub, and `OPENFIELD_FAKE_PROVIDERS=1` passes your fake (step 14), which is how the whole app runs with no keys.
- Pass `ctx.signal` so a cancel aborts the call.
- If the API honours an idempotency header, send `` `${req.idempotencyKey}:${req.batchIndex}` ``. It stays the same across retries, so a retry can't bill twice.
- Send the key in a header. Never put it in the URL, where it ends up in logs.
- **Synchronous APIs:** `submit()` makes the blocking call and returns a handle that already carries the result. The first `poll()` returns `succeeded`.
- **Queue APIs:** `submit()` returns as soon as the company accepts the job, with `providerRef` or `statusUrl`. Anything needed to resume after a restart goes in `handle.resume`, as plain JSON, and the speed goes in `resumableSpeeds` (below).
- `poll()` must be safe to call again, including after a terminal state.
- Implement `cancel()` only if the API supports it. Without it the runner stops waiting and tells the person they may still be charged.
- Report the speed the company says it served as `speedUsed` on the result (Google: `usageMetadata.serviceTier`). A Priority request served at Standard then bills at Standard. Leave it out when the company doesn't say.
- When the company refuses a slow speed for capacity, throw a `ProviderError` with `busy: true` and `retryable: true`. The runner then waits on its busy schedule instead of spending retries. If your settings let the person switch to Standard instead, resend once without the speed inside the same call and report `speedUsed: "standard"`, so the runner never sees the refusal.

### Resumable calls

An image must never be lost to a restart (§0.4). What Openfield can do when the server stops or crashes mid-call depends on your API, and you tell it per model and speed with `resumableSpeeds` on the manifest.

**List a speed as resumable** when the company keeps working with no open connection and answers a status read by id later: a queue API (fal's request id, Replicate's prediction id) or a background mode (OpenAI's Responses API with `background: true`). All of this must hold at that speed, for every op the model offers there:

1. `submit()` returns as soon as the company has the call and its id, with `providerRef` set and no result. Never wait for the image inside `submit()` at a resumable speed: no `Prefer: wait`, no long poll.
2. The handle is everything `poll()` and `cancel()` need, in `providerRef` and `handle.resume`, as plain JSON. After a restart it's all they get, in a fresh process with a fresh `CallContext`. It's saved to the library as it is, so never put a key, token or signed URL in `providerRef`, `statusUrl`, `cancelUrl` or `handle.resume`: `poll()` and `cancel()` build their auth from `ctx.credentials`. Conformance 27 checks the handle for the test keys, and the runner hides any loaded key before saving it, but that's a second guard, not the first.
3. `poll()` writes a finished image through `ctx.assets` once per sink, however often it's called.
4. A status read of an id the company no longer has throws `notFoundError()` (a `ProviderError` with `notFound: true`), so the runner can tell "gone" from a hiccup.

```ts
resumableSpeeds: ["standard"],
```

Implement `cancel()` if the API can: the runner uses it when the person cancels, and when a call is still running at its deadline. Keep sending the idempotency header on the create call.

**Declare `idempotentSubmit: true`** when the company documents that a create sent again with the same idempotency key returns the first request instead of starting a second one, and keeps the key for at least the job's deadline:

```ts
resumableSpeeds: ["standard"],
idempotentSubmit: true,
```

It decides what happens to a create whose answer never came back. With it, the runner sends the same create with the same key and gets the id back, both when the answer is lost on the way (the network, a timeout) and when a restart cut the create off. Without it, sending it again could start and bill a second image, so a create that failed that way ends with **Try again**, and one a restart cut off is interrupted. A create the company plainly refused (429 or 503) is sent again either way. Conformance 27 sends the same create twice when you declare it and expects the same id back.

**List nothing** for a blocking API that returns the image in its answer (Google `generateContent`, OpenAI's `/v1/images/*`). The call dies with the process. Never list `batch`: a Batch run always resumes, from its stored batch handle (step 9). It follows the same three steps (store the id before waiting, pick it up by id at boot, fetch instead of sending again) through the batch watcher and its `provider_batches` row instead of `jobs.handle`.

Both declarations are about your code, so the person can't change them: `resumableSpeeds` and `idempotentSubmit` always come from your manifest, whatever a `models.json` entry for the model says.

What the runner does with it (§6.7):

- It writes whether the call was resumable when it sends it, and stores the handle the moment `submit()` returns, before the first poll. From then on the call is only read by that id, and never sent again, since that could bill twice.
- Only the company's answer ends it: the image, a terminal failure, `content_refused`, or `notFound`. Anything else your `poll()` throws (a network error, a 429 or 5xx, a rejected key, a full disk while saving the image, an answer you couldn't parse) makes the runner read the same id again. Past the deadline it gives up after three failed reads in a row, and it never cancels a call the company didn't say was still running. So map errors carefully: throw `notFound` only when the company says the id is gone.
- Stopping (Ctrl-C, SIGTERM, a closed terminal, or `bun dev` restarting after a save) leaves resumable calls running at the company and exits without waiting for them, once their create call has returned the id. It waits for every other call to finish, so its image is saved first.
- A cancel is sent to the company with `cancel(handle)`, even when it comes in while the create call is still out (the runner waits for the id) or while the company is turned off (it goes once the company is back, after a restart too).
- At the next start, a resumable call is picked up by its id, and its tile says "Picking up where it left off". A call that couldn't resume runs again once, when the person allows it in **Settings > Defaults**, and its tile and the usage log say it may be charged twice. A resumable call cut off before its id arrived is asked for its id again with the same create and key when you declare `idempotentSubmit`; otherwise it can't be followed and is never sent again, so return from `submit()` the moment you have the id.
- A cancel that comes in while the create call is out waits for the id, which is saved on the canceled job before the cancel goes, so a cancel that doesn't get through is still sent after a restart.

Check every condition against the company's docs, and live once with your key: a speed listed as resumable that isn't loses the image at the next restart. Say what you checked in your README. Google's README records the probe that ruled out its image models. A change to `resumableSpeeds` bumps `manifestVersion`.

`packages/providers/src/testing/resumable.ts` is a complete resumable adapter with its fake, registered only in fake mode as the "Resumable test model". Use it as the model for yours.

## 9. Run batches (only for the Batch speed)

A model whose manifest offers `batch` must set `batch` on its `ImageModel`: a `BatchApi` (`packages/providers/src/types/batch.ts`). One run at the Batch speed is exactly **one** provider batch, whatever its image count. Google's is `packages/providers/src/google/batch.ts`.

- `submit(reqs, ctx)` sends every request of the run in one create call and returns a `BatchHandle`: the company's id (`remoteId`), the `displayName` you gave the batch (always `batchDisplayName(req.jobSetId)` from `@openfield/core`), `expiresAt` from the company, and anything poll, cancel and cleanup need in `resume`, as plain JSON. Key each request by its `req.jobId`, so results map back to their tiles without guessing at order.
- `poll(handle, ctx, { harvest })` reads the state once and must be safe to repeat, including after the end and on a fresh process: the server stores the handle and resumes polling after a restart. On a terminal state, return one item per job id in `harvest` and only those. Write images through `ctx.assets` only for those ids, so a harvest cut short by a restart never saves an image twice. A job with no result (expired, canceled) comes back as an error item, and so does one whose image `ctx.assets.write()` refused: catch that `ProviderError` and return it for that job, so the other images still land. The runner keeps a job waiting when the refusal was a full disk, and collects it on a later poll.
- `cancel(handle, ctx)` stops the whole batch, never one image of it. Keep reporting what finished before it stopped: those images are kept.
- `find(displayName, ctx)` is optional but strongly advised. Creating a batch is rarely idempotent, so when a create call fails or is cut off, the server looks the batch up by name before it ever sends it again. Return `null` only when the company answered and has no such batch; throw when you couldn't ask, so the server looks again later instead of giving up on a run that may be billing.
- `cleanup(handle, ctx)` is optional: delete the batch and any uploaded inputs at the company once the results are saved. The server calls it only for a run the company reported finished.

The runner does the rest: it writes the run's row before the create call, polls on its own schedule (a waiting batch holds no "Runs at once" slot, only each call while it runs), never retries a batch item on its own (that could bill twice), always asks the company before it applies the deadline (the expiry plus a grace), and tells the person when the run is done, with a toast and a system notification.

## 10. Save the images

`map-response.ts` streams every image into `ctx.assets.write()` and returns asset ids with width, height, MIME type and size. Never return base64 or data URLs. Store the bytes exactly as returned: no re-encoding and no metadata stripping, so provenance watermarks survive.

If images come as URLs, download them only from `assetHosts`, over `https:`. Return `revisedPrompt`, `usage` and safety results when the API provides them.

## 11. Map errors

`errors.ts` exports one function with one signature:

```ts
export async function mapError(res: Response, body?: unknown): Promise<ProviderError>;
// every call site: throw await mapError(res, body)
```

| The company says | `ErrorCode` |
|---|---|
| 401, bad key | `auth_invalid` |
| 403, no access to this model | `auth_forbidden` |
| No credit or payment method, or billing turned off | `billing_required` |
| Hard usage limit | `quota_exceeded` |
| 429 | `rate_limited`, with `retryAfterMs` from `Retry-After` |
| 400 about one setting | `unsupported_param` or `invalid_request`, with `field` |
| 413, image too large | `payload_too_large` |
| Output blocked by safety | `content_refused` |
| An input image rejected | `content_flagged_input` |
| 5xx | `provider_unavailable` |
| A slow speed refused for capacity | `provider_unavailable`, with `busy: true` |
| This model doesn't take the requested speed | `unsupported_param`, with `field: "speed"` |
| DNS, TLS or socket failure | `network` |
| Aborted or timed out | `timeout` |
| Anything else | `unknown` |

Only `network`, `timeout`, `rate_limited` and `provider_unavailable` are retryable. Use the shared copy for `userMessage` (§0.5) rather than writing new messages per adapter. When the company's answer means something more specific than the row above, say so: Google's free tier has no image models, so a free-tier quota of 0 means billing is off, and the tile says "Turn on billing for this key in Google AI Studio to make images." Keep the company's own code in `providerCode`: it shows in the Error log, not in the UI. Never put a key or a raw response body in an error.

## 12. Discovery

`listModels()` must return the static catalog. Network discovery is optional: when you add it, keep only ids your `recognise(id)` accepts, let static capabilities win over anything discovered, and fall back to the catalog when discovery fails. Unrecognised ids are listed in Settings as not supported and never reach the model picker.

## 13. Record fixtures

`__fixtures__/` holds recorded HTTP exchanges. Your fake (step 14) replays the error ones, and the conformance suite checks your mapping against them. Follow the format of the existing adapters. Remove keys and auth headers when you capture, and swap large images for small ones.

At minimum, record:

- a success for every operation you declare;
- a 401;
- a 429 with `Retry-After: 12`;
- a 500 or 503;
- a safety refusal;
- a model list response, if you implement discovery;
- for each speed you offer: a success at that speed, and a busy refusal for a speed that can be refused;
- for Batch: a create, a running and a finished batch, a partial one, an expired one and a canceled one.

## 14. Write the fake

The conformance suite and `OPENFIELD_FAKE_PROVIDERS=1` never touch the network. They send every call to a hand-written stand-in for the company's API, and the suite stops with "<id> has no fake in src/testing/" until yours exists.

Write `packages/providers/src/testing/acme.ts` exporting a `FakeRoute` (see `testing/types.ts`), with `testing/google.ts` as the model:

- `hosts` lists the same hosts as `meta.networkHosts`.
- `handle()` checks each request against the company's **documented** rules (ratios, sizes, limits), written out in the fake itself rather than read from your manifests. That's what catches a manifest that declares something the API doesn't take.
- For errors, it replays your fixtures, picked by a `#fake:<name>` tag in the prompt (`FAKE_SCENARIOS`). A key containing "invalid" answers like a rejected key.
- For success, it makes up a small image of the requested size (`gradientPng()` in `testing/png.ts`), in the company's response format.
- For speeds, it plays the scenarios in `FAKE_SCENARIOS`: `flex_busy` answers every other Flex call busy, so a second try gets through; `priority_standard` serves a Priority call at Standard.
- For a resumable speed, the create call answers at once with an id, and a read by id answers queued, then running, then the image a few seconds later. Encode what the call will return in its id, as `testing/resumable.ts` does, so a call sent before a server restart still answers after it.
- For Batch, it answers create, get, cancel, list and delete, and a batch finishes a few seconds after it's created. Encode what the batch will return in its id, as `testing/google-batch.ts` does, so a batch sent before a server restart still answers after it. `batch_slow` waits long enough to cancel or restart; `batch_partial`, `batch_expired` and `batch_failed` end the way their names say.

Then add it to `builtinFakes` in `packages/providers/src/testing/fake-fetch.ts`.

## 15. Pass the conformance suite

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
- only hosts in `networkHosts` and `assetHosts` are contacted;
- your settings schema obeys the rules in step 6, and its Speed field lists exactly the speeds your manifests offer;
- every speed offer is priced and sourced, each sync speed reaches the wire, and `speedUsed` follows what the company served;
- a Flex busy answer is `busy` under "keep trying" and resent once at Standard under "switch";
- a batch handle survives a JSON round trip, a harvest writes each image once, items map to their jobs, and cancel and expiry end the right way;
- a resumable speed returns an id before the image, a fresh binding and context finish the call from the stored handle with one create call in all, and an unknown id is `notFound`; a speed that isn't resumable returns only with the image in hand.

Then run it once against the real API with your key, and say so in the pull request:

```sh
OPENFIELD_CONFORMANCE=live bun test packages/providers/conformance
```

## 16. Register the adapter

Add it to `builtinProviders` in `packages/providers/src/registry.ts`. Registration is static: there is no plugin loading and no remote code.

## 17. Write the adapter README

Cover the endpoints, how auth works, the hosts, what you verified and how, known gaps, the date you checked prices and speeds, and how the fixtures were captured.

## Pull request checklist

- [ ] `bun run lint`, `bun run typecheck`, `bun test` and `bun run check:bundle` pass.
- [ ] Offline conformance passes, and you ran it live once.
- [ ] Every capability is verified, and anything unverified is left out and listed in the adapter README.
- [ ] Prices carry `pricedAt` and `sourceUrl`, or the price is `unknown`. So does every speed offer.
- [ ] Settings, if any, are data on `Provider.settings`, read from `ctx.settings` and `ctx.speed` on every call.
- [ ] A model offering Batch has a `batch` path whose handle survives a restart.
- [ ] Every speed where the company keeps working without an open connection is in `resumableSpeeds`, and `submit()` returns there as soon as the id exists. Blocking calls list nothing.
- [ ] Handles carry no key, token or signed URL.
- [ ] `idempotentSubmit` is declared only when the company documents that a repeated idempotency key returns the first request.
- [ ] Fixtures contain no keys.
- [ ] `src/testing/<name>.ts` exists and is listed in `builtinFakes`.
- [ ] All HTTP goes through `ctx.fetch`.
- [ ] Any new UI copy follows the copy rules.
