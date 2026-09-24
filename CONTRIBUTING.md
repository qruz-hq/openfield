# Contributing to Openfield

Thanks for helping. This guide covers setup, how the code is organised, the rules the checks enforce, and how to get a change merged.

The product spec is [docs/PRD.md](docs/PRD.md). Section 0 ("Canonical contracts") is binding: names, enums, routes, paths and defaults come from there. If your change disagrees with it, change the spec in the same pull request and say why.

## Setup

You need [Bun](https://bun.sh) 1.3 or newer. Use Bun for everything: no npm, npx, yarn or pnpm (`bunx` is fine).

```sh
git clone https://github.com/<you>/openfield.git
cd openfield
bun install
OPENFIELD_FAKE_PROVIDERS=1 OPENFIELD_HOME=/tmp/openfield-dev bun dev
```

Open <http://127.0.0.1:4317>. `bun dev` also runs Vite on port 4318 (`strictPort`), so it never clashes with another project's Vite on 5173. If something else holds 4318, it says so and stops. The server proxies every page request to Vite, so you only ever open 4317; the port is set in `scripts/dev.ts`, `apps/web/vite.config.ts` and `apps/server/src/http/spa.ts`.

The web app reloads through Vite. The server doesn't run under `bun --watch`, which would kill it on every save and lose any image being made. `scripts/dev.ts` watches the server's sources itself (`apps/server/src`, and `src` in `core`, `providers` and `db`, plus the migrations; tests and editor temp files don't count). A save restarts the server the way Ctrl-C stops it: "Restarting the server.", then images that can't pick up where they left off finish and are saved ("Finishing 1 image before restarting. The app is back after that."), resumable ones are left with the company for the new server to pick up, and the new server starts on the same port. While it finishes, the old server no longer answers, so the page shows it's reconnecting and your latest change isn't live yet; with a slow image (a Flex call can take many minutes) that wait is real, so watch the terminal. `bun dev` asks the server to restart or stop over an IPC channel rather than with signals, so it drains the same way on Windows, where a signal kills the process outright. If `bun dev` itself is killed, the server stops the way Ctrl-C does once that channel closes, and Vite stops once it sees `bun dev` gone. Saves close together, or made while it drains, fold into one restart. If the server fails to start or crashes, `bun dev` waits for your next save instead of looping. Ctrl-C stops everything the same graceful way; a second Ctrl-C stops at once. After that second Ctrl-C your shell prompt can come back a moment before the server's last line ("Stopped. 1 image will run again when Openfield starts."): the `bun run` wrapper exits at once, and there's nothing a script can do about that. When to restart is decided in `scripts/dev-supervisor.ts`, which has its own tests; `scripts/dev.test.ts` runs `bun dev` itself on ports of its own (`OPENFIELD_VITE_PORT`) and watching a scratch folder (`OPENFIELD_DEV_WATCH`), so it runs beside your own `bun dev`.

`bun start` runs the server as the root script's own command. Keep it that way: `bun --filter` and a nested `bun run` both exit on the first Ctrl-C and leave the server draining where you can't see it or stop it. `apps/server/test/process.test.ts` runs `bun start` in its own process group, the way a terminal does, to catch that.

With `OPENFIELD_FAKE_PROVIDERS=1` every model call is answered on your computer, so you need no real key and spend nothing: paste any text as the key in **Settings > API keys**, as long as it doesn't contain "invalid". A `#fake:<scenario>` tag in a prompt (for example `#fake:rate_limited`) plays back that failure. The scenario names are `FAKE_SCENARIOS` in `packages/providers/src/testing/types.ts`, with underscores; the README lists them, including the ones for speeds (`#fake:flex_busy`, `#fake:batch_slow`, …) and restarts. Fake runs are logged at $0 and never count toward "Spent today". `OPENFIELD_HOME` keeps your dev data away from your real library. Drop both to test against the real APIs with your own key.

To try restarts by hand: send a Google image tagged `#fake:slow` and one to the Resumable test model tagged `#fake:resume_slow` (it exists only in fake mode; any key works), then save a server file, press Ctrl-C, or `kill -9` the server and save a file to start it again. `OPENFIELD_FAKE_SLOW_MS=8000` makes both take 8 seconds instead of 30 and 60.

## Layout and import rules

| Workspace | Owns | May import |
|---|---|---|
| `apps/web` | The React app | `core`, `ui`, `@openfield/providers/manifest`, and the `AppType` type from `@openfield/server/app-type` |
| `apps/server` | Hono server, queue, files, keys | `core`, `db`, `@openfield/providers/server`, `@openfield/providers/manifest` |
| `packages/core` | zod schemas, constants, i18n | nothing in the repo (only `zod` and `ulid`) |
| `packages/providers` | Adapters, registry, `estimate()`, `resolveControl()` | `core` |
| `packages/db` | Drizzle schema, migrations, queries | `core` |
| `packages/ui` | Tokens and presentational components | `core` (types and `t()` only) |

The rules behind the table:

1. No package imports an app. The web app's only link to the server is a type-only import of `AppType`.
2. The browser never loads server code: no `@openfield/db`, no `@openfield/providers/server`, no adapter folder, no `bun:` or `node:` module, nothing that reads keys or env vars.
3. `@openfield/providers` has two entries. `/manifest` is browser-safe. `/server` holds the registry and the adapters. An adapter imports only `../types`, its own folder and `@openfield/core`, never another adapter.
4. Only `apps/server` imports `packages/db`, and SQL lives only in `packages/db`.
5. `packages/core` is a leaf that runs in the browser, the server and tests alike.

Biome enforces these per folder (`biome.json`), and `bun run check:bundle` builds the web app and fails if server code or a key-shaped string lands in the bundle, source maps included.

A shape that crosses a boundary (HTTP, SSE, a JSON column, a file) is declared once, as a zod schema in `packages/core/src/schemas/`, and its type is inferred from it. Enums are `as const` arrays in `packages/core/src/constants.ts`. The Drizzle schema in `packages/db/src/schema/` is the source of truth for tables; after changing it run `bun run db:generate` and commit the SQL with it.

## Code style

- `bun run format` formats and applies Biome's safe fixes, import order included. `bun run lint` must pass.
- TypeScript is strict. Avoid `any`; prefer a zod schema at the edge and inferred types inside.
- Comments explain why, not what. One short line where possible, no banner blocks. A pointer like `// §0.12` is welcome when it saves a contributor a search.
- Colours come from the `--of-*` tokens in `packages/ui`. Never write a raw hex or rgba value.
- Avoid new dependencies. If one is truly needed, pin the exact version and explain why in the pull request.

## UI copy

Every word a person sees follows section 0.15 of the spec. The short version:

- Plain, short and human. Say what happened, then what the person can do.
- Sentence case. No exclamation marks, no filler ("simply", "just"), no marketing tone.
- Never an em dash. Use a period, a comma or a colon.
- No internal words. Say "model", not provider, adapter or endpoint. Say "key", not token or credential. Say "settings", not params, manifest or capability. Say "run", not job or job set.
- No file paths, permissions or env var names in the UI. "Your key stays on this computer." is the tone.
- A failed action offers **Try again**, never "Retry".
- Nothing unshipped is teased. No "coming soon".
- Costs read "About $0.16" (or "~$0.16" where space is tight), and "Cost unknown" when there is no price.

Every string goes in `packages/core/src/i18n/en.json` and is read through `t()`, with no string concatenation.

## Tests

```sh
bun test                                     # unit tests, db schema check, offline conformance
bun test packages/providers/conformance      # adapter conformance, offline, against fixtures
bunx playwright install chromium             # once
bun run e2e                                  # end-to-end, fake models, no keys needed
```

Add or update tests with every change. Adapter changes need fixtures and a passing conformance run. Each e2e suite gets its own server on a free port with a throwaway library (`e2e/serve.ts`); `restartServer()` in `e2e/support.ts` restarts it mid-test on the same library, for runs that must survive a restart, such as Batch. It stops the server gracefully, or with `{ crash: true }` kills it with SIGKILL (`e2e/resume.e2e.ts`). `apps/server/test/process.test.ts` does the same with the real process, for what it prints on the way down. Live conformance (`OPENFIELD_CONFORMANCE=live`) uses real keys and costs money, so it runs only before a release, never in CI.

Before you open a pull request, run what CI runs:

```sh
bun run lint && bun run typecheck && bun test && bun run build && bun run check:bundle
```

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`.

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- Scopes: `web`, `server`, `core`, `providers`, `db`, `ui`, `e2e`, or the adapter name, for example `feat(google): read the image size from the response`.
- Keep the summary short and in the imperative. Put the why in the body.

Keep pull requests focused on one change. Link the issue, describe what changed and how you tested it, and add a screenshot for anything visible. The template has a checklist.

## Proposing a provider

Open a **New provider** issue first, with a link to the company's public API docs and pricing. A provider is a good fit when its API is public, takes a key the person owns, and its terms allow this use. Then follow [docs/adding-a-provider.md](docs/adding-a-provider.md). Adapters are built into the repo: adding one is a pull request, and there is no plugin loading.

## Security

Don't report security problems in public issues. See [SECURITY.md](SECURITY.md).

## Conduct and license

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree that your work is released under the [MIT License](LICENSE).
