# Video: the contract

Openfield makes videos the way it makes images: a model with a manifest, a run with a frozen request, a job per output, an asset in the library. This page is the contract the backend offers the web app. It lists every shape a video UI reads or sends, and what's left for the UI. Code wins where this page and the code disagree.

The first video company is BytePlus (Seedance), `packages/providers/src/byteplus/`. Its README has the API facts, prices and limits.

## The one rule: modality

Every model, run and asset says what it makes: `modality` is `"image"` or `"video"`. Everything that existed before video defaults to images, so the Image page and its clients see nothing new unless they ask:

| Listing | Default | Ask for video | Ask for both |
|---|---|---|---|
| `GET /api/models` | images | `?modality=video` | `?modality=all` |
| `GET /api/job-sets` | images | `?modality=video` | `?modality=all` |
| `GET /api/assets` (the library) | **both** | `?modality=video` | no parameter |
| `GET /api/library/summary` counts and facets | both | | |
| `GET /api/models/:providerId/:modelId` | any modality | | |

The event stream carries every modality. `snapshot.activeJobSets`, `job_set.created` and `job.output` include video runs, so every consumer filters by `jobSet.modality` or `asset.modality`. The Image feed should now ignore anything that isn't `"image"`.

Agents' MCP tools stay image-only: `search_assets` and the resource list skip videos, a video can't be a reference or an edit base, and `get_asset` on a video shows its poster.

## Models

`GET /api/models?modality=video` returns `ModelListItem`s. Each has `modality: "video"` (every item carries `modality` now, images too) and a `capabilities.video` block (`packages/core/src/schemas/manifest.ts`, `videoCapabilitySchema`):

```jsonc
{
  "key": "byteplus:seedance-1-0-pro-250528",
  "displayName": "Seedance 1.0 Pro",
  "description": "Silent videos up to 12 seconds, at up to 1080p.",
  "family": "Seedance",
  "modality": "video",
  "capabilities": {
    "size": { "mode": "aspect", "ratios": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "auto"], "default": "16:9" },
    "seed": { "supported": true, "range": [0, 2147483647], "echoed": true },
    "batch": { "max": 1, "native": false },
    "safety": { "notices": ["Saved as HEVC, …"] },        // 2.5 and 2.0 only
    "video": {
      "resolutions": ["480p", "720p", "1080p"],
      "defaultResolution": "1080p",
      "durations": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],  // whole seconds
      "defaultDuration": 5,
      "fps": 24,
      "sizes": [{ "resolution": "720p", "aspect": "16:9", "width": 1248, "height": 704 }, …],
      "frames": { "start": true, "end": true, "mimeTypes": ["image/jpeg", "image/png", "image/webp"], "maxBytes": 31457280 },
      "autoAspect": "with_start_frame",   // or "always"
      "startFrameForcesAuto": false,      // true on Seedance 2.5
      "audio": { "supported": false, "default": false },
      "cameraFixed": true
    }
  },
  "price": { "kind": "video_tokens", "rates": [{ "perMTok": 2.5 }], … },
  "ready": true, "enabled": true
}
```

What the flags mean for the composer:

- **Aspect** comes from `size.ratios`; `"auto"` is the company's own shape. `autoAspect: "with_start_frame"` means `auto` only works with a start frame (without one it falls back to the default ratio with a warning). `startFrameForcesAuto: true` means that with a start frame the video always takes the frame's shape, whatever ratio is picked, so the aspect chip should show Auto and say so (`video.aspectFromFrame`).
- **Resolution** is `video.resolutions`, the company's names. The image `resolution` tiers don't apply.
- **Duration** is `video.durations`. A value in between snaps to the nearest (ties go longer).
- **Sound** exists when `audio.supported`, defaulting to `audio.default`. **Still camera** when `cameraFixed`. **Seed** when `seed.supported` (1.x models only).
- **Frames**: a start frame on every Seedance model; an end frame when `frames.end` (not on 1.0 Pro Fast). An end frame needs a start frame. BytePlus's own limits (300 to 6000 px a side, width over height 0.4 to 2.5, under 30 MB) are checked when the run is sent; a frame outside them fails the tile with `video.frameSize` or `video.frameTooLarge`.
- **Notices**: `safety.notices` says when a size comes as 10-bit HEVC (2.5 at 1080p, 2.0 at 4K), which some browsers can't play.

Browser-safe helpers in `@openfield/providers/manifest`:

- `resolveVideo(manifest, videoRequest, aspect)`: the settings a run will send (every field filled), the ratio after the frame rules, and `notes` for anything dropped or moved. It's the same function `normalize()` freezes a run with, so what the chips show is what's sent.
- `videoSize(caps.video, resolution, aspect)` and `videoSizes(caps.video, resolution)`: exact output pixels. `plannedVideoSize(aspect, resolution)`: roughly, for a placeholder.
- `estimate(manifest, { batch: 1, size: { aspect }, video, speed })`: the price, below.

## Price

`price.kind: "video_tokens"`: tokens = width × height × fps × seconds / 1024 of the output, times the model's rate per million, where a rate may depend on the resolution or on sound (`packages/core/src/video.ts`, `videoTokens`, `videoRate`). `estimate()` prices a chosen ratio exactly and `auto` as the range over its resolution's shapes. Confidence is always `"estimated"`. Its basis reads "1 × $0.257 (5s at 1248×704)", or "1 × $0.756–$0.761 (5s at 720p, in the shape the model picks)" for a range.

The server prices the same way: `POST /api/models/:providerId/:modelId/estimate` takes `{ op: "generate", batch: 1, size, video }`. After a run, the actual cost comes from the tokens BytePlus reported (`usage_log.units = { tokensOut, seconds }`, `costSource: "reconciled"`), and only a finished video is billed.

## Making a video

`POST /api/generate`, the same endpoint and body as images, with `video` (`packages/core/src/schemas/request.ts`, `videoRequestSchema`):

```jsonc
{
  "idempotencyKey": "01K…",
  "model": "byteplus:dreamina-seedance-2-0-260128",
  "op": "generate",
  "prompt": "A kite climbs over a green hill",   // may be "" when there's a start frame
  "size": { "kind": "aspect", "ratio": "16:9" }, // or { "kind": "auto" }
  "batch": 1,
  "seed": null,
  "video": {
    "seconds": 5,                 // optional: the model's default
    "resolution": "720p",         // optional: the model's default
    "audio": true,                // optional, where the model makes sound
    "cameraFixed": false,         // optional, where the model offers it
    "startFrame": { "assetId": "01K…" },  // an image in the library
    "endFrame": { "assetId": "01K…" }     // needs startFrame
  },
  "source": "composer"
}
```

Frames are library images: upload them first with `POST /api/uploads`, as references are. Settings a model can't take are dropped with a warning (its manifest's `unsupportedParamPolicy`); an end frame without a start frame is refused with 400 `invalid_request`, `field: "video.endFrame"`. `video` on an image model is dropped the same way.

The 202 is a `JobSetAccepted` with `jobSet.modality: "video"`, one job, and that job's `width` and `height` already the video's planned size (1280×720 for 720p 16:9) so a placeholder has the right shape. Recreate and Try again replay the frozen request, video settings and frames included.

## Following a run

The same events as images, on `GET /api/events`:

- `job_set.created`: the `JobSetWithJobs`, `jobSet.modality: "video"`.
- `job.started`: the task is at BytePlus. From here on a restart picks it up by its task id; the job shows `resumedAt` when that happened.
- No `job.progress`: BytePlus reports none. Seedance takes a minute or several, longer when BytePlus is busy. A video run's deadline is 2 hours (`OPENFIELD_VIDEO_DEADLINE_MINUTES`); past it the run fails with `timeout`.
- `job.output`: `{ jobSetId, jobId, idx, asset }`, the asset below.
- `job.failed`: `error.code` and `error.reason` as for images. Video-specific reasons: `errors.modelNotActivated` ("Turn on Seedance 2.0 in BytePlus first, then try again."), `errors.spendLimit`, `errors.usageQuota`, `errors.accountOverdue`, `errors.videoBlocked`, `video.frameSize`, `video.frameTooLarge`, and `errors.resumeGone` for a task BytePlus no longer has.
- `job.canceled`: `discarded: true` once the task was sent. BytePlus stops a queued task (and bills nothing), but refuses to stop one that's running. The run stops following it either way, and the tile should say so: `errors.videoStarted` ("BytePlus had already started this video, so you may still be charged.").
- `job_set.completed`: `costActualUsd` is the reconciled cost.

`GET /api/job-sets?status=all&modality=video` lists video runs, newest first, with their jobs.

## The asset

`AssetListItem` (the feed, the library, `job.output`, `asset.updated`) and `Asset` (the detail view) gained:

| Field | Images | Videos |
|---|---|---|
| `modality` | `"image"` | `"video"` |
| `mime` | `image/*` | `video/mp4` or `video/quicktime` |
| `width`, `height` | pixels | the video's display size |
| `durationMs` | absent | length, from the file's own headers |
| `hasAudio` | absent | whether it has a sound track |
| `posterUrl` | absent | `/files/poster/:id`, or null when there's no poster |
| `thumbUrl` | the image | the poster, at the feed's size (WebP) |
| `fileUrl` | the image | the video |

The start and end frames are the video's `references` in the detail view (asset edges, `relation: "reference"`, start first).

## Files

All under `/files`, all needing the `X-Openfield-Session` header like every other file. A `<video src>` can't send it, so load a video as a blob (`fetch` with the header, then `URL.createObjectURL`). Every endpoint takes `?trash=1` for an asset in the Trash, as for images.

- `GET /files/asset/:id`: the video, `content-type` its own type, with ETag and single byte ranges (`Range: bytes=…` answers 206). `?download=1` sends it as an attachment named `openfield_<date>_<model>_<id>.mp4` (or `.mov`). Zips name videos the same way.
- `GET /files/thumb/:id?h=…&dpr=…`: a WebP thumbnail made from the poster, so `<img src={thumbUrl}>` works for images and videos alike. A video without a poster answers 404.
- `GET /files/poster/:id`: the poster itself, a JPEG, immutable. It's the video's first frame when `ffmpeg` is on the computer (`OPENFIELD_FFMPEG` picks another, or `off`), otherwise the last frame BytePlus sends with every video.

## The canvas

A new node type, `video.generate` (`packages/canvas/src/nodes/video/spec.ts`), in a new add-node menu group, `"video"` (`MENU_GROUPS` is now references, image, video, utilities). The web's `GROUP_LABEL` and the blocker copy already know about it; the node's card and inspector don't exist yet (below).

- **Ports**, in rail order: `prompt` (text in, single), `start_frame` (image in, single), `end_frame` (image in, single), `video` (video out, a list). A `video` port connects only to `video` ports (none exist yet). A list of images into a frame input runs the node once per image, like any single input, and the node shows ×k.
- **Params** (`VideoParams`): `model?`, `prompt` (the node's own text, after upstream's), `size?` (`{kind:"aspect"}` or `{kind:"auto"}`, never pixels), `resolution?`, `seconds?`, `sound?`, `cameraFixed`, `seed` (`{ mode, value? }`, as on Generate). Unset means the model's default, so a saved canvas makes the same video on any computer.
- **Models**: the node keeps to video models and image nodes keep to image models; a model of the other kind is `model_unavailable`. A new node starts on `ctx.defaultVideoModel` (the first ready video model). For the editor to see video models its `EngineContext` must be built from `GET /api/models?modality=all` (`buildEngineContext` works out both defaults); today the web builds it from images only.
- **Blockers**: `no_key`, `model_unavailable`, `company_off` as ever; `no_prompt` without words or a start frame; `missing_input` on `start_frame` when only an end frame is connected; and a new kind, `end_frame_unsupported` (`canvas.nodes.blocked.noEndFrame`), when an end frame is connected to a model that can't end on one.
- **Runs**: the plan item's call carries `video` (`seconds`, `resolution`, `audio`, `cameraFixed`); its frames are inputs with `to: "start_frame"` / `"end_frame"` (new `CANVAS_INPUT_TARGETS`), which the server binds into `video.startFrame` and `video.endFrame` for each launch. The node's estimate uses the same size table; frames aren't billed.
- `videoSettings(model, params, hasStartFrame)` gives what a run sends, for the inspector to show.

## Copy added to `en.json`

- `video.placeholder`, `video.count`, `video.duration`, `video.aspectFromFrame`, `video.autoNeedsFrame`, `video.hevc`, `video.frameSize`, `video.frameTooLarge`
- `video.chips.duration.{label,value}`, `video.chips.resolution.label`, `video.chips.sound.{label,on,off,unsupported}`, `video.chips.cameraFixed.{label,hint,unsupported}`, `video.chips.startFrame.{label,add,remove}`, `video.chips.endFrame.{label,add,remove,unsupported,needsStart}`
- `cost.video`, `cost.videoAnyShape`, `cost.videoTokens`
- `errors.modelNotActivated`, `errors.spendLimit`, `errors.usageQuota`, `errors.accountOverdue`, `errors.videoStarted`, `errors.videoBlocked`
- `canvas.nodes.video.{label,description,promptPlaceholder,promptField}`, `canvas.nodes.ports.{startFrame,endFrame,video}`, `canvas.nodes.addMenu.groups.video`, `canvas.nodes.blocked.noEndFrame`

## Fake mode

`OPENFIELD_FAKE_PROVIDERS=1` answers for BytePlus too, with any key but one containing "invalid". A task is queued for 1.5 s, runs until 5 s, then lands a one-second 64×36 MP4 whose display size is the size asked for (with a sound track when sound was on), and a JPEG last frame. Tags in the prompt pick an ending: `#fake:refused` (sensitive output), `#fake:failed`, `#fake:expired`, `#fake:forbidden` (not activated), `#fake:rate_limited`, `#fake:no_billing` (overdue), `#fake:invalid`, `#fake:server_error`, `#fake:unavailable` (overloaded), `#fake:foreign_asset`, `#fake:slow` (queued for `OPENFIELD_FAKE_SLOW_MS`, long enough to cancel or restart), `#fake:resume_slow`, `#fake:resume_gone` (forgotten after 10 s).

## Left for the UI

- The Video page: a composer (model picker on `?modality=video`, aspect, resolution, duration, sound, still camera, seed, start and end frame slots), a feed of video runs from `GET /api/job-sets?modality=video` and the event stream, tiles with the poster, the length and a sound mark, and a player that loads the file as a blob.
- The Image feed and composer: ignore video runs and assets on the event stream (`modality !== "image"`).
- The Assets library: a type filter (`?modality=`), video tiles and the player in the detail view. Its counts already include videos.
- The canvas: the Video node's card and inspector, the node in the web catalogue, and an `EngineContext` built from every model.
- Settings: BytePlus's key card shows like any company's (its mark is in `ProviderLogo`); a note that 2.0 and 2.5 need turning on in the BytePlus console would help.
- Spending: video runs are in the usage log like any other; the "size" grouping shows their pixel size. Seconds and tokens are in `units` if a chart wants them.
