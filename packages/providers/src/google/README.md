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
- **Why generateContent:** Google's guides now show the newer Interactions API, but say generateContent "remains fully supported". It's stateless (Interactions keeps history unless you opt out), and it's what the PRD specifies.
- **Auth:** the `x-goog-api-key` header, never the `?key=` query form.
- **Hosts:** `generativelanguage.googleapis.com` only. Images arrive inline, so `assetHosts` is empty and an image URL in a response is refused.
- **Check key:** `GET /v1beta/models`, which is free. It also feeds discovery.
- **Batch:** one call per image (fan-out). `candidateCount` exists but isn't documented for image models.
- **Cancel:** there's no provider-side cancel. Aborting stops waiting; Google may still bill the image.

## Verified

- The three model ids and their Nano Banana names (models page).
- Ratios and sizes per model, from the resolution tables. **Nano Banana Pro does not list 1:4, 4:1, 1:8 or 8:1**; the PRD had assumed it did. Nano Banana 2 Lite lists the standard ten and 1K only.
- `imageSize` values `512`, `1K`, `2K`, `4K` with an uppercase K; lowercase is rejected. The generateContent reference's `ImageConfig` lists `512`; the guide's "512px (0.5K)" is prose for the Interactions API. Leaving `aspectRatio` out makes the model follow the input image or make a square, which is our `auto`.
- `thinkingConfig.thinkingLevel` takes the `ThinkingLevel` enum names (`MINIMAL`, `HIGH`, …) on generateContent; the guides' lowercase `minimal` and `high` are the Interactions API's spelling. Both checked in the reference on 2026-09-23.
- Up to 14 reference images on all three.
- Every image carries a SynthID watermark, stated in `safety.notices`.
- Per-image prices, standard paid tier. None of these models has a free tier.
- Thinking is always on. `thinkingLevel` (minimal or high) is documented for Nano Banana 2 and 2 Lite only; Google Search grounding for all but Lite. Both are Advanced fields.
- The finish and block reasons used for refusals (generateContent reference).

## Ambiguous or unverified

- **Output format.** The only documented image output type is JPEG (the reference's image `MimeType` enum lists `IMAGE_JPEG` alone), so the manifest says JPEG. Older models returned PNG. Bytes are stored exactly as returned either way.
- **`responseModalities: ["IMAGE"]` on its own.** The reference says the list must exactly match a combination the model supports, but doesn't list the combinations for these models. We send image only; if a live run rejects it, the fix is `["TEXT", "IMAGE"]` and dropping the text part.
- **Inline size limit.** One page caps a whole request at 20 MB, another at 100 MB. We cap each reference at 20 MB and let Google reject anything bigger (mapped to `payload_too_large`).
- **Seeds.** `generationConfig.seed` exists, but reproducible images aren't documented for these models, so the manifest declares no seed support.
- **Error bodies.** generateContent errors are standard `google.rpc.Status` bodies; Google's current error page only documents the Interactions API's snake_case codes. `mapError` reads both. A bad key on generateContent is a **400** with reason `API_KEY_INVALID`, not a 401.
- **Rate limits.** `Retry-After` isn't documented; `RetryInfo.retryDelay` in the body is. We read both, header first. A quota of 0 means the project has no billing, so it maps to `billing_required`. A daily quota maps to `quota_exceeded`.
- **Latency.** `typicalLatencyMs` comes from the PRD's research, not from 10 measured runs yet.

## Left out

- **Nano Banana (`gemini-2.5-flash-image`):** Google shuts it down on October 2, 2026 and already limits it to existing users. Discovery lists it as not supported.
- Masks, upscale and background removal: not offered by these models. Masked edits use Openfield's regional fallback.
- The Batch API's half-price tier and multi-turn editing.

## Discovery

`GET /v1beta/models` doesn't say which models make images, so `recognise()` accepts only the three families, optionally followed by `-preview` and a `-MM-YYYY` snapshot date. A recognised new id borrows its family's capabilities and shows as, for example, "Nano Banana Pro (preview)", but only when the key doesn't also list the family's own id: otherwise the picker would show the same model twice. Everything else is listed in Settings as not supported.

## Fixtures

Hand-made from the documented shapes; see `__fixtures__/README.md`. The fake API that replays them is `src/testing/google.ts`.
