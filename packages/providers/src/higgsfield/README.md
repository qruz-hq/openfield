# Higgsfield adapter

Higgsfield's documented public API (§6.15), with the person's own key and billing. **Experimental**: nobody has run it against the real API yet, so `meta.stable` is `false`: its key card and models show only with Settings > Experimental > Show early models on, its models are never picked as a default, and the daily model check leaves it alone while it's hidden. Everything below comes from Higgsfield's docs as of 2026-09-27 (model catalog dated 2026-09-22), and every place that still needs a live run says so.

Openfield ships no Higgsfield name, logo or colour as its own (§1.11). The name appears only as this company's id and display name, the model names are Higgsfield's own, and Higgsfield's logo (from the design file) marks only its key card and its models, as Google's and OpenAI's do.

## Endpoints

| What | Call |
|---|---|
| Make an image | `POST https://api.higgsfield.ai/<workflow path>` with the workflow's JSON body. Answers `{status: "queued", request_id, status_url, cancel_url}` |
| Read a request | `GET /requests/{request_id}/status`: `queued`, `in_progress`, `completed` (with `images: [{url}]`), `failed` (with `error`), `nsfw`, `canceled` |
| Cancel | `POST /requests/{request_id}/cancel`: 202 while queued (and refunded); 400 once it has started |
| Check a key | `GET /v1/text2image/soul-styles`: free and authenticated. There's no model list endpoint, so this is also what `listModels()` calls |
| Estimate | `POST /estimate/<workflow path>` with the same body: `{"credits": "1.500", "usd": "0.094"}` |

**Auth.** `Authorization: Key <key>`, where the key is pasted exactly as the console gives it (Higgsfield's Python client sends it the same way; the JS client splits it into `id:secret`). One credential field, `apiKey`, from `OPENFIELD_HIGGSFIELD_API_KEY`. Not `HF_KEY`, which Higgsfield's clients read: `HF_` is Hugging Face's prefix, and a Hugging Face token must never be sent to Higgsfield. Keys come from [open.higgsfield.ai/api-keys](https://open.higgsfield.ai/api-keys).

**Hosts.** `networkHosts: ["api.higgsfield.ai"]`, `assetHosts: ["cdn.higgsfield.ai"]`. **The image host is unconfirmed.** The docs only ever show `cdn.example.com`; `cdn.higgsfield.ai` is the PRD's research. A download from any other host is refused before it's fetched, and the error in the log names the host (`The image came from https://… which isn't a declared Higgsfield image host`). The first live run will show the real host: add it to `ASSET_HOSTS` in `capabilities.ts`. Images are downloaded without the key, and only the scheme, host and path are kept (a signed query string never reaches the library or the log).

## Restarts

It's a queue, so `resumableSpeeds: ["standard"]`: `submit()` returns the moment `request_id` exists, and after a restart the runner reads the same id again. The handle holds only the id and the image's position; status and cancel URLs are rebuilt from the id. A 404 on a status read is `notFound`.

Higgsfield documents **no idempotency key** and asks clients not to repeat a create after an ambiguous timeout, so `idempotentSubmit` is left out: a create whose answer is lost ends with Try again rather than being sent twice.

Cancel works only before a request starts. After that Higgsfield answers 400, which `cancel()` treats as "nothing more to stop" (it logs it and returns), so the runner doesn't keep trying. The request runs to the end and is charged.

## Models

Every text-to-image workflow in the public catalog:

| Model | Our id | Workflow path |
|---|---|---|
| SOUL | `soul` | `higgsfield-ai/soul/standard` |
| SOUL V2 | `soul-v2` | `higgsfield-ai/soul/v2/standard` |
| SOUL Cinema | `soul-cinema` | `higgsfield-ai/soul/cinema` |
| Marketing Studio Image 2.0 Alpha | `marketing-studio-image` | `marketing-studio/image` |
| Marketing Studio Image 2.5 Flare | `marketing-studio-image-2.5-flare` | `marketing-studio/image/flare` |
| Marketing Studio Image 2.5 Sunburst | `marketing-studio-image-2.5-sunburst` | `marketing-studio/image/sunburst` |
| Grok Image 2.0 | `grok-imagine-image-2.0` | `xai/grok-imagine-image-2.0` |
| Recraft V4.1 | `recraft-v4.1` | `recraft/v4.1/text-to-image` |
| Recraft V4.1 Utility | `recraft-v4.1-utility` | `recraft/v4.1/utility/text-to-image` |
| Recraft V4.1 Pro | `recraft-v4.1-pro` | `recraft/v4.1/pro/text-to-image` |
| Recraft V4.1 Utility Pro | `recraft-v4.1-utility-pro` | `recraft/v4.1/utility/pro/text-to-image` |
| Qwen Image 3 | `qwen-image-3` | `alibaba/qwen-image-3/text-to-image` |
| Ideogram 4.0 | `ideogram-4.0` | `ideogram/v4.0` |
| Z-Image Turbo | `z-image-turbo` | `z-image/turbo` |

**Ids are slugs, not paths.** A model id may hold a slash, but the server's `/api/models/:providerId/:modelId` routes take one path segment, so each model gets a stable slug and `models.ts` keeps its path.

Left out: **Soul ID** trains a character rather than making an image, and **Qwen Image 3 edit** requires input images (below).

### How the controls map

- **Aspect.** Each workflow's own ratios, minus the ones Openfield can't draw yet: Qwen Image 3 and Z-Image Turbo also take 7:9 and 9:7; Ideogram 4.0 also takes 5:8, 8:5, 9:22, 22:9, 9:23, 23:9, 3:8, 8:3, 5:12, 12:5, 1:3 and 3:1. `auto` only where the workflow documents it (Marketing Studio, Grok).
- **Resolution.** SOUL's `720p` and `1080p` sit on our 1K and 2K chips (HD and Full HD; 1080p is closest to 2K). Everywhere else the workflow's `1k`/`2k`/`4k` match our tiers by name. Qwen's `2k` is 1536 pixels on a square, not 2048. Recraft V4.1 and Utility make 1K only, the Pro variants 2K only, so the chip shows their one size disabled. Ideogram 4.0 has no resolution field, so the chip says it picks its own size.
- **Quality.** Marketing Studio 2.0: low, medium, high. The 2.5 workflows add `xhigh` ("Extra high") and `max`. Grok: low, medium. Ideogram's quality chip drives its `rendering_speed` (TURBO, DEFAULT, QUALITY). Wire ids are Higgsfield's; labels are ours.
- **Batch.** Only the SOUL workflows take `batch_size`, and only 1 or 4, which the batch control can't say. So every model makes one image per call (`batch.native: false`), up to 4 calls, and `batch_size` is never sent.
- **Seed.** SOUL family 1 to 1,000,000; Qwen Image 3 and Z-Image Turbo 0 to 2,147,483,647. Nothing echoes the seed back.
- **Enhance.** Native on the SOUL family (`enhance_prompt`), Qwen Image 3 and Z-Image Turbo (`prompt_extend`); sent only when the person chose. On Qwen, `enable_thinking` goes off with it (the API requires `prompt_extend` for it), and Advanced has a Thinking switch. Z-Image's rewriting bills at a higher tier. Marketing Studio's own enhancement needs a preset and input images, so it's Openfield's enhancer there.
- **Avoid.** Native only on Qwen Image 3 (`negative_prompt`); elsewhere core appends it to the prompt.
- **Filtering.** Marketing Studio's `moderation` (auto or low).
- **Output format.** Recraft only: JPEG, PNG or WebP (`jpg` on the wire). For the rest the docs don't give the format; the declared PNG only informs the UI, and bytes are stored as returned.
- **Advanced.** SOUL: Style ID, Style strength, Character ID, Character strength. SOUL V2: the same without style strength (accepted but has no effect) and with a character strength above 0 (0 fails at runtime). SOUL Cinema: character only (fixed style). Style and character ids are pasted in: `GET /v1/text2image/soul-styles` (and `/v2`) lists styles, but Openfield doesn't show that list yet, and characters are trained at Higgsfield.
- Not mapped: Recraft's `colors` and `background_color` (RGB objects), Qwen's `prompt_extend_mode`, Marketing Studio's `preset_id`.

## Cost

`price.kind: "provider_estimate"`, so the composer says **Cost unknown**. `estimateRemote()` calls the documented estimate endpoint and scales it by the image count, but nothing calls `estimateRemote()` yet: the server's estimate route and the composer both use the pure `estimate()`. It's also left out of runs on purpose: the conformance suite holds a resumable call to exactly one create call, so a run's usage row records no cost. Pricing page: [open.higgsfield.ai/pricing](https://open.higgsfield.ai/pricing?tab=images) (per-model "from" prices only). Failed, `nsfw` and canceled-while-queued requests are refunded.

## Errors

FastAPI bodies: `{"detail": "…"}`, or a list of `{loc, msg, type}` for a 422. 401 → `auth_invalid`; 403 (out of credits) → `billing_required`; 404 on a create → `auth_forbidden`; 422 → `invalid_request`, with `field` naming the control; 423 (model blocked for now) and 5xx → `provider_unavailable`. **Concurrency is the main limit** and answers **400** "Maximum number of concurrent requests (N) has been reached", with no `Retry-After`: it's `rate_limited` with a 12-second wait. New accounts get 2 requests at once (more after adding funds), hence `maxConcurrent: 2`. A status of `nsfw` is `content_refused`, `failed` is `provider_error`. Every response carries `X-Correlation-ID`, which goes into the error log's message for support.

## Unconfirmed until a live run

- The image host (above), and the output format per model.
- References and edits: they need `POST /files/generate-upload-url`, whose `upload_url` is on an undocumented storage host, so `references.supported` and `imageEdit` are false for now. Once the host is known, add it to `networkHosts` and map `image_urls` / `image_reference_url` / `image_url`.
- The exact create status code (docs show the body only; any 2xx is taken), and the exact 403 and cancel-400 wording.
- `typicalLatencyMs` is a placeholder, not 10 measured runs.
- Webhooks (`?hf_webhook=`) are documented but need a public address, which a local app doesn't have, so the adapter polls.

## Fixtures

`__fixtures__/` is hand-made from the docs, not recorded: see its README.
