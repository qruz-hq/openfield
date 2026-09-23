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

**Replace them with recorded exchanges** the first time someone runs the live suite with a real key (`OPENFIELD_CONFORMANCE=live`). Remove the key and any auth headers before committing, and swap large images for small ones.
