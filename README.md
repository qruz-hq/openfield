# Openfield

Openfield is an open-source app for making images and videos on your own computer. You bring your own API key from Google, OpenAI, Higgsfield or BytePlus, write a prompt, and everything you make is saved to a folder on your disk. There is no account, no cloud service and no tracking.

Openfield is in early development, so expect rough edges.

## Desktop app

The easiest way to get Openfield. Download the installer for your computer from the [latest release](https://github.com/qruz-hq/openfield/releases/latest). You don't need Bun for it.

| Computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `Openfield_<version>_aarch64.dmg` |
| Mac with Intel | `Openfield_<version>_x64.dmg` |
| Windows (x64) | `Openfield_<version>_x64-setup.exe`, or the `.msi` |
| Linux (x86_64) | `.AppImage`, `.deb` or `.rpm` |

The other files in a release are for the app's updater. You can ignore them.

Opening it the first time:

- **macOS** 13 or newer. The Mac builds are signed and notarized by Apple, so Openfield opens like any other app. Drag it to Applications first.
- **Windows.** The installer isn't signed yet. If SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.
- **Linux.** Install the `.deb` or `.rpm` with your package manager, or run `chmod +x` on the `.AppImage` and open it.

[docs/desktop.md](docs/desktop.md) has more on the app and how it's built.

What to know:

- The app uses the same library as `bun start`, so your images, videos, keys and settings show up in both. Only one can be open at a time.
- Each time it opens, it checks for a new version and asks first: **Install and restart** or **Later**.
- While something is generating, its icon in the Dock or taskbar slowly turns.
- Quitting while something is generating asks first. If you quit anyway, Openfield finishes what it can in about 20 seconds and stops the rest.

## Run from source

You need [Bun](https://bun.sh) 1.3 or newer.

```sh
git clone https://github.com/qruz-hq/openfield.git
cd openfield
bun install
bun dev
```

Open <http://127.0.0.1:4317>, go to **Settings > API keys**, paste a key and pick **Check key**. Then write a prompt and generate.

`bun dev` also runs the web app's dev server on port 4318, beside the app's own 4317, so it doesn't clash with other Vite projects on 5173. If 4318 is taken, it tells you and stops. You always open the app on 4317.

To stop Openfield, press Ctrl-C. Images being made finish first, and it says how many: "Finishing 1 image. Press Ctrl-C again to stop now." A second Ctrl-C stops at once.

## Requirements

- An API key from at least one company in [Models](#models). You pay the company directly for what you make. Video needs a BytePlus key.
- A desktop browser, if you run from source. The layout is built for windows 1280 px wide and up.
- [Bun](https://bun.sh) 1.3 or newer, only to run from source.

Optional, and never downloaded for you:

| Tool | What it's for |
|---|---|
| [sharp](https://sharp.pixelplumbing.com) | Thumbnails. Installed with Openfield. If it can't load on your system, Openfield shows full-size images instead and says so in **Settings > Storage**. |
| [ffmpeg](https://ffmpeg.org) | A video's poster is its first frame. Without it, the poster is the still BytePlus sends, which is the last frame. Set `OPENFIELD_FFMPEG` to its path, or to `off` to always use the company's still. |
| HEIC tools | Opening HEIC photos you upload. macOS has them built in. On Linux, install `heif-dec` or `heif-convert` (`libheif-examples` or `libheif-tools`). |

The Linux `.deb` and `.rpm` recommend ffmpeg and the HEIC tools. On macOS, the desktop app finds ffmpeg installed with Homebrew.

## Where your data lives

Everything lives in `~/.openfield`. Set `OPENFIELD_HOME` to use a different folder.

| Path | What it holds |
|---|---|
| `config.json` | Your keys, the agents' access key and a few startup settings. Readable only by your user account. |
| `config.json.bak` | The previous `config.json`, minus any key you removed or replaced. |
| `openfield.db` | SQLite: prompts, settings, lineage, presets, canvases, usage. |
| `openfield.lock` | Held while Openfield runs, so two copies never share one library. |
| `models.json` | Models you add by hand, if any. Optional. |
| `assets/YYYY/MM/DD/` | Your images and videos, exactly as the model returned them. Each video keeps its poster beside it. |
| `uploads/YYYY/MM/DD/` | Reference images and frames you added. |
| `thumbs/` | Thumbnail cache. Safe to delete. |
| `logs/` | Logs, with keys removed. |
| `backups/` | Library backups you make. |
| `canvases/` | Canvas exports, templates and previews. |
| `presets/` | Presets you export or import. |
| `tmp/` | Partial downloads. Safe to delete while Openfield is stopped. |

Paths in the database are relative, so copying the folder to another computer moves your whole library.

## Keys

Keys stay on your computer. The server makes every call to the model, so your key never reaches the browser, and the settings API only ever tells the page whether a key is set and its last four characters.

Other websites can't use Openfield, but while it runs, any program on this computer that can reach `127.0.0.1` can, including other user accounts. On a shared computer, stop Openfield when you're done. [SECURITY.md](SECURITY.md) has the details.

Environment variables override keys saved in Settings, and are never written to disk. The first one that is set wins:

| Company | Variables |
|---|---|
| Google | `OPENFIELD_GOOGLE_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY` |
| OpenAI | `OPENFIELD_OPENAI_API_KEY`, `OPENAI_API_KEY` |
| Higgsfield | `OPENFIELD_HIGGSFIELD_API_KEY` (not `HF_KEY`, which belongs to Hugging Face) |
| BytePlus | `OPENFIELD_BYTEPLUS_API_KEY`, `ARK_API_KEY` |

When a variable is in use, Settings shows that the key is set outside Openfield and won't overwrite it. [`.env.example`](.env.example) has a few more settings, like `OPENFIELD_PORT` for running on another port. `OPENFIELD_VIDEO_DEADLINE_MINUTES` sets how long Openfield waits for a video, from 10 minutes to 2 days. The default is 2 hours. BytePlus drops a video it hasn't finished after 2 hours either way, so only a lower value changes anything.

Openfield sends your prompt, reference images, frames, masks and settings to the company behind the model you pick, using your key. Their terms, data retention and content rules apply. Openfield stores nothing online and sends nothing anywhere else.

## Models

| Company | Makes | Models | Get a key |
|---|---|---|---|
| Google | Images | Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite | [Google AI Studio](https://aistudio.google.com/apikey) |
| OpenAI | Images | GPT Image 2.5 Sunburst, GPT Image 2.5 Flare, GPT Image 2 | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Higgsfield | Images | SOUL, SOUL V2, SOUL Cinema, Marketing Studio Image 2.0 Alpha, 2.5 Flare and 2.5 Sunburst, Grok Image 2.0, Recraft V4.1, V4.1 Utility, V4.1 Pro and V4.1 Utility Pro, Qwen Image 3, Ideogram 4.0, Z-Image Turbo | [Higgsfield](https://open.higgsfield.ai/api-keys) |
| BytePlus | Videos | Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini, 1.5 Pro, 1.0 Pro, 1.0 Pro Fast | [BytePlus ModelArk](https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey) |

Keys cost nothing to create. You pay for what you make. Before your first run:

| Company | What to know |
|---|---|
| Google | Billing must be turned on for the key, at every speed. There is no free tier for image models. |
| OpenAI | Add some credit under Billing. Some models need a verified organization. The price shown before a run is an estimate, replaced by what OpenAI reports once it's done. |
| Higgsfield | Prices come from Higgsfield's own estimate. The Marketing Studio 2.5 models show "Cost unknown". Failed and blocked runs, and runs canceled while queued, are refunded. New accounts can run 2 at once. |
| BytePlus | Turn on Seedance 2.0 and 2.5 in the BytePlus console first (it needs a balance over $30 or a resource pack). Only a finished video is billed. A video can be canceled only while it's queued. |

Each company is one adapter in `packages/providers/src/<name>/`. It describes what each model can do, and the app builds its controls from that description, so a model only shows the settings it supports. Adding a company is a pull request: see [Adding a provider](docs/adding-a-provider.md).

### Speed and company settings

Each company's own settings open from **Settings > API keys > Settings** on its card. An adapter declares them as panels of fields, and Openfield draws them, saves them and hands them to the adapter on every run. Openfield's own **Limits** panel comes last, with **Runs at once**. Higgsfield and BytePlus have only **Limits**.

Google's **Speed** panel offers the speeds on [its pricing page](https://ai.google.dev/gemini-api/docs/pricing), priced per image:

| Speed | What it means | Models |
|---|---|---|
| Standard | Images arrive in seconds. Works on every model. | All three |
| Flex | Half price. Takes 1 to 15 minutes, and Google may turn it down when busy. | Nano Banana Pro |
| Batch | Half price. Ready within a day, often sooner. Google stops a batch after 48 hours. | All three |
| Priority | About 80% more. Stays fast when Google is busy. | Nano Banana Pro |

Google's **When it's busy** panel picks what happens when Google turns down a Flex run: keep trying at Flex price, or switch to Standard. It only applies while Speed is Flex.

OpenAI's **Speed** panel:

| Speed | What it means | Models |
|---|---|---|
| Standard | Full price. Images in under two minutes. Works on every model. | All three |
| Batch | Half price. Runs in the background and is ready within a day. New images only: edits run at Standard. | GPT Image 2 |

The speed is chosen only there, not in the composer. A model without the chosen speed runs at Standard, and every price for it says so: the Generate button reads "Standard for this model", and the model picker, the key card and Settings > Models add "· Standard". Estimates, the usage log and **Spent today** follow the speed a run actually used.

A Batch run keeps going at the company even if you close Openfield. Its tiles say "Waiting at Google" or "Waiting at OpenAI" and offer **Cancel**, which stops the whole run. They say "Stopping at" the company until it has. Openfield checks on it after a restart, and when it's done you get a toast and, if you allow it, a system notification. The browser asks once, the first time you send a Batch run.

### Restarts

Stopping Openfield lets running images finish, so a normal stop never loses one. If it stops in the middle of one anyway, after a crash or a second Ctrl-C, the next start does what it can:

- A Batch run at Google or OpenAI picks up where it left off, because the company keeps it.
- An image at Google's Standard, Flex or Priority, or at OpenAI's Standard, can't be picked up again: the company returns it only in the answer to the call that was cut off. It runs again once, and its tile says "Ran again after a restart" because you may be charged twice. To mark it interrupted instead, turn off **Settings > Defaults > Run interrupted images again after a restart**.
- Higgsfield and BytePlus keep working while Openfield is stopped, so their images and videos are picked up by id, and the tile says "Picking up where it left off". Nothing is sent or billed twice. If Openfield stopped before the company even confirmed the request, the tile offers **Try again** instead of sending it a second time.

Every stop and what it left behind is also written to `logs/openfield.log` in your library folder.

Anything that was interrupted, or cut off again while it ran again, offers **Try again**.

## Video

**Video** in the top bar makes short videos with BytePlus's Seedance models. Write a prompt, then set **Duration**, **Resolution**, **Sound** and **Still camera**.

- Add a **Start frame** to begin from an image, and an **End frame** to land on one. Upload them or pick them from your library. An end frame needs a start frame.
- What you can set depends on the model. Sound isn't on every model, and 1.0 Pro Fast has no end frame. On Seedance 2.5, the video takes the start frame's shape.
- The price is estimated from the video's size and length before you send it. Only a finished video is billed.
- Seedance 2.5 at 1080p and 2.0 at 4K come as 10-bit HEVC, which some browsers can't play.

Each run makes one video. It lands in your library beside your images. [docs/video.md](docs/video.md) has the details.

## Assets

**Assets** in the top bar is your whole library, images and videos, in a tidy grid: **All images**, **Favorites**, your folders and the **Trash**, grouped by day.

- Folders nest as deep as you like. Make one with **+** beside **Folders**, or **New folder** inside the open folder. Drag a folder onto another to move it, or onto the **Folders** heading to bring it back to the top level. Opening a folder shows its subfolders first, then the images filed in it.
- An image can be in several folders, like tags. Drag images onto a folder, or select some and pick **Add to folder**. **Remove from folder** takes them out of the open folder only. Folders are labels, so files never move on disk.
- Deleting a folder deletes the folders inside it too. The images stay in your library.
- Search matches prompts, and **Filter** narrows by type (images or videos), model, company and date. Click a checkbox to select, Shift-click for a range, or tick a day's heading to select that whole day.
- Click any image or video, here or on the Image and Video pages, to see it large with its prompt, references and details. Use the arrow keys to step through the list you opened it from, and Esc to close. From there you can **Recreate**, **Reuse** its prompt and settings, download, favorite, file or delete it.
- Delete moves items to the Trash, where they keep their folders and favorite, so **Restore** puts them back where they were. The Trash never empties itself on its own: **Delete for good** or **Empty trash** removes the files from your disk.

Each canvas files the images it makes into a folder named after it. Rename or move that folder and new images still land in it.

## Canvas

Canvas is where you build image and video flows you can run again. Open **Canvas** in the top bar and start from a blank canvas or a template: **Start from a reference**, **Storyboard** or **Compare two styles**.

- Add nodes with **+**, `A` or a double-click on empty canvas. Connect them by dragging from one port to another; drop a connection on empty canvas to pick a node that fits it.
- **Prompt**, **Upload** and **Assets** feed **Generate**, **Variations** and **Video**, which run at the speed set in each company's settings. **Video** takes a prompt and optional start and end frames. Notes, text, shapes and frames help you lay things out.
- Run one node from its price button, everything after it from the node menu, the nodes you picked with **Run selected**, or the whole canvas with **Run all**, which shows what it will cost first.
- Nodes whose settings and inputs haven't changed are skipped, so running again costs nothing. Change a prompt and only the nodes after it run again.
- **Lock** a node from its menu to keep its results and stop it being deleted. You can still move it. Locking a frame locks what's inside.
- Each canvas shows what it has cost beside what you've spent today everywhere.
- Every image a canvas makes also shows in the Image feed. Canvases save as you work, keep a version history, and export as `.ofcanvas.json` files. A run keeps going if you close the tab or restart Openfield, and anything a restart cuts off follows the rules in [Restarts](#restarts).

Press `?` in a canvas to see every shortcut.

## Settings

**Settings** has API keys, Models, Defaults, Appearance, Storage, Spending, Agents, Privacy, Help and Experimental. **Spent today** in the top bar opens **Spending**, which charts what you've spent by model over any range.

## Agents

AI apps like Claude Code, Claude Desktop, Cursor and Codex can use Openfield for you while it runs: build and run canvases while you watch them change, make and edit images, search and file your library, and check prices and spending. Turn it on in **Settings > Agents**, which has a ready-made snippet for each app. Agents use your keys without ever seeing them, show you the price before anything above the amount you set, and stop at a daily limit. Agents can't search your videos or use them as references, but running a canvas makes its videos too, just as the Run button would. [docs/agents.md](docs/agents.md) has the details.

With the desktop app, copy the command from **Settings > Agents** rather than typing it, and on macOS move Openfield to Applications first. [docs/desktop.md](docs/desktop.md#agents-mcp) explains why.

## Running without keys

```sh
OPENFIELD_FAKE_PROVIDERS=1 OPENFIELD_HOME=/tmp/openfield-dev bun dev
```

Every model call is answered on your computer, so the whole app works with no real key, no network and no cost. Paste any text as the key in **Settings > API keys**, as long as it doesn't contain "invalid" (that one shows the rejected-key path). Requests are checked against each company's documented rules. Images are generated gradients and videos are tiny test clips, not real generations. `OPENFIELD_HOME` keeps all of it out of your real library. The end-to-end tests run this way.

To see a failure, put a tag in the prompt, for example `#fake:rate_limited`. The tags are:

| Tag | Plays back |
|---|---|
| `#fake:bad_key` | The key is rejected |
| `#fake:forbidden` | The key can't use this model |
| `#fake:no_billing` | Billing isn't turned on for the key |
| `#fake:rate_limited` | Too many requests |
| `#fake:invalid` | The settings didn't work |
| `#fake:server_error`, `#fake:unavailable` | The company's server had a problem |
| `#fake:blocked`, `#fake:refused`, `#fake:no_image` | The model wouldn't make the image |
| `#fake:foreign_asset` | The image came from a site the adapter didn't declare |
| `#fake:flex_busy` | Flex is busy on the first try, then the image (set Speed to Flex) |
| `#fake:priority_standard` | A Priority run served, and billed, at Standard (set Speed to Priority) |
| `#fake:slow` | A run that takes about 30 seconds, long enough to stop or restart Openfield in the middle of it. A video stays queued, so you can cancel it. |
| `#fake:batch_slow` | A Batch run that waits about 30 seconds, long enough to cancel it or restart Openfield |
| `#fake:batch_partial` | A Batch run where every other image fails |
| `#fake:batch_expired`, `#fake:batch_failed` | A Batch run that ends with no images |
| `#fake:failed` | A video that ends with no video |
| `#fake:expired` | A video that expires before it runs |
| `#fake:success` | A normal result |

Without a tag, a fake Batch run finishes a few seconds after it's sent. Fake runs cost nothing: they are logged at $0 and never count toward **Spent today**.

Fake mode also adds a **Test company** with one model, **Resumable test model**, which keeps working through a restart the way a queue-based company would. Add any key for it in **Settings > API keys**. Its image lands a few seconds after you send it. `#fake:resume_slow` makes it take about a minute, and `#fake:resume_gone` also makes the company forget it after 10 seconds, so a restart finds it gone. Both tags work on Seedance models too. `OPENFIELD_FAKE_SLOW_MS` sets how long `#fake:slow` and `#fake:resume_slow` take, in milliseconds.

Tags use underscores, not hyphens: an unknown tag is ignored and the run succeeds. Each company's fake answers are written from its documentation, not recorded from real calls yet. The `__fixtures__/README.md` in each adapter says why ([Google's](packages/providers/src/google/__fixtures__/README.md)).

## Scripts

| Command | Does |
|---|---|
| `bun dev` | Runs the server and the Vite dev server (port 4318) together. Open <http://127.0.0.1:4317>. Saving a server file restarts the server once running images are saved. |
| `bun start` | Runs the server in production mode, serving the built web app. |
| `bun run desktop:sidecar` | Builds the web app and the server for the desktop app. Takes `--target`, `--skip-web` and `--skip-native` ([docs/desktop.md](docs/desktop.md)). |
| `bun run desktop` | Builds the sidecar, then opens the desktop app in dev mode. |
| `bun run desktop:build` | Builds the sidecar, then a release build of the desktop app. |
| `bun run desktop:icons` | Draws the desktop app's icons from the aperture mark. |
| `bun run mcp` | The bridge for agent apps that start a program, like Claude Desktop, when you run from source ([docs/agents.md](docs/agents.md)). |
| `bun run build` | Type-checks every workspace, then builds `apps/web` to `apps/web/dist`. |
| `bun run typecheck` | Type-checks every workspace, the end-to-end tests and `scripts/`. |
| `bun test` | Unit tests, the database schema check and the adapter conformance suite (offline). |
| `bun run e2e` | Playwright end-to-end tests in `e2e/`, on fake models and a throwaway library. |
| `bun run lint` | Biome format and lint checks, including the import rules. |
| `bun run format` | Formats the repo and applies Biome's safe fixes, like import order, so `bun run lint` passes. |
| `bun run db:generate` | Generates a SQL migration after a schema change in `packages/db`. |
| `bun run check:bundle` | Builds the web app and fails if server code or a key ended up in the browser bundle. |
| `bun run seed:usage` | Fills a separate test library (`.openfield/dev-spending`) with months of made-up runs for **Settings > Spending**. Never touches `~/.openfield`. Takes `--home`, `--days` and `--seed`. |

## Project layout

```
apps/
  web/          @openfield/web        React app (Vite, Tailwind, React Router, TanStack Query)
  server/       @openfield/server     Hono server on Bun: API, job queue, files, keys
  desktop/                            Desktop app (Tauri) that runs the server as a sidecar
packages/
  core/         @openfield/core       Shared zod schemas, constants, i18n. Runs anywhere.
  providers/    @openfield/providers  Adapters (google, openai, higgsfield, byteplus), model registry, cost estimates
  canvas/       @openfield/canvas     Canvas engine: node types, fingerprints, run compiler
  db/           @openfield/db         Drizzle schema and migrations (SQLite)
  ui/           @openfield/ui         Design tokens and presentational components
e2e/                                  Playwright tests
scripts/                              Dev runner, bundle check, desktop builds, spending seed
docs/                                 Product spec and guides: agents, desktop, video, adding a provider
```

The browser never loads server code. [CONTRIBUTING.md](CONTRIBUTING.md) explains the import rules and how they are enforced.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and [docs/adding-a-provider.md](docs/adding-a-provider.md) to add a model company. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Every change reaches `main` through a pull request. If you're contributing, open it from your own fork. CI has to pass and a maintainer has to approve, then it's squash merged with a Conventional Commit title. Only maintainers tag releases. [How changes reach main](CONTRIBUTING.md#how-changes-reach-main) has the full rules.

Report security problems privately from the repo's **Security** tab with **Report a vulnerability**, not in a public issue. [SECURITY.md](SECURITY.md) has the details.

## License

[MIT](LICENSE), copyright Openfield contributors.

Openfield is an independent project. It is not affiliated with, endorsed by or sponsored by Higgsfield, Google, OpenAI, BytePlus or any other company named here. Higgsfield and its product names, Google, Gemini, Nano Banana, OpenAI, GPT Image, BytePlus, ModelArk, Seedance, Grok, Recraft, Qwen and Ideogram are trademarks of their owners.
