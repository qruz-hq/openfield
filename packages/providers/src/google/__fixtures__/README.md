# Gemini fixtures

**These are hand-made, not recorded.** Nobody on the project had a Google key when the adapter was written, so each file follows the shapes in Google's own documentation as of 2026-09-23:

- success and refusals: `GenerateContentResponse`, `Candidate.finishReason` and `PromptFeedback.blockReason` in the [generateContent reference](https://ai.google.dev/api/generate-content);
- errors: the standard `google.rpc.Status` body (`code`, `message`, `status`, `details[]` with `ErrorInfo`, `QuotaFailure`, `RetryInfo`) that the Gemini API returns for HTTP errors;
- the model list: `ListModelsResponse` in the [models reference](https://ai.google.dev/api/models).

Ids, token counts and messages are realistic but invented. The image in `generate-success.json` is a 12×16 PNG made by `src/testing/png.ts`.

Each file is one exchange:

```json
{ "request": { "method": "POST", "path": "/v1beta/models/<id>:generateContent" },
  "response": { "status": 200, "headers": { … }, "body": { … } } }
```

| File | What it plays back | Maps to |
|---|---|---|
| `generate-success.json` | One inline image | a saved asset |
| `blocked-prompt.json` | `promptFeedback.blockReason: PROHIBITED_CONTENT`, no candidates | `content_refused` |
| `refused-image-safety.json` | `finishReason: IMAGE_SAFETY`, no image | `content_refused` |
| `no-image.json` | `finishReason: NO_IMAGE` with a text reply | `content_refused` |
| `foreign-asset.json` | An image URL instead of inline data | `provider_error` (blocked host) |
| `bad-key.json` | 400 `INVALID_ARGUMENT`, reason `API_KEY_INVALID` (Gemini's bad-key answer is a 400, not a 401) | `auth_invalid` |
| `forbidden.json` | 403 `PERMISSION_DENIED` | `auth_forbidden` |
| `invalid-argument.json` | 400 `INVALID_ARGUMENT` with no field | `invalid_request` |
| `rate-limited.json` | 429 `RESOURCE_EXHAUSTED`, `RetryInfo.retryDelay: "12s"` | `rate_limited`, retry in 12 s |
| `no-billing.json` | 429 with a quota of 0 (these models have no free tier) | `billing_required` |
| `server-error.json` | 500 `INTERNAL` | `provider_unavailable` |
| `unavailable.json` | 503 `UNAVAILABLE` | `provider_unavailable` |
| `models-list.json` | `GET /v1beta/models` with image, text and embedding models | discovery |
| `flex-busy.json` | 503 `UNAVAILABLE` to a Flex request | `provider_unavailable`, `busy: true` when the setting says keep trying |
| `priority-standard.json` | A Priority request served at Standard: `usageMetadata.serviceTier: "standard"` | `speedUsed: "standard"` |
| `speed-rejected.json` | 400 `INVALID_ARGUMENT` naming `service_tier` | `unsupported_param` on `speed` |
| `batch-create.json` | `batchGenerateContent`: an Operation named `batches/…`, `BATCH_STATE_PENDING` | a `BatchHandle` |
| `batch-running.json` | `BATCH_STATE_RUNNING` with `batchStats` as int64 strings | `running`, counts |
| `batch-succeeded.json` | Two `inlinedResponses`, each with `metadata.key` | two saved images at Batch |
| `batch-partial.json` | One image, one item `error` (`google.rpc.Status` code 13) | one result, one `provider_unavailable` |
| `batch-expired.json` | `BATCH_STATE_EXPIRED`, no output | `timeout` for every image |
| `batch-cancelled.json` | `BATCH_STATE_CANCELLED` with the one image that finished first | one result, one `canceled` |
| `batch-list.json` | `GET /v1beta/batches` with two operations | `find()` by display name |

The speed and batch files follow the [generateContent reference](https://ai.google.dev/api/generate-content) (`serviceTier`, `UsageMetadata.serviceTier`) and the [Batch API reference](https://ai.google.dev/api/batch-mode) (`Operation`, `GenerateContentBatch`, `InlinedResponse`) as of 2026-09-23.

**Replace them with recorded exchanges** the first time someone runs the live suite with a real key (`OPENFIELD_CONFORMANCE=live`). Remove the key and any auth headers before committing, and swap large images for small ones.
