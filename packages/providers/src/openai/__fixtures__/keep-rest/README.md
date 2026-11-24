# Keep the rest: live checks

**Recorded 2026-11-17, from real calls.** Each pair is one edit through Openfield (`POST /api/masks` or marks, then `POST /api/edit`), on a made-up 1024 x 1024 room (brick wall, window, plant, wooden table, a little sensor noise), asking for "a single bright red apple" in a 320 x 300 area on the table. Nothing here came from anyone's library.

Files: `base.png` is the room, `<run>.result.png` the model's own result as the server blends it (`/files/model-result/:id?fit=1`), both scaled to 256 px. `<run>.json` has the price, what the model sent, and the numbers measured again at full size with the final core (`image/keep-rest.ts`): line-up, noise, and for Sensitivity 0, 25, 50, 75 and 100 the share of the picture taken from the model (`changed`) and the share of the picture at least 40 px from the area that was (`farFromMaskKept`). `apps/server/test/keep-rest-live.test.ts` replays every pair.

## OpenAI GPT Image (takes a mask)

| Run | Model | Cost | Sent | Mean change outside the mask | Line-up | Taken from the model at 50 |
|---|---|---|---|---|---|---|
| `openai-1` | `gpt-image-2`, low | $0.014152 | PNG 1024 | 4.2 levels | dy 0.77 px, scale 1.002 vertically, confidence 0.985 | 5.3% (apple and shadow) |
| `openai-2` | `gpt-image-2`, low | $0.014152 | PNG 1024 | 3.5 levels | none, 0.995 | 5.2% |
| `openai-flare-1` | `gpt-image-2.5-flare`, low | $0.014202 | PNG 1024 | 4.4 levels | none, 0.996 | 2.7% |

Even with a mask, GPT Image redraws the whole picture: the wood grain and the bricks come back a few levels off everywhere, and one run of three came back moved a little under a pixel and stretched 0.2% vertically. The apple always landed inside the mask, with a soft shadow just past it, which the kept version keeps. Nothing far from the mask is kept at any Sensitivity. Estimates matched the bills to the tenth of a cent ($0.014132).

## Defaults chosen from these runs

- **Sensitivity 50** puts the cut-off 4 noise spreads above the pair's typical difference, and never under 3 levels past what a pixel's neighbours span in the other picture. Sensitivity 0 is 12 spreads (floor 9 levels), 100 is 2.5 spreads (floor 1.9). Geometric either side of 50.
- **The noise is measured in the calmer half of the picture**: the area away from the mask is cut into 16 px tiles (at the analysis size), ranked by their mean difference, and only the lower half is measured. In `gemini-1` the restaged tabletop covers about a quarter of the picture; measured everywhere, it counted as noise and raised the cut-off to 18 levels, just past the tabletop's own 14 to 16, so the default quietly put it back. Measured in the calmer half, the cut-off is 10 and the tabletop is kept, as a big clear change should be.
- **Each pixel's difference is measured against each picture's 3 x 3 neighbourhood**, after taking out a per-channel colour drift. The first version compared pixel to pixel: on these runs, at Sensitivity 75 the re-encode grain of GPT Image and Seedream joined up into false areas covering 29 to 31% of the picture, and 100 fell back every time. Measured this way, every Sensitivity from 0 to 100 keeps the apple alone on GPT Image and Seedream 5.5; Seedream 5.0 Flash's marks run also picks up its redrawn plant and window frame from 75 up (1% of the picture far from the area at 75, 7.5% at 100). Gemini: see google/.
- **The line-up is fitted on softened copies**, from three starts (the best whole-pixel shifts over scales 0.95 to 1.05). On sharp grain a single start locked to whole pixels: these results moved by a known 3 px came back 1 px off. Moved by up to 40 px and scaled by up to 5%, they now come back within about 0.1 px of the move plus the model's own drift. Limits unchanged: confidence 0.3, shift 5% of the long edge, scale 6%.
- Analysing a pair takes about 360 ms at 1K and 400 ms at 2K on an M-series Mac, deciding again 30 to 40 ms, and the server keeps the last few analyses, so a Sensitivity drag only decides again.
