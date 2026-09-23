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

Open <http://127.0.0.1:4317>. `bun dev` also needs port 5173 free for Vite, so stop any other Vite dev server first.

With `OPENFIELD_FAKE_PROVIDERS=1` every model call is answered on your computer, so you need no real key and spend nothing: paste any text as the key in **Settings > API keys**, as long as it doesn't contain "invalid". A `#fake:<scenario>` tag in a prompt (for example `#fake:rate_limited`) plays back that failure. The scenario names are `FAKE_SCENARIOS` in `packages/providers/src/testing/types.ts`, with underscores; the README lists them. `OPENFIELD_HOME` keeps your dev data away from your real library. Drop both to test against the real APIs with your own key.

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

Add or update tests with every change. Adapter changes need fixtures and a passing conformance run. Live conformance (`OPENFIELD_CONFORMANCE=live`) uses real keys and costs money, so it runs only before a release, never in CI.

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
