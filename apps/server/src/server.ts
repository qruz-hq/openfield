import { statSync } from "node:fs";
import { join } from "node:path";
import { type AuthKind, DEFAULT_PORT } from "@openfield/core";
import {
  activeJobSets,
  getProvider,
  type LibraryLock,
  lockLibrary,
  openDb,
  rebuildSearchIndexIfReplaced,
  seedProviders,
} from "@openfield/db";
import {
  builtinProviders,
  createFakeFetch,
  type FetchLike,
  type Provider,
} from "@openfield/providers/server";
import pkg from "../package.json";
import { createApp } from "./app";
import { ConfigStore } from "./config/config-file";
import { ensureLayout, type HomePaths, homePaths, keepFilePrivate, resolveHome } from "./config/home";
import type { Services } from "./context";
import { EventHub } from "./events/hub";
import { Ingest } from "./files/ingest";
import { Thumbs } from "./files/thumbs";
import { mintSessionToken } from "./http/guards";
import { VITE_ORIGIN } from "./http/spa";
import { consoleSink, createJobLog, fileSink, Logger, RollingFile } from "./log/logger";
import { toJobSetWithJobs } from "./mappers/job";
import { CallContexts } from "./runner/provider-fetch";
import { recover } from "./runner/recovery";
import { Runner } from "./runner/runner";
import type { QueueOptions } from "./runner/timing";
import { CredentialService } from "./services/credentials";
import { ModelService } from "./services/models";
import { SettingsService } from "./services/settings";

// Boot (§0.16): home folder, lock, config, logs, database, services, crash recovery. Nothing here
// listens on a port, so tests drive the same app through app.request().

export interface ServerOptions {
  /** Defaults to process.env. Tests pass their own so a developer's real keys never leak in. */
  env?: Record<string, string | undefined>;
  /** Proxy the web app from Vite. Default: OPENFIELD_DEV=1. */
  dev?: boolean;
  port?: number;
  /** The HTTP layer adapters see. Default: fixtures when OPENFIELD_FAKE_PROVIDERS=1, else fetch. */
  fetch?: FetchLike;
  providers?: readonly Provider[];
  thumbnails?: "auto" | "off";
  /** Log to the terminal. The log file is always written. */
  console?: boolean;
  queue?: Partial<QueueOptions>;
  /** The built web app. Default: apps/web/dist. */
  webDist?: string | null;
  /** Where the dev proxy finds Vite. */
  viteOrigin?: string;
}

export interface OpenfieldServer {
  app: ReturnType<typeof createApp>;
  services: Services;
  /** Work that shouldn't hold up boot, like the daily model list check. */
  startBackground(): void;
  /** Ends event streams, lets running calls finish for up to `drainMs`, then closes the database. */
  stop(opts?: { drainMs?: number }): Promise<void>;
}

/** Another Openfield already runs on this library folder. */
export class LibraryInUseError extends Error {
  override readonly name = "LibraryInUseError";
  constructor() {
    super(
      "Openfield is already running with this library. Stop it first, or set OPENFIELD_HOME to use another one.",
    );
  }
}

/** Runs at once per company by default (§0.12). */
const DEFAULT_CAPS: Record<string, number> = { openai: 2, google: 4, higgsfield: 2 };
const HOUR = 3_600_000;

export async function createServer(opts: ServerOptions = {}): Promise<OpenfieldServer> {
  const env = opts.env ?? process.env;
  const paths = homePaths(resolveHome(env));
  const { rootModeFixed } = ensureLayout(paths);
  // Before anything reads the database: only the lock holder may recover or schedule runs.
  const lock = lockLibrary(paths.lock);
  if (!lock) throw new LibraryInUseError();
  try {
    return await boot(opts, env, paths, lock, rootModeFixed);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function boot(
  opts: ServerOptions,
  env: Record<string, string | undefined>,
  paths: HomePaths,
  lock: LibraryLock,
  rootModeFixed: boolean,
): Promise<OpenfieldServer> {
  const dev = opts.dev ?? env.OPENFIELD_DEV === "1";
  const config = ConfigStore.open(paths.config, paths.configBackup);

  // The logger needs every loaded key to hide it, and keys load after the database opens.
  let credentials: CredentialService | undefined;
  const logger = new Logger({ secrets: () => credentials?.secrets() ?? [] });
  if (opts.console !== false) logger.addSink(consoleSink());
  logger.addSink(fileSink(new RollingFile(join(paths.logs, "openfield.log"))));
  const jobLog = createJobLog(logger, new RollingFile(join(paths.logs, "jobs.ndjson")));
  const rootFixed = () => logger.warn("The library folder was open to other users. It's private again.");
  if (rootModeFixed) rootFixed();
  config.onRootFixed = rootFixed;
  if (config.modeFixed) logger.warn("config.json was readable by other users. It's private again.");

  const opened = openDb(paths.db);
  const { db } = opened;
  // SQLite makes its -wal and -shm files with the database's mode, so this covers all three.
  keepFilePrivate(paths.db, `${paths.db}-wal`, `${paths.db}-shm`);
  // Still before the listener takes traffic (§8.2.4): a replaced file gets a fresh search index.
  const search = rebuildSearchIndexIfReplaced(db, statSync(paths.db, { bigint: true }).ino.toString());
  if (search.rebuilt && search.previous !== null)
    logger.info("The library was restored or moved, so its search index was rebuilt");
  const settings = new SettingsService(db);
  logger.setLevel(settings.get().logLevel);

  const providers = opts.providers ?? builtinProviders;
  seedProviders(
    db,
    providers.map((p) => ({
      id: p.meta.id,
      displayName: p.meta.displayName,
      adapter: p.meta.id,
      authKind: authKindOf(p),
      concurrencyCap: DEFAULT_CAPS[p.meta.id] ?? 2,
    })),
  );
  credentials = new CredentialService(providers, config, env, db);
  credentials.sync();

  const fake = env.OPENFIELD_FAKE_PROVIDERS === "1";
  const baseFetch: FetchLike = opts.fetch ?? (fake ? createFakeFetch() : (input, init) => fetch(input, init));
  if (fake && !opts.fetch)
    logger.warn(
      'Fake models are on. Nothing goes to a real company and nothing is billed. Any key works, except one containing "invalid".',
    );

  const ingest = new Ingest(paths, db);
  const thumbs = await Thumbs.create({
    paths,
    logger,
    quality: () => settings.get().thumbQuality,
    disabled: opts.thumbnails === "off" || env.OPENFIELD_THUMBNAILS === "off",
  });
  const contexts = new CallContexts(
    baseFetch,
    credentials,
    logger,
    (id) => getProvider(db, id)?.enabled !== false,
  );
  const events = new EventHub({
    snapshot: () => activeJobSets(db).map(toJobSetWithJobs),
    onInvalid: (event, issue) => logger.warn("An event didn't match its schema", { event, issue }),
  });
  const models = new ModelService({
    providers,
    db,
    credentials,
    settings,
    events,
    logger,
    contexts,
    ingest,
    modelsJson: paths.modelsJson,
  });
  models.init();
  const runner = new Runner({
    db,
    models,
    credentials,
    settings,
    events,
    ingest,
    thumbs,
    contexts,
    logger,
    jobLog,
    ...(opts.queue && { options: opts.queue }),
  });

  // Before the listener takes traffic (§8.4.5).
  const recovery = recover(db, paths);
  jobLog({ event: "startup.recovery", ...recovery });
  if (recovery.interrupted)
    logger.info(`${recovery.interrupted} image(s) were interrupted when Openfield last stopped`);
  if (recovery.missingFiles)
    logger.warn(`${recovery.missingFiles} image file(s) are missing from the library folder`);
  runner.start();

  settings.onChange((next, changed) => {
    if (changed.includes("logLevel")) logger.setLevel(next.logLevel);
    if (changed.includes("globalConcurrency")) runner.tick();
  });

  const services: Services = {
    version: pkg.version,
    port: opts.port ?? portFrom(env) ?? config.data.port ?? DEFAULT_PORT,
    dev,
    token: mintSessionToken(),
    paths,
    config,
    logger,
    db,
    schemaTag: opened.schemaTag,
    providers,
    settings,
    credentials,
    contexts,
    models,
    events,
    ingest,
    thumbs,
    runner,
    viteOrigin: opts.viteOrigin ?? VITE_ORIGIN,
    webDist:
      opts.webDist === undefined
        ? (env.OPENFIELD_WEB_DIST ?? join(import.meta.dir, "../../web/dist"))
        : opts.webDist,
  };
  const app = createApp(services);
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  return {
    app,
    services,
    startBackground() {
      void models.refreshIfStale();
      refreshTimer = setInterval(() => void models.refreshIfStale(), HOUR);
      refreshTimer.unref?.();
    },
    async stop({ drainMs = 10_000 } = {}) {
      if (refreshTimer) clearInterval(refreshTimer);
      events.close();
      await runner.stop(drainMs);
      await thumbs.idle();
      opened.close();
      lock.release();
    },
  };
}

function authKindOf(provider: Provider): AuthKind {
  const required = provider.credentials.fields.filter((f) => f.required);
  if (required.length === 0) return "none";
  return required.length > 1 ? "key_secret_pair" : "api_key";
}

function portFrom(env: Record<string, string | undefined>): number | undefined {
  const port = Number(env.OPENFIELD_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
