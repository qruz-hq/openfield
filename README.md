# Openfield

Openfield is an open-source image generation app that runs on your own computer. You bring an API key from Google, write a prompt, and every image is saved to a folder on your disk. There is no account, no cloud service and no tracking.

Openfield is in early development, so expect rough edges.

## Quick start

```sh
git clone https://github.com/<owner>/openfield.git
cd openfield
bun install
bun dev
```

Open <http://127.0.0.1:4317>, go to **Settings > API keys**, paste a key and pick **Check key**. Then write a prompt and generate.

`bun dev` also needs port 5173 for the web app, so stop any other Vite dev server first. If the port is taken, it tells you and stops.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- A desktop browser. The layout is built for windows 1280 px wide and up.
- An API key from [Google AI Studio](https://aistudio.google.com/apikey). You pay Google directly for what you generate.

Thumbnails use [sharp](https://sharp.pixelplumbing.com). If it can't load on your system, Openfield shows full-size images instead and says so in **Settings > Storage**.

## Where your data lives

Everything lives in `~/.openfield`. Set `OPENFIELD_HOME` to use a different folder.

| Path | What it holds |
|---|---|
| `config.json` | Your keys and a few startup settings. Readable only by your user account. |
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
| `#fake:no_billing` | The key is out of credit |
| `#fake:rate_limited` | Too many requests |
| `#fake:invalid` | The settings didn't work |
| `#fake:server_error`, `#fake:unavailable` | The company's server had a problem |
| `#fake:blocked`, `#fake:refused`, `#fake:no_image` | The model wouldn't make the image |
| `#fake:foreign_asset` | The image came from a site the adapter didn't declare |
| `#fake:success` | A normal image |

Tags use underscores, not hyphens: an unknown tag is ignored and the run succeeds. The error answers are written from Google's documentation, not recorded from real calls yet ([why](packages/providers/src/google/__fixtures__/README.md)).

## Scripts

| Command | Does |
|---|---|
| `bun dev` | Runs the server and the Vite dev server together. Open <http://127.0.0.1:4317>. |
| `bun start` | Runs the server in production mode, serving the built web app. |
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
