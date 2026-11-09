# BytePlus adapter (Seedance video, Seedream images)

BytePlus ModelArk's video and image generation APIs, with the person's own key and billing. The Seedance half (this part, down to Fixtures) is Openfield's first **video** company; the Seedream half (see [Seedream images](#seedream-images)) makes images. For Seedance, every model here has `modality: "video"` and a `capabilities.video` block, and makes one MP4 per run. **Nothing has run live yet.** Everything below comes from BytePlus's API reference as of 2026-09-29, extracted from the pages' own content (not from memory), and every place that still needs a live run says so. `meta.stable` is `true` so the models show without Settings > Experimental; flip it to `false` if the first live run finds a surprise.

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

## Seedream images

Five image models on the same key, read from BytePlus's docs on 2026-11-09 (sections expanded, official pages only). **Nothing here has run live yet**: every value is from these pages, and the list at the end says what a first live run has to confirm.

Sources:

- Model list: <https://docs.byteplus.com/en/docs/modelark/model-list>
- Image generation API: <https://docs.byteplus.com/en/docs/modelark/image-generation-api>
- Image generation tutorial (size tables, capability table): <https://docs.byteplus.com/en/docs/modelark/image-generation-tutorial>
- Seedream 5.0 pro / flash tutorial (layers, sketch edits): <https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro>
- Seedream 5.0 pro / flash interactive editing guide (`<point>`, `<bbox>`): <https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro-editing-guide>
- Pricing: <https://docs.byteplus.com/en/docs/modelark/model-pricing>
- Error codes: <https://docs.byteplus.com/en/docs/modelark/error-codes>

### Endpoint

`POST /images/generations` on the same base and key. It's **synchronous**: the call blocks until the images exist and answers them inline, with no id to read them by later. So nothing resumes after a restart; a call cut off runs again (`seedream-model.ts`). Every body asks for `response_format: "b64_json"`, so there's no download host to allow (the URL form lasts 24 hours on a host the docs don't name), and `watermark: false`, which BytePlus defaults to on.

### Models

| Model | Id | Tiers | Inputs | Formats | Related sets | Fast | Marks and layers |
|---|---|---|---|---|---|---|---|
| Seedream 5.0 Pro | `dola-seedream-5-0-pro-260628` | 1K, 1.5K, 2K | 10 | PNG, JPEG | no | yes | yes, and transparent backgrounds |
| Seedream 5.0 Flash | `dola-seedream-5-0-flash-260915` | 1K, 1.5K, 2K | 10 | PNG, JPEG | no | no | yes, and transparent backgrounds |
| Seedream 5.0 Lite | `seedream-5-0-260128` (also `seedream-5-0-lite-260128`) | 2K, 3K, 4K | 14 | PNG, JPEG | yes | no | no |
| Seedream 4.5 | `seedream-4-5-251128` | 2K, 4K | 14 | JPEG only | yes | no | no |
| Seedream 4.0 | `seedream-4-0-250828` | 1K, 2K, 4K | 14 | JPEG only | yes | yes | no |

- Region: everything here is on ap-southeast-1, the base Openfield calls. Pro and Flash are only there; Lite is also on eu-west-1, which Openfield doesn't use. Keys and model activation are kept apart per region at BytePlus.
- SeedEdit 3.0 (`seededit-3-0-i2i-250628`) is on the pricing page only, not on the model list or the API page, so it's left out.
- Prompts: the API page asks for at most 600 English words (300 Chinese characters). Pro and Flash also read 14 more languages.
- Seedance stays first in the catalog: `catalog()[0]` is what the conformance suite takes as the company's sample model.
- Fields a model doesn't list are **never sent** (4.5 and 4.0 get no `output_format`, Pro and Flash no `sequential_image_generation` or `stream`, Flash no fast mode): whether BytePlus ignores or refuses them isn't documented. The fake (`src/testing/byteplus-images.ts`) refuses them, so the conformance suite catches a manifest that offers too much.
- Sizes: `seedream.ts` holds each tier's exact WxH per ratio (the tutorial's tables), sent as `"WxH"`. `auto` sends the tier alone and lets the model pick the shape (the docs' Method 1). Exact sizes are checked against each model's pixel range and the 1:16 ratio limit.
- Inputs: PNG, JPEG or WebP data URLs, under 30 MB, sides over 14 px, at most 36 million pixels, within 1:16. The edited image goes first (Image 1), then the references in order.
- No seed (it isn't a parameter of this API). A negative prompt is folded into the prompt by Openfield.
- **Fast** is BytePlus's fast prompt optimizer (`optimize_prompt_options.mode: "fast"`). Openfield has no speed id for it, so it rides on the Priority id, labelled "Fast" in the company's Speed setting, at the Standard price (the pricing page charges nothing for it). The docs list it on Pro and 4.0 only. The id is stored as `priority` on job sets and usage rows, but people and agents only ever see "Fast": every surface names a speed through `speedLabel` or `speedName` (the model's offer label, then the company's Speed option), and the canvas's stock Priority note ("Costs more") is skipped when the company names the speed itself.
- **Related sets** (Lite, 4.5, 4.0): by default a count of 4 is four calls of one image, so a moderated image fails on its own. Turning on Related set in the composer's Images chip (`providerOptions.relatedSet`, from a count of 2) sends one call with `sequential_image_generation: "auto"` and `max_images` up to the count, within "inputs plus outputs at most 15". The model may make fewer: those images fail one by one with "made fewer images than you asked for", and the estimate is a range from one image to the count. A moderated image in a set comes back as `data[].error`, and only that image fails.
- **Transparent backgrounds** (Pro, Flash): only an edit of exactly one PNG with an alpha channel, sent with `background: "transparent"` and PNG out. Anything else is refused before it's sent.

### Marks (Pro, Flash)

There's no mask or sketch parameter: everything goes in the image and the prompt (`marks.ts`, pure).

- A point becomes `<point>x y</point>` and a box `<bbox>x1 y1 x2 y2</bbox>`, after "Image n", on the editing grid: integers 0 to 999 from the top left, `round(fraction × 1000)` held at 999 (the docs' formula can reach 1000). This is **not** the layer grid below, which runs to 1000; `@openfield/core`'s `image/grid.ts` keeps the two apart.
- Circles, strokes and arrows have no tag. They're drawn onto a copy of the image they're on, each in its own ink (red, blue, green, ...), turned upright first, for that call only (`AssetSink.drawMarks`, sharp on the server). The prompt names each by its ink and adds "Remove every drawn mark from the result."
- A mark's note, colour (hex, with the nearest colour word) and material go next to it in words: the API has no field for them.
- Marks add to the prompt: 20 marks with long notes can pass the 600-word guidance. Nothing trims them.
- A masked edit still works (it's a whole-image edit, then the composite puts the original back outside the mask), but with marks the composite is off by default, since marks don't say where the edit ends.

### Layers (Pro, Flash)

A separation (`op: "decompose"`) sends one PNG or JPEG of at least 512×512 pixels with `layer_decomposition: true` and a resolution level (`auto`, 1K, 1.5K, 2K; `auto` keeps the image's size within the model's range). It answers a base (`z_index` 0, the whole canvas) and up to 16 layers, each a **cropped** PNG with its own `bounding_box` (`absolute` pixels on the base, and `normalized` 0 to 1000), a `name` and a `description`. If any layer fails, the whole call fails ("Partial success is not supported").

Every image of a separation is a library image derived from the image separated. The base is the job's own image; each layer is filed beside it in the same transaction, and `opParams.layer` records its role, `zIndex`, the canvas size, its box in pixels (from `absolute`, falling back to `normalized`), its box on the 0 to 1000 grid, its name and its description. One usage row carries the whole call. The server reads a stack back by its run id, flattens it into one image (op `overlay`, made locally, free) and exports it as a zip of PNGs with `stack.json` or as a PSD.

### Cost

`price.kind: "per_image"`, from the pricing page on 2026-11-09. Every image is billed at the rate for its own pixel count, and only images that came back are billed. Results are `reconciled` from `usage.generated_images` and each image's `data[].size`.

| Model | Each image | Input images |
|---|---|---|
| Seedream 5.0 Pro | $0.045 up to 2.61 million pixels (1K, 1.5K), $0.09 above (2K). Layers: $0.0225 and $0.045 on the same line | first free, then $0.003 each |
| Seedream 5.0 Flash | $0.018 (layers assumed the same) | free |
| Seedream 5.0 Lite | $0.035 | free |
| Seedream 4.5 | $0.04 | free |
| Seedream 4.0 | $0.03 | free |

A separation's estimate runs from a base and one layer to a base and 16 (17 images): at Pro 2K that's $0.09 to $0.765.

### Errors

The same envelope and table as Seedance. The ones to expect here: `ModelNotOpen` and `OperationDenied.ServiceNotOpen` ("Turn on {model} in BytePlus first"), `ModelAccountIpmRateLimitExceeded` (429, 500 images a minute per model; a separation reserves 17) as `rate_limited`, `QuotaExceeded` (a used-up free trial) as `quota_exceeded`, `OutputImageSensitiveContentDetected` as `content_refused`. A separation that fails on BytePlus's side says "couldn't separate this image into layers".

### Unconfirmed until a live run

- Whether a field a model doesn't list (`output_format` on 4.5, fast mode on Flash, `stream: false` on Pro) is an error or ignored. The adapter never sends them either way.
- Pro and Flash's size when none is sent (the API page says 2K, the tutorial's table 1024×1024). Openfield always sends one.
- Whether `b64_json` works for layers (the docs only show URLs there).
- Flash's price for a separation (one flat rate, no layer row), and whether Pro's base in a separation bills at the layer rate. Both are assumed so.
- Whether `watermark: false` reaches every layer, and whether a separation takes `<point>` as well as `<bbox>`.
- What a `<point>` or `<bbox>` value of 1000 does (Openfield never sends one), and what a prompt past 600 words does (many marks with long notes can get there).
- Whether BytePlus reads EXIF orientation. Openfield sends every marked image upright either way, so the marks land where they were placed.
- Whether a fresh account has a free quota per model (`QuotaExceeded` suggests so), and whether Pro and Flash need turning on in the console by hand.
- `limits.typicalLatencyMs` is a placeholder. `maxConcurrent` is 4 per model, and the scheduler counts runs at once per company, so Seedance and Seedream share BytePlus's slots.

## Fixtures

`__fixtures__/` is hand-made from the docs, not recorded: see its README.
