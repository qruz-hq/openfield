# Google (Nano Banana)

The Gemini API's native image models, shown under Google's own names.

| Name | Model id | Ratios | Sizes | Price per image |
|---|---|---|---|---|
| Nano Banana Pro | `gemini-3-pro-image` | auto + 10 | 1K, 2K, 4K | $0.134 (1K, 2K), $0.24 (4K) |
| Nano Banana 2 | `gemini-3.1-flash-image` | auto + 14 | 512, 1K, 2K, 4K | $0.045, $0.067, $0.101, $0.151 |
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` | auto + 10 | 1K | $0.0336 |

Checked on 2026-09-23 against Google's [models](https://ai.google.dev/gemini-api/docs/models), [image generation](https://ai.google.dev/gemini-api/docs/image-generation) and [pricing](https://ai.google.dev/gemini-api/docs/pricing) pages and the [generateContent reference](https://ai.google.dev/api/generate-content). **Not yet run against the live API**: nobody had a key when this was written. Run `OPENFIELD_CONFORMANCE=live bun test packages/providers/conformance` with a key before relying on it, and record real fixtures.

## How it talks to Google

- **Generate and edit:** `POST https://generativelanguage.googleapis.com/v1beta/models/{id}:generateContent` with `generationConfig.responseModalities: ["IMAGE"]` and `generationConfig.imageConfig { aspectRatio, imageSize }`. The prompt is the first part, then the edit base, then references, each as `inlineData { mimeType, data }`.
- **Why generateContent:** Google's guides now show the newer Interactions API, but say generateContent "remains fully supported". It's stateless (Interactions keeps history unless you opt out), and it's what the PRD specifies. Interactions wouldn't make an image survive a restart either (see Restarts).
- **Auth:** the `x-goog-api-key` header, never the `?key=` query form.
- **Hosts:** `generativelanguage.googleapis.com` only. Images arrive inline, so `assetHosts` is empty and an image URL in a response is refused.
- **Check key:** `GET /v1beta/models`, which is free. It also feeds discovery.
- **Images per run:** one call per image (fan-out). `candidateCount` exists but isn't documented for image models.
- **Cancel:** there's no provider-side cancel for a sync call. Aborting stops waiting; Google may still bill the image. A Batch run cancels at Google (below).

## Speeds

Chosen only in the company's settings (`settings.ts`, the Speed panel), never in the composer. Prices are per output image, from the [pricing page](https://ai.google.dev/gemini-api/docs/pricing) (updated 2026-09-22, checked 2026-09-23). Every image model shows "Not available" in the free tier column, so billing is required at any speed.

| Model | Standard | Batch | Flex | Priority |
|---|---|---|---|---|
| Nano Banana Pro | $0.134 (1K, 2K), $0.24 (4K) | $0.067, $0.12 | $0.067, $0.12 | $0.24192, $0.432 |
| Nano Banana 2 | $0.045, $0.067, $0.101, $0.151 | $0.022, $0.034, $0.050, $0.076 | not offered | not offered |
| Nano Banana 2 Lite | $0.0336 (1K) | $0.0168 | not offered | not offered |

- **Priority** prices are derived: Google publishes only per-token rates, exactly 1.8x Standard ($216 per 1M image output tokens × 1,120 or 2,000 tokens).
- **On the wire:** `serviceTier: "flex" | "priority"` at the top level of the generateContent body, never inside `generationConfig`. Standard leaves it out. There is no `batch` value; Batch is its own endpoint.
- **Speed served:** read from `usageMetadata.serviceTier`, then the `x-gemini-service-tier` header, then the speed asked for. Priority over its limits is served and billed at Standard without an error, so cost follows what Google reports.
- **Flex busy:** Google answers 503, or a 429 without a `QuotaFailure`, and never moves Flex up to Standard itself. The "When Flex is busy" setting (`flexBusy`) decides: `wait` raises `provider_unavailable` with `busy: true`, which the runner waits out on its own schedule; `standard` sends once more without `serviceTier` in the same attempt and reports Standard. Adapters that offer Flex name this setting `flexBusy` with the values `wait` and `standard` (conformance 25).
- **A rejected speed:** a 400 naming the service tier maps to `unsupported_param` on the `speed` field, with a reason that points at Google settings.
- **A speed the model lacks** never reaches Google: the settings resolve to Standard for that model before submit.

## Batch

`batch.ts`, on the same host and header, so nothing is added to `networkHosts`. One job set is one batch of N requests, each keyed by its job id.

| Action | Call |
|---|---|
| Submit | `POST /v1beta/models/{id}:batchGenerateContent`, `batch.displayName = "openfield-<jobSetId>"`, `batch.inputConfig.requests.requests[]` of `{request, metadata: {key: <jobId>}}`. Each request is built by the same `map-request.ts` as a sync call, without `serviceTier` |
| Poll | `GET /v1beta/batches/{id}`. State from `metadata.state` (`BATCH_STATE_*` or the SDK's `JOB_STATE_*`); results from `metadata.output`, else `response`, as `inlinedResponses.inlinedResponses[]`, or a `responsesFile` downloaded as JSONL |
| Cancel | `POST /v1beta/batches/{id}:cancel`, best effort; a batch that already finished is fine |
| Cleanup | `DELETE /v1beta/batches/{id}`, then `DELETE /v1beta/files/{id}` for uploads |
| Find | `GET /v1beta/batches`, paged, matching `metadata.displayName` |

- **Size:** an inline create must stay under 20 MB, and base64 references repeat in every request. Over about 19 MB, each distinct reference is uploaded once through the Files API (resumable upload on `/upload/v1beta/files`) and swapped for `fileData`; the uploads go on the handle for cleanup.
- **Harvest:** a terminal poll writes images only for the job ids asked for, and returns one item per job: its result, its own error (a `google.rpc.Status`, mapped like any HTTP error), or, when it has none, `timeout` for an expired batch and `canceled` for a canceled one.
- **Expiry:** the manifest's Batch `waitMs.max` (48 hours after creation), with no results.
- **The key:** a batch belongs to the key's project. A batch the current key can't read (403 or 404) comes back from `poll` as a plain `auth_forbidden`; the runner, which knows which key sent the run, decides what happens (§0.4). With a different key saved, Openfield keeps checking on the batch schedule until the deadline, then fails the run with "This run was sent with a different Google key." With the same key, the run fails at once with "Google can't find this run anymore."
- **Saving results:** an image that can't be saved on this computer comes back as that job's own error item, so the other images still land.
- **Uploads after a lost answer:** if the create call fails on the way, the batch may exist and use the uploads, so they're kept. A `find()` that hits takes them on for cleanup; a second `submit` (sent only after `find()` came back empty) deletes them first.

## Restarts

A Standard, Flex or Priority image **can't be picked up after the server stops**, so no model lists `resumableSpeeds` and the runner never stores their handles (§0.4, §6.3). `generateContent` returns the image inside the HTTP response, with no id to fetch it by later. What Openfield does instead: stopping the server waits for in-flight calls to finish (§0.12), and a call cut off by a crash or a forced stop runs again once at the next boot when "Run interrupted images again after a restart" is on, marked as maybe charged twice. **Batch is the only Google path that survives a restart**: the batch name is stored the moment the create call returns, and the watcher polls it at boot (`batch.ts`, `apps/server/src/runner/batches.ts`).

The Interactions API was the only candidate for a resumable path. A live probe with the owner's key on **2026-09-23/24** ruled it out:

- **Endpoints** (confirmed live): `POST /v1beta/interactions`, `GET /v1beta/interactions/{id}` (optional `stream=true&last_event_id=`), `POST /v1beta/interactions/{id}/cancel`, `DELETE /v1beta/interactions/{id}`, with the header `Api-Revision: 2026-05-20`. `GET /v1beta/interactions` answers 404 "Method not found": there's no list, so an orphaned id can't be found again.
- **Image requests** take `{model, input, response_format: {type: "image", mime_type: "image/jpeg", aspect_ratio, image_size}}`. Only `image/jpeg` is accepted, `delivery: "uri"` is refused ("Image delivery mode is not supported."), and `image_size` is `512`, `1K`, `2K` or `4K`, case-sensitive.
- **`background: true` is refused** with a 400, "Model '…' does not support background interactions.", for `gemini-3-pro-image`, `gemini-3.1-flash-image` and `gemini-3.1-flash-lite-image`. Background mode is the only mode in which Google keeps working after the client goes away. The background guide lists only text models and managed agents.
- **A streamed call is stored only if the client stays connected until it completes.** After a disconnect following `interaction.created`, `GET` by id stayed 404 for the 136 s it was polled (the connected twin finished about 4 s after `created`). The id also arrives together with the first output (26 to 69 s in on a queued call), not at acceptance; no event carries an event id; and `GET ?stream=true` answers 400 "Streaming retrieval of interactions is not supported for this model". Runs that end in an error are never stored.
- **Cancel** applies only to running background interactions. On a completed non-background one it answers 200 and changes nothing; on an id that was never stored, 404.
- **Speeds**: `service_tier` exists on Interactions (`flex`, `standard`, `priority`, plus an undocumented `deferred`), but the image model pages list Flex and Priority as not supported, and Batch exists only on `models/{model}:batchGenerateContent`. Stored interactions last 55 days on the paid tier and 1 day on the free tier.

The probe ran the storage and disconnect tests on free-tier text models (`gemini-3.5-flash-lite`, `gemini-3.5-flash`), because the key's project had an image quota of 0: no image was generated and nothing was billed. Those storage rules are per interaction, not per model, and image models refuse background mode before any of that applies.

If Google adds background support for an image model, that speed can move onto Interactions and into `resumableSpeeds`, with no runner change: POST with `background: true`, keep the returned `id` as the handle's `providerRef`, poll `GET /v1beta/interactions/{id}` until `status` is terminal, and read the image from `steps[type=model_output].content[type=image].data` (base64 JPEG). Map a 404 on that read to `notFoundError()`, and keep `DELETE` for cleanup.

## Verified

- The three model ids and their Nano Banana names (models page).
- Ratios and sizes per model, from the resolution tables. **Nano Banana Pro does not list 1:4, 4:1, 1:8 or 8:1**; the PRD had assumed it did. Nano Banana 2 Lite lists the standard ten and 1K only.
- `imageSize` values `512`, `1K`, `2K`, `4K` with an uppercase K; lowercase is rejected. The generateContent reference's `ImageConfig` lists `512`; the guide's "512px (0.5K)" is prose for the Interactions API. Leaving `aspectRatio` out makes the model follow the input image or make a square, which is our `auto`.
- `thinkingConfig.thinkingLevel` takes the `ThinkingLevel` enum names (`MINIMAL`, `HIGH`, …) on generateContent; the guides' lowercase `minimal` and `high` are the Interactions API's spelling. Both checked in the reference on 2026-09-23.
- Up to 14 reference images on all three.
- Every image carries a SynthID watermark, stated in `safety.notices`.
- Per-image prices at every speed on the pricing page. None of these models has a free tier.
- `serviceTier` on generateContent: a top-level field, lowercase values (generateContent reference and the JS SDK).
- The Batch API's paths, states and result shapes (batch reference and guide), and that all three image models support it.
- Thinking is always on. `thinkingLevel` (minimal or high) is documented for Nano Banana 2 and 2 Lite only; Google Search grounding for all but Lite. Both are Advanced fields.
- The finish and block reasons used for refusals (generateContent reference).

## Ambiguous or unverified

- **Output format.** The only documented image output type is JPEG (the reference's image `MimeType` enum lists `IMAGE_JPEG` alone), so the manifest says JPEG. Older models returned PNG. Bytes are stored exactly as returned either way.
- **`responseModalities: ["IMAGE"]` on its own.** The reference says the list must exactly match a combination the model supports, but doesn't list the combinations for these models. We send image only; if a live run rejects it, the fix is `["TEXT", "IMAGE"]` and dropping the text part.
- **Inline size limit.** One page caps a whole request at 20 MB, another at 100 MB. We cap each reference at 20 MB and let Google reject anything bigger (mapped to `payload_too_large`).
- **Seeds.** `generationConfig.seed` exists, but reproducible images aren't documented for these models, so the manifest declares no seed support.
- **Error bodies.** generateContent errors are standard `google.rpc.Status` bodies; Google's current error page only documents the Interactions API's snake_case codes. `mapError` reads both. A bad key on generateContent is a **400** with reason `API_KEY_INVALID`, not a 401.
- **Rate limits.** `Retry-After` isn't documented; `RetryInfo.retryDelay` in the body is. We read both, header first. A daily quota maps to `quota_exceeded`.
- **Billing off.** A 429 whose `QuotaFailure` names a `free_tier` metric with `quotaValue` `"0"` ("limit: 0") means billing is off for the key. It maps to `billing_required` with "Turn on billing for this key in Google AI Studio to make images." The shape comes from community reports, not Google's docs, so any quota of zero takes this path.
- **Flex and Priority on Nano Banana Pro.** The pricing page (2026-09-22) prices both; the model page (2026-09-03) says "Not supported", and the Flex and Priority guides list no image model. The catalog follows the pricing page. If a live run shows Google rejecting the field or quietly serving Standard, Flex and Priority come out of Pro's `speeds` (a data change).
- **Busy and canceled billing.** Google doesn't say whether a refused Flex request, or a batch request finished before a cancel, is billed.
- **Inline batch results.** No documented cap on a `GET /v1beta/batches/{id}` response carrying several 4K images inline.
- **Key shapes.** Keys start with `AIza`, or `AQ.` for the auth keys AI Studio now makes by default. Google's docs don't state the `AQ.` prefix (community sources do), so the redaction nets match it with the same URL-safe alphabet as `AIza`. The bundle scan in `scripts/check-bundle.ts` also needs a digit after the prefix and a match that doesn't follow `.` or `$`, so minified code like `AQ.getBoundingClientRect` isn't flagged; keys configured on the machine are also scanned for verbatim, whatever their shape.
- **Latency.** `typicalLatencyMs` comes from the PRD's research, not from 10 measured runs yet.

## Left out

- **Nano Banana (`gemini-2.5-flash-image`):** Google shuts it down on October 2, 2026 and already limits it to existing users. Discovery lists it as not supported.
- Masks, upscale and background removal: not offered by these models. Masked edits use Openfield's regional fallback.
- Multi-turn editing, and JSONL batch input files (Files API references cover big runs).

## Discovery

`GET /v1beta/models` doesn't say which models make images, so `recognise()` accepts only the three families, optionally followed by `-preview` and a `-MM-YYYY` snapshot date. A recognised new id borrows its family's capabilities and shows as, for example, "Nano Banana Pro (preview)", but only when the key doesn't also list the family's own id: otherwise the picker would show the same model twice. Everything else is listed in Settings as not supported.

## Fixtures

Hand-made from the documented shapes; see `__fixtures__/README.md`. The fake API is `src/testing/google.ts` (generateContent and model list), `google-batch.ts` (Batch and Files) and `google-common.ts`. In fake mode, prompt tags pick outcomes: `#fake:slow` holds a generateContent call open for about 30 seconds, long enough to stop or kill the server mid-call and see it finish or run again, `#fake:flex_busy` answers every other Flex call busy (with `Retry-After: 2`, so fake runs stay quick), `#fake:priority_standard` serves Priority at Standard, and a batch finishes in a few seconds unless tagged `#fake:batch_slow` (about 30 seconds, long enough to cancel or restart the server), `#fake:batch_partial`, `#fake:batch_expired` or `#fake:batch_failed`. A fake batch id carries its own plan, so it still answers after a server restart.
