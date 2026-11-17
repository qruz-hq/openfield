# Keep the rest: live checks

**Recorded 2026-11-17, from real calls.** Each pair is one edit through Openfield (`POST /api/masks` or marks, then `POST /api/edit`), on a made-up 1024 x 1024 room (brick wall, window, plant, wooden table, a little sensor noise), asking for "a single bright red apple" in a 320 x 300 area on the table. Nothing here came from anyone's library.

Files: `base.png` is the room, `<run>.result.png` the model's own result as the server blends it (`/files/model-result/:id?fit=1`), both scaled to 256 px. `<run>.json` has the price, what the model sent, and the numbers measured again at full size with the final core (`image/keep-rest.ts`): line-up, noise, and for Sensitivity 0, 25, 50, 75 and 100 the share of the picture taken from the model (`changed`) and the share of the picture at least 40 px from the area that was (`farFromMaskKept`). `apps/server/test/keep-rest-live.test.ts` replays every pair.

## BytePlus Seedream (edits the whole image; Flash takes marks)

| Run | Model | Cost | Sent | Mean change outside the area | Line-up | Taken from the model at 50 |
|---|---|---|---|---|---|---|
| `seedream-flash-1` | `dola-seedream-5-0-flash-260915`, mask | $0.018 | PNG 1024 | 4.0 levels | none, 0.996 | 2.1% |
| `seedream-flash-marks` | the same, Sketch & point box | $0.018 | PNG 1024 | 4.1 levels | none, 0.996 | 6.9% |
| `seedream-55-1` | `dola-seedream-5-5-261028`, mask | $0.028 | PNG 1024 | 0.6 levels | none, 1.0 | 1.8% |

Seedream doesn't take a mask either, so a masked edit is a whole-image edit. 5.0 Flash re-renders everything a few levels off, like GPT Image; 5.5 copies the rest almost exactly (typical difference 0.05 levels), so for 5.5 Keep the rest mostly guards against the rare stray change. The marks run drew the box on the image sent, and the model's result came back without it; the kept version, turned on after the run, starts from the box and keeps the apple and its shadow, which spill a little past it. Estimates matched the bills.

## Defaults chosen from these runs

- **Sensitivity 50** puts the cut-off 4 noise spreads above the pair's typical difference, and never under 3 levels past what a pixel's neighbours span in the other picture. Sensitivity 0 is 12 spreads (floor 9 levels), 100 is 2.5 spreads (floor 1.9). Geometric either side of 50.
- **The difference is measured against each picture's 3 x 3 neighbourhood**, after taking out a per-channel colour drift. The first version compared pixel to pixel: on these runs, at Sensitivity 75 the re-encode grain of GPT Image and Seedream joined up into false areas covering 29 to 31% of the picture, and 100 fell back every time. Measured this way, every Sensitivity from 0 to 100 keeps the apple alone on every run, apart from Gemini's redrawn tabletop (google/) and 2% of the picture for the Seedream marks run at 100.
- **The line-up is fitted on softened copies**, from three starts (the best whole-pixel shifts over scales 0.95 to 1.05). On sharp grain a single start locked to whole pixels: these results moved by a known 3 px came back 1 px off. Moved by up to 40 px and scaled by up to 5%, they now come back within about 0.1 px of the move plus the model's own drift. Limits unchanged: confidence 0.3, shift 5% of the long edge, scale 6%.
- Analysing a pair takes about 360 ms at 1K and 400 ms at 2K on an M-series Mac, deciding again 30 to 40 ms, and the server keeps the last few analyses, so a Sensitivity drag only decides again.
