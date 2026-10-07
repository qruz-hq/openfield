import { accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentLaunch, type AuthKind, DEFAULT_PORT } from "@openfield/core";
import {
  activeJobSets,
  getProvider,
  type LibraryLock,
  lockLibrary,
  openDb,
  rebuildSearchIndexIfReplaced,
  seedProviders,
} from "@openfield/db";
import { createFakeFetch, type FetchLike, type Provider, providersFor } from "@openfield/providers/server";
// The app's version lives in the root package.json; the desktop app reads the same one.
import pkg from "../../../package.json";
import { createApp } from "./app";
import { CanvasService } from "./canvas/canvases";
import { serverEngineContext } from "./canvas/engine-context";
import { CanvasRunService } from "./canvas/runs";
import { ConfigStore } from "./config/config-file";
import { ensureLayout, type HomePaths, homePaths, keepFilePrivate, resolveHome } from "./config/home";
import type { Services } from "./context";
import { isCompiled, isDesktop } from "./desktop";
import { EventHub } from "./events/hub";
import { Ingest } from "./files/ingest";
import { Thumbs } from "./files/thumbs";
import { mintSessionToken } from "./http/guards";
import { VITE_ORIGIN } from "./http/spa";
import { consoleSink, createJobLog, fileSink, Logger, RollingFile } from "./log/logger";
import { images } from "./log/plural";
import { McpSessions } from "./mcp/sessions";
import { CallContexts } from "./runner/provider-fetch";
import { type RecoveryReport, recover } from "./runner/recovery";
import { Runner, type StopOptions, type StopReport } from "./runner/runner";
import type { QueueOptions } from "./runner/timing";
import { AgentService } from "./services/agents";
import { CredentialService } from "./services/credentials";
import { batchSnapshot, jobSetViews, markAnnounced } from "./services/job-sets";
import { LibraryService } from "./services/library";
import { ModelService } from "./services/models";
import { PresenceService } from "./services/presence";
import { defaultCap, ProviderSettingsService } from "./services/provider-settings";
import { providerSummaries } from "./services/provider-summaries";
import { RemotePrices } from "./services/remote-prices";
import { SettingsService } from "./services/settings";

// Boot (§0.16): home folder, lock, config, logs, database, services, crash recovery. Nothing here
// listens on a port, so tests drive the same app through app.request(). Nothing here sends a call
// either: start() does, once the caller has its port, so a start that can't listen never cuts off
// the calls it would have sent (§8.4.5).

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
  /**
   * Starts the queue: says what recovery did, picks up resumed calls by id, then sends waiting
   * runs. Call it once the listener is bound (§8.4.5). Safe to call twice.
   */
  start(): void;
  /** Work that shouldn't hold up boot, like the daily model list check. */
  startBackground(): void;
  /**
   * Ends event streams and drains the runner (§0.12): calls that can't resume finish, resumable ones
   * are left at the company. Then waits for `closing` (the listener) and closes the database.
   */
  stop(opts?: StopOptions & { closing?: Promise<unknown> }): Promise<StopReport>;
  /** A second Ctrl-C: cuts the drain short. The stop() under way then resolves. */
  forceStop(): void;
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

const HOUR = 3_600_000;

export async function createServer(opts: ServerOptions = {}): Promise<OpenfieldServer> {
  const env = opts.env ?? process.env;
  const paths = homePaths(resolveHome(env));
  const { rootModeFixed } = ensureLayout(paths);
  // Before anything reads the database: only the lock holder may recover or schedule runs.
  const lock = lockLibrary(paths.lock);
  if (!lock) throw new LibraryInUseError();
  // What a boot that fails part way has opened, closed in reverse. Nothing has been sent by then.
  const undo: (() => void)[] = [];
  try {
    return await boot(opts, env, paths, lock, rootModeFixed, undo);
  } catch (error) {
    for (const step of undo.reverse()) step();
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
  undo: (() => void)[],
): Promise<OpenfieldServer> {
  const dev = opts.dev ?? env.OPENFIELD_DEV === "1";
  const config = ConfigStore.open(paths.config, paths.configBackup);

  // The logger needs every loaded key to hide it, and keys load after the database opens.
  let credentials: CredentialService | undefined;
  let agents: AgentService | undefined;
  const logger = new Logger({
    secrets: () => [...(credentials?.secrets() ?? []), ...(agents?.secrets() ?? [])],
  });
  if (opts.console !== false) logger.addSink(consoleSink());
  logger.addSink(fileSink(new RollingFile(join(paths.logs, "openfield.log"))));
  const jobLog = createJobLog(logger, new RollingFile(join(paths.logs, "jobs.ndjson")));
  const rootFixed = () => logger.warn("The library folder was open to other users. It's private again.");
  if (rootModeFixed) rootFixed();
  config.onRootFixed = rootFixed;
  if (config.modeFixed) logger.warn("config.json was readable by other users. It's private again.");

  const opened = openDb(paths.db);
  undo.push(() => opened.close());
  const { db } = opened;
  // SQLite makes its -wal and -shm files with the database's mode, so this covers all three.
  keepFilePrivate(paths.db, `${paths.db}-wal`, `${paths.db}-shm`);
  // Still before the listener takes traffic (§8.2.4): a replaced file gets a fresh search index.
  const search = rebuildSearchIndexIfReplaced(db, statSync(paths.db, { bigint: true }).ino.toString());
  if (search.rebuilt && search.previous !== null)
    logger.info("The library was restored or moved, so its search index was rebuilt");
  const settings = new SettingsService(db);
  logger.setLevel(settings.get().logLevel);

  const fake = env.OPENFIELD_FAKE_PROVIDERS === "1";
  // Fake mode adds the test company, whose model resumes after a restart (§6.12).
  const providers = opts.providers ?? providersFor({ fake });
  seedProviders(
    db,
    providers.map((p) => ({
      id: p.meta.id,
      displayName: p.meta.displayName,
      adapter: p.meta.id,
      authKind: authKindOf(p),
      concurrencyCap: defaultCap(p.meta.id),
    })),
  );
  credentials = new CredentialService(providers, config, env, db);
  credentials.sync();

  const baseFetch: FetchLike =
    opts.fetch ?? (fake ? createFakeFetch(fakeOptions(env)) : (input, init) => fetch(input, init));
  if (fake && !opts.fetch)
    logger.warn(
      'Fake models are on. Nothing goes to a real company and nothing is billed. Any key works, except one containing "invalid".',
    );

  const ingest = new Ingest(paths, db, ffmpegOption(env));
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
    snapshot: () => ({ activeJobSets: jobSetViews(db, activeJobSets(db)), batches: batchSnapshot(db) }),
    // A finished Batch run is announced once, to the first tab that hears about it (§2.4).
    onSnapshotSent: (snapshot) => markAnnounced(db, snapshot.batches),
    onInvalid: (event, issue) => logger.warn("An event didn't match its schema", { event, issue }),
  });
  const providerSettings = new ProviderSettingsService(db, providers, logger);
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
  const prices = new RemotePrices({ models, contexts, ingest, providerSettings, logger });
  const runner = new Runner({
    db,
    models,
    prices,
    credentials,
    settings,
    providerSettings,
    fake,
    events,
    ingest,
    thumbs,
    contexts,
    logger,
    jobLog,
    options: { ...videoDeadline(env), ...opts.queue },
  });

  // Before the listener takes traffic (§8.4.5). The setting is read once, here. It only moves jobs
  // to where the next start would put them anyway, so a start that then can't listen loses nothing.
  const recovery = recover(db, paths, {
    rerunInterrupted: settings.get().rerunInterrupted,
    simulated: fake,
    idempotentSubmit: (key) => models.get(key)?.idempotentSubmit === true,
  });
  jobLog({ event: "startup.recovery", ...recovery });
  const library = new LibraryService({ db, paths, events, logger, settings });
  const engineContext = () =>
    serverEngineContext({ db, providers, credentials, models, settings, providerSettings });
  const canvases = new CanvasService({
    db,
    paths,
    models,
    settings,
    logger,
    events,
    engineContext,
    // canvasRuns is made below; this is only called once both exist.
    busyNodes: (canvasId) => canvasRuns.busyNodes(canvasId),
  });
  // After the runner's pass, so each node's jobs already sit where §0.4's restart rules put them:
  // picked up by id, waiting to run again once, or interrupted. Settled nodes' results go into the
  // saved canvas, so one closed during the run opens with them. Launches recorded but never created
  // become job sets here; like everything else, they wait for start() to be sent.
  const canvasRuns = new CanvasRunService({
    db,
    runner,
    models,
    prices,
    credentials,
    providerSettings,
    events,
    logger,
    writeResults: (canvasId, nodes, at) => canvases.writeRunResults(canvasId, nodes, at),
    engineContext,
    providerSummaries: () => providerSummaries({ db, providers, credentials }),
    saveAgentVersion: (canvasId, actor) => canvases.saveAgentVersion(canvasId, actor),
  });
  const presence = new PresenceService(events);
  canvasRuns.start();
  undo.push(() => canvasRuns.stop());
  const resumedRuns = await canvasRuns.recover();
  if (resumedRuns) jobLog({ event: "startup.canvas_runs", resumed: resumedRuns });

  const port = opts.port ?? portFrom(env) ?? config.data.port ?? DEFAULT_PORT;
  agents = new AgentService({
    config,
    db,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    launch: agentLaunch({ paths, port, configuredPort: config.data.port ?? DEFAULT_PORT, env }),
    events,
  });
  const mcp = new McpSessions(() => services);

  settings.onChange((next, changed) => {
    if (changed.includes("logLevel")) logger.setLevel(next.logLevel);
    if (changed.includes("globalConcurrency")) runner.tick();
  });

  const services: Services = {
    version: pkg.version,
    port,
    dev,
    token: mintSessionToken(),
    paths,
    config,
    logger,
    db,
    schemaTag: opened.schemaTag,
    providers,
    settings,
    providerSettings,
    credentials,
    contexts,
    models,
    prices,
    events,
    ingest,
    thumbs,
    library,
    runner,
    canvases,
    canvasRuns,
    presence,
    fake,
    agents,
    mcp,
    viteOrigin: opts.viteOrigin ?? viteOriginFrom(env),
    webDist:
      opts.webDist === undefined
        ? (env.OPENFIELD_WEB_DIST ?? join(import.meta.dir, "../../web/dist"))
        : opts.webDist,
  };
  const app = createApp(services);
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let stopRetention: (() => void) | undefined;
  let stopped: Promise<StopReport> | undefined;
  const stop = async ({ closing, ...drain }: StopOptions & { closing?: Promise<unknown> }) => {
    if (refreshTimer) clearInterval(refreshTimer);
    stopRetention?.();
    // Canvas runs stop moving on first, so the drain sends nothing new. Calls it lets finish are
    // saved as usual, and the next start's recovery brings their nodes up to date.
    canvasRuns.stop();
    mcp.stop();
    events.close();
    const report = await runner.stop(drain);
    await thumbs.idle();
    await closing;
    opened.close();
    lock.release();
    return report;
  };

  let started = false;
  return {
    app,
    services,
    start() {
      if (started) return;
      started = true;
      for (const line of recoveryLines(recovery)) logger.announce(line);
      if (recovery.missingFiles)
        logger.warn(`${recovery.missingFiles} image file(s) are missing from the library folder`);
      // Its first pass picks up resumed calls by id, before anything new is sent (§0.12).
      runner.start();
    },
    startBackground() {
      void models.refreshIfStale();
      refreshTimer = setInterval(() => void models.refreshIfStale(), HOUR);
      refreshTimer.unref?.();
      // Only does anything when the person set trashRetentionDays; the default never purges (§8.6).
      stopRetention ??= library.scheduleRetention();
    },
    stop(opts = {}) {
      stopped ??= stop(opts);
      return stopped;
    },
    forceStop() {
      runner.forceStop();
    },
  };
}

/** The boot lines for what recovery did (§8.4.5). Batch runs still at the company count as picked up. */
function recoveryLines(r: RecoveryReport): string[] {
  const lines: string[] = [];
  const resumed = r.resumed + r.batched;
  const picked = [
    ...(resumed ? [`Picking up ${images(resumed)} where ${resumed === 1 ? "it" : "they"} left off.`] : []),
    ...(r.rerun ? [`Running ${images(r.rerun)} again.`] : []),
  ];
  if (picked.length) lines.push(picked.join(" "));
  if (r.interrupted) {
    lines.push(
      `${images(r.interrupted)} ${r.interrupted === 1 ? "was" : "were"} interrupted when Openfield last stopped.`,
    );
  }
  return lines;
}

/**
 * OPENFIELD_FAKE_SLOW_MS sets how long the slow fakes take ("#fake:slow" on Google and
 * "#fake:resume_slow" on the test company), so tests of a stop mid-call run in seconds.
 */
function fakeOptions(env: Record<string, string | undefined>): { slowMs?: number; resumeSlowMs?: number } {
  const slowMs = Number(env.OPENFIELD_FAKE_SLOW_MS);
  return Number.isFinite(slowMs) && slowMs >= 0 && env.OPENFIELD_FAKE_SLOW_MS
    ? { slowMs, resumeSlowMs: slowMs }
    : {};
}

/**
 * OPENFIELD_FFMPEG picks the ffmpeg that takes a video's first frame for its poster: a path, or
 * "off" to use the company's own still. Unset: whatever ffmpeg is on PATH.
 */
function ffmpegOption(env: Record<string, string | undefined>): { ffmpeg?: string | null } {
  const value = env.OPENFIELD_FFMPEG?.trim();
  if (!value) return {};
  return { ffmpeg: value === "off" ? null : value };
}

/** OPENFIELD_VIDEO_DEADLINE_MINUTES: how long a video run may take in all, from 10 minutes to 2 days. */
function videoDeadline(env: Record<string, string | undefined>): { videoJobDeadlineMs?: number } {
  const minutes = Number(env.OPENFIELD_VIDEO_DEADLINE_MINUTES);
  if (!env.OPENFIELD_VIDEO_DEADLINE_MINUTES || !Number.isFinite(minutes)) return {};
  return { videoJobDeadlineMs: Math.min(2_880, Math.max(10, minutes)) * 60_000 };
}

function authKindOf(provider: Provider): AuthKind {
  const required = provider.credentials.fields.filter((f) => f.required);
  if (required.length === 0) return "none";
  return required.length > 1 ? "key_secret_pair" : "api_key";
}

/** OPENFIELD_VITE_PORT moves Vite off 4318, for tests that run bun dev beside a developer's own. */
function viteOriginFrom(env: Record<string, string | undefined>): string {
  const port = Number(env.OPENFIELD_VITE_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : VITE_ORIGIN;
}

/**
 * How an app that can only start programs reaches this server: the stdio bridge. From a checkout
 * it's `bun run mcp`, run by this same bun. In the desktop app it's the installed server binary
 * itself with `mcp`; there's no checkout, and without `mcp` the binary would start a second server.
 * Only what the bridge couldn't find on its own goes in env.
 */
export function agentLaunch(opts: {
  paths: HomePaths;
  port: number;
  configuredPort: number;
  env: Record<string, string | undefined>;
  /** For tests: whether this is the compiled desktop binary. */
  compiled?: boolean;
  execPath?: string;
}): AgentLaunch {
  const env: Record<string, string> = {};
  if (opts.paths.root !== resolveHome({})) env.OPENFIELD_HOME = opts.paths.root;
  if (opts.port !== opts.configuredPort) env.OPENFIELD_PORT = String(opts.port);
  if (isDesktop(opts.env) || (opts.compiled ?? isCompiled())) {
    // The app passes a path that lasts when its own doesn't: the AppImage file, not its mount.
    const command = opts.execPath ?? (opts.env.OPENFIELD_AGENT_COMMAND?.trim() || process.execPath);
    return { command, args: ["mcp"], env, ...(isTemporaryPlace(command) && { temporary: true }) };
  }
  const command = opts.execPath ?? process.execPath;
  return { command, args: ["run", "--silent", "--cwd", REPO_ROOT, "mcp"], env };
}

/**
 * Places an app runs from that vanish later: macOS's randomized copy of an app opened before it
 * was moved (App Translocation), a mounted disk image (read-only, under /Volumes), or an AppImage's
 * mount. A command pointing there breaks after the next quit or eject.
 */
export function isTemporaryPlace(
  path: string,
  writable: (dir: string) => boolean = (dir) => {
    try {
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
): boolean {
  if (path.includes("/AppTranslocation/") || /^\/tmp\/\.mount_/.test(path)) return true;
  return path.startsWith("/Volumes/") && !writable(dirname(path));
}

/** The Openfield checkout this server runs from. */
const REPO_ROOT = join(import.meta.dir, "../../..");

function portFrom(env: Record<string, string | undefined>): number | undefined {
  const port = Number(env.OPENFIELD_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
