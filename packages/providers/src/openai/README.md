# OpenAI (GPT Image)

OpenAI's Image API, with its current image models under their own names.

| Name | Model id | Ratios | Sizes | Quality | Batch |
|---|---|---|---|---|---|
| GPT Image 2.5 Sunburst | `gpt-image-2.5-sunburst` | auto + 12 | 1K, 1.5K, 2K, 4K | low, medium, high, xhigh, max, auto | no |
| GPT Image 2.5 Flare | `gpt-image-2.5-flare` | auto + 12 | 1K, 1.5K, 2K, 4K | low, medium, high, xhigh, max, auto | no |
| GPT Image 2 | `gpt-image-2` | auto + 12 | 1K, 1.5K, 2K, 4K | low, medium, high, auto | yes |

Checked on 2026-09-27 against OpenAI's [models](https://developers.openai.com/api/docs/models/all), each model's page, the [image generation guide](https://developers.openai.com/api/docs/guides/image-generation), the Image API reference, the [pricing page](https://developers.openai.com/api/docs/pricing), the [batch guide](https://developers.openai.com/api/docs/guides/batch) and the error code and rate limit guides, plus the official `openai-node` SDK where the docs are thin. **Not yet run against the live API**: nobody had a key when this was written. Run `OPENFIELD_CONFORMANCE=live bun test packages/providers/conformance` with `OPENFIELD_OPENAI_API_KEY` set before relying on it, and record real fixtures.

The older image models (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `chatgpt-image-latest`) are deprecated and shut down by December 1, 2026, so they're left out of the catalog. Discovery doesn't recognise them either.

## How it talks to OpenAI

- **Generate:** `POST https://api.openai.com/v1/images/generations`, JSON: `model`, `prompt`, `n`, `size`, and `quality`, `background`, `output_format`, `output_compression` and `moderation` when set.
- **Edit, inpaint, or a generation with references:** `POST /v1/images/edits`, multipart: the same fields as form values, then `image[]` (the edit base first, then references, up to 16 in all) and `mask` for an inpaint.
- **Answers:** GPT Image models always answer with `data[].b64_json`, so `assetHosts` is empty and an image URL in a response is refused. `response_format` is never sent (it's for DALL·E). `revised_prompt` is kept when a model sends one.
- **Auth:** `Authorization: Bearer <key>`. The optional `OpenAI-Organization` and `OpenAI-Project` headers aren't sent: a project key already names its project.
- **Hosts:** `api.openai.com` only.
- **Check key:** `GET /v1/models`, which is free. It also feeds discovery.
- **Images per run:** native. `n` goes up to 10 and OpenAI returns exactly `n` images or an error; the composer caps a run at 4.
- **Cancel:** there's no provider-side cancel for a sync call. Aborting stops waiting; OpenAI may still bill the image. A Batch run cancels at OpenAI (below).
- **Seeds:** there is no seed parameter anywhere in the reference, the guide or the SDK, so the Seed chip is disabled.
- **Avoid:** no negative prompt field, so core appends an "Avoid: …" sentence (emulated).
- **Unsupported settings:** `reject`, as the PRD specifies. The composer only offers each model's own values, so this only stops a request built elsewhere.

## Sizes

The composer's ratio and resolution tier become one custom `WxH`, the form `gpt-image-2` and the 2.5 models take. OpenAI's rules for it: both edges multiples of 16, the long edge at most 3840, at most 3:1, and between 655,360 and 8,294,400 pixels. Above 2560×1440 OpenAI calls a size experimental.

`openAiSize(ratio, tier)` makes the tier the long edge and the ratio the short one, snapped to 16. A shape too small for the pixel floor grows to clear it (16:9 at 1K is 1088×608, not 1024×576), and one too big for the ceiling shrinks to fit (1:1 at 4K is 2880×2880). "auto" sends `size: "auto"`. A unit test checks every ratio at every tier against the rules.

**4K is experimental at OpenAI.** It was chosen on purpose; expect slower runs and more failures there.

## Quality

The wire ids are OpenAI's. Labels and hints are ours, from the design.

| Id | Label | Hint | Models |
|---|---|---|---|
| `low` | Low | Fastest and cheapest | all |
| `medium` | Medium | Balanced | all (default) |
| `high` | High | Sharpest detail | all |
| `xhigh` | Extra high | Finer detail, costs more | 2.5 only |
| `max` | Max | Best quality | 2.5 only |
| `auto` | Auto | Let the model choose | all |

## Prices

Per 1M tokens, from the [pricing page](https://developers.openai.com/api/docs/pricing) (checked 2026-09-27): text input $5, image input $8, image output $30 on all three models. Batch, offered on `gpt-image-2` only, is half of each: $2.50, $4, $15. Cached input rates apply only to the Responses API's image tool, never to `/v1/images`, so none is declared.

- **Before a run:** OpenAI publishes no per-image price, so the estimate reads output tokens from a table (`pricing.ts`) built with OpenAI's own token calculator for exactly the size each ratio and tier sends. Rows are keyed `"3:4@1K"`, the key `estimate()` looks up for an aspect-mode request; "auto" sizes and the "auto" quality show a range. The formula (a base per quality, the long side at the base, the short side scaled by the shape and rounded half to even, times the pixel count) reproduces the guide's published GPT Image 2 prices exactly.
- **After a run:** the response's `usage` block (text and image input tokens, image output tokens) prices the run at the speed that served it, marked reconciled. OpenAI bills cached input without reporting it, so a reconciled figure can be slightly high when a prompt was cached.

## Speeds

Chosen only in the company's settings (`settings.ts`, the Speed panel): Standard and Batch. The Image API has no `service_tier`; OpenAI's Flex and Priority cover the Responses and Chat Completions APIs only.

## Batch

`batch.ts`, on the same host and header. One job set is one batch; each image is its own line with `n: 1`, keyed by its job id (`custom_id`), so each tile fails on its own.

| Action | Call |
|---|---|
| Submit | Upload one JSONL file (`POST /v1/files`, `purpose=batch`), then `POST /v1/batches {input_file_id, endpoint, completion_window: "24h", metadata: {openfield_job_set: "openfield-<jobSetId>"}}` |
| Poll | `GET /v1/batches/{id}`. `validating` is queued; `in_progress`, `finalizing` and `cancelling` are running; `completed`, `failed`, `expired` and `cancelled` end it. Results come from `output_file_id` and `error_file_id` (`GET /v1/files/{id}/content`), matched on `custom_id`, because line order isn't kept |
| Cancel | `POST /v1/batches/{id}/cancel`, best effort. `cancelling` can last up to 10 minutes |
| Cleanup | OpenAI has no batch delete, so the input, output and error files are deleted |
| Find | `GET /v1/batches`, paged, matching the metadata |

- **Window:** `24h` is the only one. Lines still unfinished then come back as `batch_expired` (mapped to `timeout`); finished ones are billed and kept.
- **Limits:** 50,000 lines or 200 MB per file, one model per file.
- **References at Batch:** a JSONL line can't carry a multipart upload, so a generation with references goes to `/v1/images/edits` in its documented JSON form, `images: [{image_url: <data URL>}]`. The batch guide lists `/v1/images/edits` as a batch endpoint, but nobody has run this form live yet. **Edits and inpaints never run at Batch**: the offer is declared for generations only (`ops: ["generate"]`), so they run at Standard with the usual note.
- **Lost create answers:** the uploaded file is kept in memory under the run's display name; `find()` takes it on for cleanup, and a second submit deletes it first.

## Restarts

`/v1/images/*` answers in one blocking call with the images inline and keeps no id to fetch them by later, so no speed is listed in `resumableSpeeds`: a call cut off by a restart can only run again, once, when the person allows it (§0.4). A Batch run always resumes from its stored handle.

The Responses API's background mode could resume by id, and its image tool takes all three models. It isn't used yet because the docs don't say that `background: true` works with the `image_generation` tool, and a background response is kept on disk for only about 10 minutes for polling, less than a long restart can take. Both need a live check first.

## Errors

| OpenAI says | Openfield code |
|---|---|
| 401, `invalid_api_key` | `auth_invalid` |
| 403, organization not verified | `auth_forbidden`, "Verify your organization with OpenAI to use this model." |
| 403, anything else | `auth_forbidden` |
| 429 `insufficient_quota` or `credit_balance_exhausted` | `billing_required` |
| 429 spend or usage limit (`*_spend_limit_exceeded`, `organization_usage_limit_exceeded`) | `quota_exceeded` |
| 429, anything else | `rate_limited`, retry after `Retry-After` |
| 400 `moderation_blocked` (input or output) | `content_refused` |
| 400 naming a `param` we send | `unsupported_param`, with the matching field |
| 400, anything else | `invalid_request` |
| 413, or "too large" | `payload_too_large` |
| 5xx | `provider_unavailable`, retryable, honouring `Retry-After` |

A key OpenAI echoes back in a message (`sk-proj-****…`) is replaced before it's stored.

## Still unverified

- The exact 403 text for organization verification (it comes from community reports; any 403 mentioning verification gets the verify message).
- Whether `usage` comes back for every model: the schema text still says "gpt-image-1 only", but the reference examples show it for `gpt-image-2.5-flare`. Without it, a run is priced from the estimate.
- The JSON form of `/v1/images/edits` inside a batch (above).
- `input_fidelity` on the 2.5 models. It's never sent: `gpt-image-2` doesn't allow it.
- Streaming and partial images: each model page says streaming isn't supported, while the reference shows streaming examples. Not declared until a live check settles it.
- The organization id and project headers: not needed with a project key; add a setting if someone needs them.
- Outpaint (the PRD's padded canvas plus a synthesised mask) isn't built yet.
- `limits.typicalLatencyMs` is the PRD's research figure, not 10 measured runs.

## Fixtures

Hand-made from OpenAI's documented shapes, not recorded. See [`__fixtures__/README.md`](__fixtures__/README.md). The fake API is `src/testing/openai.ts` (images and models) and `src/testing/openai-batch.ts` (files and batches).
