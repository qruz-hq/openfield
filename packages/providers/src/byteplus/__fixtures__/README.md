# BytePlus fixtures

**Hand-made, not recorded.** Nobody on the project had a BytePlus key when the adapter was written, so each file follows the shapes in BytePlus's API reference as of 2026-09-29: the Create and Retrieve task pages (the task body, `content`, `usage`), and the error code page (the `{"error": {"code", "message"}}` envelope, each code's status and wording). Ids, request ids and URLs are realistic but invented.

Each JSON file is one exchange:

```json
{ "request": { "method": "POST", "path": "/api/v3/contents/generations/tasks" },
  "response": { "status": 200, "headers": { … }, "body": { … } } }
```

| File | What it plays back | Maps to |
|---|---|---|
| `accepted.json` | A create: `{"id": "cgt-…"}` | a handle |
| `queued.json`, `running.json` | A read while it waits and while it runs | `queued`, `running` |
| `succeeded.json` | A finished task: signed `video_url` and `last_frame_url` on TOS, 102,960 completion tokens (1.0 Pro, 720p 16:9, 5 s, the docs' own example) | a saved video and its poster |
| `foreign-asset.json` | A finished task whose video is on an undeclared host | `provider_error` (blocked host) |
| `refused.json` | Status `failed`, `OutputVideoSensitiveContentDetected` | `content_refused` |
| `failed.json` | Status `failed`, `InternalServiceError` | `provider_unavailable` |
| `expired.json` | Status `expired` | `timeout` |
| `gone.json` | 404 `ResourceNotFound` on a read | `notFound` |
| `bad-key.json` | 401 `AuthenticationError` | `auth_invalid` |
| `not-activated.json` | 404 `ModelNotOpen` | `auth_forbidden`, "Turn on … in BytePlus first" |
| `service-not-open.json` | 403 `OperationDenied.ServiceNotOpen` | the same |
| `overdue.json` | 403 `AccountOverdueError` | `billing_required` |
| `rate-limited.json` | 429 `RateLimitExceeded.EndpointRPMExceeded` with `Retry-After: 12` | `rate_limited`, retry in 12 s |
| `overloaded.json` | 429 `ServerOverloaded` | `provider_unavailable` |
| `spend-limit.json` | 429 `SetLimitExceeded` | `quota_exceeded` |
| `server-error.json` | 500 `InternalServiceError` | `provider_unavailable` |
| `invalid.json` | 400 `InvalidParameter` naming `duration` | `invalid_request` on `video.seconds` |
| `input-flagged.json` | 400 `InputImageSensitiveContentDetected` | `content_flagged_input` |
| `cancel-started.json` | 409 to a delete once the task runs (a guess: see the adapter README) | a cancel that ends quietly |
| `tasks.json` | The task list, empty | a working key |

`media.ts` holds the fake's video and last frame, base64-encoded so the fake reads no files: two 64×36 H.264 MP4s of one second at 24 fps (one with a silent mono AAC track, one without), and a 64×36 JPEG. They were made with `make-media.swift` (AVFoundation, macOS):

```sh
swiftc -O make-media.swift -o make-media
./make-media sound.mp4 64 36 24 1 && ./make-media silent.mp4 64 36 24 0
```

and the JPEG with `sips -s format jpeg` from a 64×36 gradient PNG. The fake sets each video's display size (its track header) to the size asked for, so the library sees the right shape; the pictures inside stay 64×36.

**Replace the JSON with recorded exchanges** the first time someone runs the live suite with a real key (`OPENFIELD_CONFORMANCE=live`). Remove the key and any auth headers before committing, and cut signed query strings from URLs.
