# OpenAI fixtures

**These are hand-made, not recorded.** Nobody on the project had run an OpenAI key against the adapter when it was written, so each file follows the shapes in OpenAI's own documentation as of 2026-09-27:

- errors: the `{ "error": { "message", "type", "param", "code" } }` envelope from the [error codes guide](https://developers.openai.com/api/docs/guides/error-codes), the billing codes from the [rate limits guide](https://developers.openai.com/api/docs/guides/rate-limits), and `moderation_blocked` with `moderation_details` from the image generation guide's "Handling blocked requests";
- the model list: `GET /v1/models` in the [API reference](https://developers.openai.com/api/reference/overview).

Ids and messages are realistic but invented. The organization-verification message in `forbidden.json` comes from community reports, not the docs. Successful images are made by the fake itself (`src/testing/openai.ts`), in the Image API's response shape.

| File | What it plays back | Maps to |
|---|---|---|
| `bad-key.json` | 401 `invalid_api_key` | `auth_invalid` |
| `forbidden.json` | 403, organization not verified | `auth_forbidden`, with the verify message |
| `invalid-size.json` | 400 `invalid_value` on `size` | `unsupported_param`, field `size` |
| `rate-limited.json` | 429 with `Retry-After: 12` | `rate_limited`, retry in 12 s |
| `no-credit.json` | 429 `insufficient_quota` | `billing_required` |
| `server-error.json` | 500 `server_error` | `provider_unavailable` |
| `unavailable.json` | 503 `server_is_overloaded`, `Retry-After: 5` | `provider_unavailable` |
| `moderation-output.json` | 400 `moderation_blocked`, output stage | `content_refused` |
| `moderation-input.json` | 400 `moderation_blocked`, input stage | `content_refused` |
| `foreign-asset.json` | An image URL instead of `b64_json` | `provider_error` |
| `models-list.json` | The three image models, their dated snapshots and some strangers | discovery |
