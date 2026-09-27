# Openfield

Openfield is an open-source image generation app that runs on your own computer. You bring an API key from Google, write a prompt, and every image is saved to a folder on your disk. There is no account, no cloud service and no tracking.

Openfield is in early development, so expect rough edges.

## Quick start

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

- [Bun](https://bun.sh) 1.3 or newer.
- A desktop browser. The layout is built for windows 1280 px wide and up.
- An API key from [Google AI Studio](https://aistudio.google.com/apikey). You pay Google directly for what you generate.

Thumbnails use [sharp](https://sharp.pixelplumbing.com). If it can't load on your system, Openfield shows full-size images instead and says so in **Settings > Storage**.

## Where your data lives

Everything lives in `~/.openfield`. Set `OPENFIELD_HOME` to use a different folder.

| Path | What it holds |
|---|---|
| `config.json` | Your keys, the agents' access key and a few startup settings. Readable only by your user account. |
| `config.json.bak` | The previous `config.json`, minus any key you removed or replaced. |
| `openfield.db` | SQLite: prompts, settings, lineage, presets, canvases, usage. |
| `openfield.lock` | Held while Openfield runs, so two copies never share one library. |
| `models.json` | Models you add by hand, if any. Optional. |
| `assets/YYYY/MM/DD/` | Your images, exactly as the model returned them. |
| `uploads/YYYY/MM/DD/` | Reference images you added. |
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

When a variable is in use, Settings shows that the key is set outside Openfield and won't overwrite it. [`.env.example`](.env.example) lists every variable, including `OPENFIELD_PORT` for running on another port.

Openfield sends your prompt, reference images, masks and settings to the company behind the model you pick, using your key. Their terms, data retention and content rules apply. Openfield stores nothing online and sends nothing anywhere else.

## Models

| Company | Models |
|---|---|
| Google | Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite |

Each company is one adapter in `packages/providers/src/<name>/`. It describes what each model can do, and the app builds its controls from that description, so a model only shows the settings it supports. Adding a company is a pull request: see [Adding a provider](docs/adding-a-provider.md).

### Speed and company settings

Each company's own settings open from **Settings > API keys > Settings** on its card. An adapter declares them as panels of fields, and Openfield draws them, saves them and hands them to the adapter on every run. Openfield's own **Limits** panel comes last, with **Runs at once**.

Google's **Speed** panel offers the speeds on [its pricing page](https://ai.google.dev/gemini-api/docs/pricing), priced per image:

| Speed | What it means | Models |
|---|---|---|
| Standard | Images arrive in seconds. Works on every model. | All three |
| Flex | Half price. Takes 1 to 15 minutes, and Google may turn it down when busy. | Nano Banana Pro |
| Batch | Half price. Ready within a day, often sooner. Google stops a batch after 48 hours. | All three |
| Priority | About 80% more. Stays fast when Google is busy. | Nano Banana Pro |

Google's **When it's busy** panel picks what happens when Google turns down a Flex run: keep trying at Flex price, or switch to Standard. It only applies while Speed is Flex.

The speed is chosen only there, not in the composer. A model without the chosen speed runs at Standard, and every price for it says so: the Generate button reads "Standard for this model", and the model picker, the key card and Settings > Models add "· Standard". Estimates, the usage log and **Spent today** follow the speed a run actually used. Google's image models need billing turned on for the key; there is no free tier for them.

A Batch run keeps going at Google even if you close Openfield. Its tiles say "Waiting at Google" and offer **Cancel**, which stops the whole run; the tiles say "Stopping at Google" until Google has. Openfield checks on it after a restart, and when it's done you get a toast and, if you allow it, a system notification. The browser asks once, the first time you send a Batch run.

### Restarts

Stopping Openfield lets running images finish, so a normal stop never loses one. If it stops in the middle of an image anyway, after a crash or a second Ctrl-C, the next start does what it can:

- A Batch run picks up where it left off, because Google keeps it.
- A Google image at Standard, Flex or Priority can't be picked up again: Google returns it only in the answer to the call that was cut off. It runs again once, and its tile says "Ran again after a restart" because you may be charged twice. To mark it interrupted instead, turn off **Settings > Defaults > Run interrupted images again after a restart**.
- A model whose company keeps working while Openfield is stopped is picked up by its id instead, and its tile says "Picking up where it left off". Nothing is sent or billed twice. Google's image models don't work this way; fake mode's Resumable test model does (below).

Every stop and what it left behind is also written to `logs/openfield.log` in your library folder.

An image that was interrupted, or cut off again while it ran again, offers **Try again**.

## Assets

**Assets** in the top bar is your whole library in a tidy grid: **All images**, **Favorites**, your folders and the **Trash**, grouped by day.

- Folders nest as deep as you like. Make one with **+** beside **Folders**, or **New folder** inside the open folder. Drag a folder onto another to move it, or onto the **Folders** heading to bring it back to the top level. Opening a folder shows its subfolders first, then the images filed in it.
- An image can be in several folders, like tags. Drag images onto a folder, or select some and pick **Add to folder**. **Remove from folder** takes them out of the open folder only. Folders are labels, so files never move on disk.
- Deleting a folder deletes the folders inside it too. The images stay in your library.
- Search matches prompts, and **Filter** narrows by model, company and date. Click a checkbox to select, Shift-click for a range, or tick a day's heading to select that whole day.
- Click any image, here or on the Image page, to see it large with its prompt, references and details. Use the arrow keys to step through the list you opened it from, and Esc to close. From there you can **Recreate**, **Reuse** its prompt and settings, download, favorite, file or delete it.
- Delete moves images to the Trash, where they keep their folders and favorite, so **Restore** puts them back where they were. The Trash never empties itself on its own: **Delete for good** or **Empty trash** removes the files from your disk.

Each canvas files the images it makes into a folder named after it. Rename or move that folder and new images still land in it.

## Canvas

Canvas is where you build image flows you can run again. Open **Canvas** in the top bar and start from a blank canvas or a template.

- Add nodes with **+**, `A` or a double-click on empty canvas. Connect them by dragging from one port to another; drop a connection on empty canvas to pick a node that fits it.
- **Prompt**, **Upload** and **Assets** feed **Generate** and **Variations**, which run at the speed set in each company's settings. Notes, text, shapes and frames help you lay things out.
- Run one node from its price button, everything after it from the node menu, or the whole canvas with **Run all**, which shows what it will cost first.
- Nodes whose settings and inputs haven't changed are skipped, so running again costs nothing. Change a prompt and only the nodes after it run again.
- Every image a canvas makes also shows in the Image feed. Canvases save as you work, keep a version history, and export as `.ofcanvas.json` files. A run keeps going if you close the tab or restart Openfield, and an image a restart cuts off follows the rules in [Restarts](#restarts).

Press `?` in a canvas to see every shortcut.

## Agents

AI apps like Claude Code, Claude Desktop, Cursor and Codex can use Openfield for you while it runs: build and run canvases while you watch them change, make and edit images, search and file your library, and check prices and spending. Turn it on in **Settings > Agents**, which has a ready-made snippet for each app. Agents use your keys without ever seeing them, show you the price before anything above the amount you set, and stop at a daily limit. [docs/agents.md](docs/agents.md) has the details.

## Running without keys

```sh
OPENFIELD_FAKE_PROVIDERS=1 OPENFIELD_HOME=/tmp/openfield-dev bun dev
```

Every model call is answered on your computer, so the whole app works with no real key, no network and no cost. Paste any text as the key in **Settings > API keys**, as long as it doesn't contain "invalid" (that one shows the rejected-key path). Requests are checked against each company's documented rules, and the images are generated gradients, not real generations. `OPENFIELD_HOME` keeps all of it out of your real library. The end-to-end tests run this way.

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
| `#fake:slow` | A Google image that takes about 30 seconds, long enough to stop or restart Openfield in the middle of it |
| `#fake:batch_slow` | A Batch run that waits about 30 seconds, long enough to cancel it or restart Openfield |
| `#fake:batch_partial` | A Batch run where every other image fails |
| `#fake:batch_expired`, `#fake:batch_failed` | A Batch run that ends with no images |
| `#fake:success` | A normal image |

Without a tag, a fake Batch run finishes a few seconds after it's sent. Fake runs cost nothing: they are logged at $0 and never count toward **Spent today**.

Fake mode also adds a **Test company** with one model, **Resumable test model**, which keeps working through a restart the way a queue-based company would. Add any key for it in **Settings > API keys**. Its image lands a few seconds after you send it; `#fake:resume_slow` makes it take about a minute, and `#fake:resume_gone` also makes the company forget it after 10 seconds, so a restart finds it gone. `OPENFIELD_FAKE_SLOW_MS` sets how long `#fake:slow` and `#fake:resume_slow` take, in milliseconds.

Tags use underscores, not hyphens: an unknown tag is ignored and the run succeeds. The error answers are written from Google's documentation, not recorded from real calls yet ([why](packages/providers/src/google/__fixtures__/README.md)).

## Scripts

| Command | Does |
|---|---|
| `bun dev` | Runs the server and the Vite dev server (port 4318) together. Open <http://127.0.0.1:4317>. Saving a server file restarts the server once running images are saved. |
| `bun start` | Runs the server in production mode, serving the built web app. |
| `bun run mcp` | The bridge for agent apps that start a program, like Claude Desktop ([docs/agents.md](docs/agents.md)). |
| `bun run build` | Type-checks every workspace, then builds `apps/web` to `apps/web/dist`. |
| `bun run typecheck` | Type-checks every workspace, the end-to-end tests and `scripts/`. |
| `bun test` | Unit tests, the database schema check and the adapter conformance suite (offline). |
| `bun run e2e` | Playwright end-to-end tests in `e2e/`, on fake models and a throwaway library. |
| `bun run lint` | Biome format and lint checks, including the import rules. |
| `bun run format` | Formats the repo and applies Biome's safe fixes, like import order, so `bun run lint` passes. |
| `bun run db:generate` | Generates a SQL migration after a schema change in `packages/db`. |
| `bun run check:bundle` | Builds the web app and fails if server code or a key ended up in the browser bundle. |

## Project layout

```
apps/
  web/          @openfield/web        React app (Vite, Tailwind, React Router, TanStack Query)
  server/       @openfield/server     Hono server on Bun: API, job queue, files, keys
packages/
  core/         @openfield/core       Shared zod schemas, constants, i18n. Runs anywhere.
  providers/    @openfield/providers  Adapters, model registry, cost estimates
  canvas/       @openfield/canvas     Canvas engine: node types, fingerprints, run compiler
  db/           @openfield/db         Drizzle schema and migrations (SQLite)
  ui/           @openfield/ui         Design tokens and presentational components
e2e/                                  Playwright tests
scripts/                              Dev runner and the bundle check
docs/                                 Product spec and guides
```

The browser never loads server code. [CONTRIBUTING.md](CONTRIBUTING.md) explains the import rules and how they are enforced.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and [docs/adding-a-provider.md](docs/adding-a-provider.md) to add a model company. Report security problems privately, as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE), copyright Openfield contributors.

Openfield is an independent project. It is not affiliated with, endorsed by or sponsored by Higgsfield. Higgsfield and its product names, Google, Gemini and Nano Banana are trademarks of their owners.
