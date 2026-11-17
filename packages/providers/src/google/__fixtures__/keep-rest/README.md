# Keep the rest: live checks

**Recorded 2026-11-17, from real calls.** Each pair is one edit through Openfield (`POST /api/masks` or marks, then `POST /api/edit`), on a made-up 1024 x 1024 room (brick wall, window, plant, wooden table, a little sensor noise), asking for "a single bright red apple" in a 320 x 300 area on the table. Nothing here came from anyone's library.

Files: `base.png` is the room, `<run>.result.png` the model's own result as the server blends it (`/files/model-result/:id?fit=1`), both scaled to 256 px. `<run>.json` has the price, what the model sent, and the numbers measured again at full size with the final core (`image/keep-rest.ts`): line-up, noise, and for Sensitivity 0, 25, 50, 75 and 100 the share of the picture taken from the model (`changed`) and the share of the picture at least 40 px from the area that was (`farFromMaskKept`). `apps/server/test/keep-rest-live.test.ts` replays every pair.

## Google Gemini (`gemini-3.1-flash-image`, edits the whole image)

| Run | Cost | Sent | Mean change outside the mask | Line-up | Taken from the model at 50 |
|---|---|---|---|---|---|
| `gemini-1` | $0.06756 | JPEG 1024 | 8.1 levels | none, 0.997 | 4.4%; 33% at 100 |
| `gemini-2` | $0.06756 | JPEG 1024 | 5.7 levels | none, 0.997 | 4.8%, most of it outside the mask |

Gemini can't take a mask, so it edits the whole image and the mask only decides what's kept. Both runs kept the room in place (no shift), with JPEG noise everywhere. In `gemini-1` it also redrew the tabletop under the apple, lighter and as a trapezoid: a real change, connected to the mask. At the default it is put back (only the apple is kept), from 75 up it is kept (24% of the picture far from the mask at 100). At the fixture's 256 px the same pair keeps it at the default too, so it sits at the edge. In `gemini-2` it put the apple beside the mask, mostly outside it: the old mask-only composite would have cut the apple in half; the kept version keeps all of it as a clear change, and nothing else. Estimates matched the bills ($0.06756).

## Defaults chosen from these runs

- **Sensitivity 50** puts the cut-off 4 noise spreads above the pair's typical difference, and never under 3 levels past what a pixel's neighbours span in the other picture. Sensitivity 0 is 12 spreads (floor 9 levels), 100 is 2.5 spreads (floor 1.9). Geometric either side of 50.
- **The difference is measured against each picture's 3 x 3 neighbourhood**, after taking out a per-channel colour drift. The first version compared pixel to pixel: on these runs, at Sensitivity 75 the re-encode grain of GPT Image and Seedream joined up into false areas covering 29 to 31% of the picture, and 100 fell back every time. Measured this way, every Sensitivity from 0 to 100 keeps the apple alone on every run, apart from Gemini's redrawn tabletop (google/) and 2% of the picture for the Seedream marks run at 100.
- **The line-up is fitted on softened copies**, from three starts (the best whole-pixel shifts over scales 0.95 to 1.05). On sharp grain a single start locked to whole pixels: these results moved by a known 3 px came back 1 px off. Moved by up to 40 px and scaled by up to 5%, they now come back within about 0.1 px of the move plus the model's own drift. Limits unchanged: confidence 0.3, shift 5% of the long edge, scale 6%.
- Analysing a pair takes about 360 ms at 1K and 400 ms at 2K on an M-series Mac, deciding again 30 to 40 ms, and the server keeps the last few analyses, so a Sensitivity drag only decides again.
