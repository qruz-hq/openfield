# BytePlus adapter (Seedance video)

BytePlus ModelArk's video generation API, with the person's own key and billing. It's Openfield's first **video** company: every model here has `modality: "video"` and a `capabilities.video` block, and makes one MP4 per run. **Nothing has run live yet.** Everything below comes from BytePlus's API reference as of 2026-09-29, extracted from the pages' own content (not from memory), and every place that still needs a live run says so. `meta.stable` is `true` so the models show without Settings > Experimental; flip it to `false` if the first live run finds a surprise.

Sources:

- Create a video generation task: <https://docs.byteplus.com/en/docs/ModelArk/1520757>
- Retrieve a video generation task: <https://docs.byteplus.com/en/docs/ModelArk/1521309>
- Pricing: <https://docs.byteplus.com/en/docs/ModelArk/1099320>
- Model list (limits, formats): <https://docs.byteplus.com/en/docs/ModelArk/1330310>
- Error codes: <https://docs.byteplus.com/en/docs/ModelArk/1299023>

Openfield ships no BytePlus name, logo or colour as its own (§1.11). The name appears only as this company's id and display name, the model names are BytePlus's own, and the BytePlus mark (design file node TZAlX) marks only its key card and its models.

## Endpoints

Base `https://ark.ap-southeast.bytepluses.com/api/v3`, `Authorization: Bearer <API key>`.

| What | Call |
|---|---|
| Make a video | `POST /contents/generations/tasks` with `{model, content, resolution, ratio, duration, …}`. Answers `{"id": "cgt-…"}` at once |
| Read a task | `GET /contents/generations/tasks/{id}`: `queued`, `running`, `succeeded` (with `content.video_url`, `content.last_frame_url`, `usage.completion_tokens`), `failed` (with `error`), `cancelled`, `expired`. Tasks are kept 7 days |
| Cancel | `DELETE /contents/generations/tasks/{id}`: only while `queued` |
| Check a key | `GET /contents/generations/tasks?page_num=1&page_size=1`: free and authenticated. There's no model list for video, so this is also what `listModels()` calls |

**Auth.** One credential field, `apiKey`, from `OPENFIELD_BYTEPLUS_API_KEY` or `ARK_API_KEY` (what BytePlus's own SDKs read). Keys come from the ModelArk console's API key page.

**Hosts.** `networkHosts: ["ark.ap-southeast.bytepluses.com"]`. Finished videos come from BytePlus's object storage (TOS) in the same region, as signed URLs valid for 24 hours. The docs show TOS URLs on `*.tos-ap-southeast-1.bytepluses.com` (their own sample media is on `ark-doc.tos-ap-southeast-1.bytepluses.com`) but don't name the bucket generated videos land in, so `assetHosts` is the pattern `*.tos-ap-southeast-1.bytepluses.com`: **exactly one label** under that BytePlus-owned domain, matched by `hostAllowed()` in `@openfield/core` both here and in the server's fetch. Not the parent itself, not two labels deep, and nothing on any other domain. A download from anywhere else is refused before it's fetched, ends the run at once, and the error in the log names the host. Downloads carry no key (the URL is signed), and only the scheme, host and path are kept in the library and the log.

## Models

| Model | Id (ours and the wire's) | Resolutions | Seconds | Sound | End frame | Seed, still camera |
|---|---|---|---|---|---|---|
| Seedance 2.5 | `dreamina-seedance-2-5-260628` | 480p, 720p, 1080p | 4 to 30 | yes | yes | no |
| Seedance 2.0 | `dreamina-seedance-2-0-260128` | 480p, 720p, 1080p, 4k | 4 to 15 | yes | yes | no |
| Seedance 2.0 Fast | `dreamina-seedance-2-0-fast-260128` | 480p, 720p | 4 to 15 | yes | yes | no |
| Seedance 2.0 Mini | `dreamina-seedance-2-0-mini-260615` | 480p, 720p | 4 to 15 | yes | yes | no |
| Seedance 1.5 Pro | `seedance-1-5-pro-251215` | 480p, 720p, 1080p | 4 to 12 | yes | yes | yes |
| Seedance 1.0 Pro | `seedance-1-0-pro-250528` | 480p, 720p, 1080p | 2 to 12 | no | yes | yes |
| Seedance 1.0 Pro Fast | `seedance-1-0-pro-fast-251015` | 480p, 720p, 1080p | 2 to 12 | no | no | yes |

- Every model takes a start frame (`first_frame`). Two frames go as `first_frame` then `last_frame`, roles required.
- Ratios: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 and `auto` (the wire's `adaptive`). Seedance 2.5 takes only `adaptive` with a start frame, so normalize() turns the ratio to `auto` whenever one is given. The 1.0 models don't take `adaptive` for text to video, so `auto` without a start frame falls back to 16:9 with a warning. Our default is 16:9 everywhere, so a price is exact before anything is chosen.
- Durations are whole seconds only. The API's `-1` (the model picks) and `frames` (fractional seconds on 1.0) aren't offered yet; the default is 5 s everywhere (2.5's own default is `-1`).
- `generate_audio` is sent only where the model has it, defaulting on as the API does. `seed` (folded into `[0, 2147483647]`) and `camera_fixed` only on the 1.x models. `watermark` is always `false`. `return_last_frame` is always `true`: the last frame is the poster when the server can't take the first frame itself (no ffmpeg).
- One video per run (`batch.max: 1`): each is its own task, billed on its own.
- `execution_expires_after` is Openfield's own video deadline, 2 hours (`VIDEO_JOB_DEADLINE_MS`; BytePlus's default is 48 hours), so a task Openfield stopped waiting for is dropped at BytePlus instead of made and billed later. A person who raises `OPENFIELD_VIDEO_DEADLINE_MINUTES` still gets BytePlus's expiry at 2 hours; raise both together.
- Seedance 2.5 at 1080p and 2.0 at 4K come as 10-bit HEVC, which some browsers can't play. Those two models carry the notice in `capabilities.safety.notices`.
- Seedance 1.5 Pro is listed as retired at BytePlus (replacement: 2.0 Mini) but still answers, so it carries the `legacy` badge.
- 2.0 and 2.5 need activating in the console before a key can use them (a balance over $30 or a resource pack). Until then a create answers `ModelNotOpen`, which the tile shows as "Turn on Seedance 2.0 in BytePlus first, then try again."
- Frames are checked before anything is sent, against the documented limits: jpeg, png or webp, under 30 MB, 300 to 6000 px a side, width over height between 0.4 and 2.5. They go as `data:` URLs.
- Out of scope for now: reference images (the omni mode), video and audio inputs, draft mode, `priority`, `service_tier: flex`, callbacks (a local app has no public address).

Exact output sizes per resolution and ratio are in `capabilities.ts` (`SIZE_TABLES`), straight from the "Width and height pixel values" table. 2.0 and 1.5 Pro share a column; 2.5 differs at 480p only; 1.0 differs throughout.

## Cost

`price.kind: "video_tokens"`, USD per million output tokens, from the pricing page on 2026-09-29. Tokens are `width × height × 24 × seconds / 1024` of the output (the docs' own formula, input video seconds being 0 here). The estimate uses the exact size table, so it's exact for a chosen ratio and a range over the ratios for `auto`; confidence is `estimated` because BytePlus bills the tokens it reports. On success the adapter reports `usage.completion_tokens` as `outputVideoTokens`, prices them at the model's rate and returns them as a `reconciled` cost, which Spending records. Only a successful video is billed, so a failed, expired or refused task costs nothing.

| Model | Rate per 1M tokens |
|---|---|
| Seedance 2.5 | 10.70 (480p, 720p), 11.70 (1080p) |
| Seedance 2.0 | 7.00 (480p, 720p), 7.70 (1080p), 4.00 (4k) |
| Seedance 2.0 Fast | 5.60 |
| Seedance 2.0 Mini | 3.50 |
| Seedance 1.5 Pro | 2.40 with sound, 1.20 without |
| Seedance 1.0 Pro | 2.50 |
| Seedance 1.0 Pro Fast | 1.00 |

Checked against the docs' examples: 1.0 Pro at 720p 16:9 for 5 s is 102,960 tokens, about $0.26; 480p for 5 s is 48,600 tokens. Not applied: the limited promotions on 2.0 Fast (25% off) and 2.0 Mini (60% off) for enterprise accounts to 2026-10-07, and the minimum token rules that apply only when a video is sent in.

## Restarts and cancels

It's a queue, so `resumableSpeeds: ["standard"]`: `submit()` returns the moment the task id exists, the runner stores the handle before the first read, and after a restart it reads the same id again. The handle holds only the id, the output's position, when it was sent, and the resolution and sound it was sent with (to price the result in a fresh process). A 404 on a read is `notFound`: the task is gone (kept 7 days) and never sent again. There's no idempotency key, so `idempotentSubmit` is left out.

Reads come every 5 seconds for the first minute, then every 10, then every 20 after five minutes.

Cancel works only while a task is queued, and then nothing is billed. Once it runs, BytePlus refuses the delete; `cancel()` logs that and returns, so the runner stops following the task as it does for any sent call, and the tile says the person may still be charged. The run's own words for that are `errors.videoStarted` in the catalogue.

## Errors

Every error body is `{"error": {"code", "message"}}`, and a failed task carries the same pair. The code decides:

| BytePlus | Openfield |
|---|---|
| `AuthenticationError`, 401 | `auth_invalid` |
| `ModelNotOpen` (404), `OperationDenied.ServiceNotOpen`, any other 403 | `auth_forbidden`, "Turn on {model} in BytePlus first, then try again." |
| `InvalidEndpointOrModel.*` | `auth_forbidden`, "Your key can't use {model}." |
| `AccountOverdueError` | `billing_required` |
| `QuotaExceeded` (5-hour, weekly or monthly quota) | `quota_exceeded`, not retried |
| `SetLimitExceeded` (Safe Experience Mode paused the model) | `quota_exceeded`, not retried: only the person can lift it |
| `RateLimitExceeded.*`, `*RateLimitExceeded`, other 429s | `rate_limited`, `Retry-After` or 12 s |
| `ServerOverloaded` | `provider_unavailable`, retried |
| `InvalidParameter*`, 400 | `invalid_request`, with the control it names (`duration` is `video.seconds`) |
| `Input{Image,Video,Audio}SensitiveContentDetected*` | `content_flagged_input` |
| `InputText…` and `Output…SensitiveContentDetected*` | `content_refused` |
| `InternalServiceError`, 5xx | `provider_unavailable` |
| task `expired` | `timeout` |

`QuotaExceeded` and `SetLimitExceeded` are 429s, but retrying can't help either, so they're `quota_exceeded` rather than `rate_limited`.

## Unconfirmed until a live run

- The storage host of generated videos (see Hosts), and whether a 2.5 URL's 100-download limit matters for anything but retries.
- The exact status and code a running task's DELETE answers (the fixture guesses 409 `InvalidParameter.TaskStatus`); anything that isn't retryable ends the cancel quietly, so the guess doesn't change behaviour.
- Which code a not-yet-activated 2.x model answers with on this endpoint: the error page lists both `ModelNotOpen` (404) and `OperationDenied.ServiceNotOpen` (403), and both give the same tile.
- `limits.typicalLatencyMs` is a placeholder, not 10 measured runs. `maxConcurrent` is the model list's individual-account figure (3 on 2.x, 10 on 1.x).

## Fixtures

`__fixtures__/` is hand-made from the docs, not recorded: see its README.
