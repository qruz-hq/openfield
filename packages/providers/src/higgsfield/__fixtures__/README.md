# Higgsfield fixtures

**These are hand-made, not recorded.** Nobody on the project had a Higgsfield key when the adapter was written, so each file follows the shapes in Higgsfield's docs as of 2026-09-27: the request lifecycle and status reference (`RequestStatus`, `MediaOutput`), the errors page (FastAPI's `{"detail": …}` envelope and its status table), the rate limits page (the concurrency 400) and the billing page (the estimate answer). Ids, messages not quoted in the docs, and URLs are realistic but invented.

Each file is one exchange:

```json
{ "request": { "method": "POST", "path": "/higgsfield-ai/soul/v2/standard" },
  "response": { "status": 200, "headers": { … }, "body": { … } } }
```

| File | What it plays back | Maps to |
|---|---|---|
| `accepted.json` | A create call: `queued` with `request_id`, `status_url`, `cancel_url` | a handle |
| `in-progress.json` | A status read while it runs | `running` |
| `completed.json` | A status read with one image URL | a saved asset |
| `nsfw.json` | Status `nsfw` | `content_refused` |
| `failed.json` | Status `failed` with `error` | `provider_error` |
| `foreign-asset.json` | A finished request whose image is on an undeclared host | `provider_error` (blocked host) |
| `bad-key.json` | 401 `Invalid credentials` (quoted in the docs) | `auth_invalid` |
| `no-credits.json` | 403, out of credits | `billing_required` |
| `model-not-found.json` | 404 on a create | `auth_forbidden` |
| `invalid.json` | 422 with a `detail` list naming `aspect_ratio` | `invalid_request` on `aspect` |
| `concurrency.json` | 400 "Maximum number of concurrent requests (2) has been reached" | `rate_limited`, retry in 12 s |
| `server-error.json` | 500 | `provider_unavailable` |
| `unavailable.json` | 503, model disabled or not ready | `provider_unavailable` |
| `cancel-started.json` | 400 to a cancel once the request has started | a cancel that ends quietly |
| `styles.json` | `GET /v1/text2image/soul-styles` | a working key |
| `estimate.json` | `POST /estimate/…`: `{"credits": "1.500", "usd": "0.094"}` (the docs' example) | an estimated cost |

**Replace them with recorded exchanges** the first time someone runs the live suite with a real key (`OPENFIELD_CONFORMANCE=live`). Remove the key and any auth headers before committing, and swap large images for small ones.
