import { MAX_REQUEST_BYTES } from "./app";
import { desktopCopy, errorLine, isDesktop, listenForControl, readyLine } from "./desktop";
import { images } from "./log/plural";
import type { DrainNotice, StopReport } from "./runner/runner";
import { createServer, LibraryInUseError } from "./server";

// Runs the server until it's stopped: `bun start` and `bun dev` (through index.ts) and the desktop
// app's compiled sidecar (through bin.ts) all land here. Binds 127.0.0.1 only, never 0.0.0.0 (§6.11).

/**
 * A line for the terminal before the server (and its logger) exists. One that closed (a hangup)
 * can't take it, and that must never stop anything.
 */
function say(line: string, to: "out" | "err" = "out") {
  try {
    if (to === "err") console.error(line);
    else console.log(line);
  } catch {
    // Nobody is there to read it.
  }
}

/** A second signal counts only this long after the first: `bun run` passes on a copy within a few ms. */
const SECOND_SIGNAL_MS = 150;

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runServer(): Promise<void> {
  for (const stream of [process.stdout, process.stderr]) stream.on?.("error", () => {});
  // The desktop app reads its own lines on stdout, beside the ones for a terminal.
  const desktop = isDesktop();

  const server = await createServer().catch((err: unknown) => {
    if (err instanceof LibraryInUseError) say(err.message, "err");
    else say(`Openfield couldn't start. ${reasonOf(err)}`, "err");
    if (desktop) {
      say(
        err instanceof LibraryInUseError
          ? errorLine("library_in_use", desktopCopy.libraryInUse)
          : errorLine("start_failed", desktopCopy.startFailed(reasonOf(err))),
      );
    }
    process.exit(1);
  });
  const { port, dev } = server.services;

  let http: ReturnType<typeof Bun.serve>;
  try {
    // Long enough for the event stream's 15 s heartbeat.
    http = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: server.app.fetch,
      idleTimeout: 60,
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
  } catch (err) {
    const inUse = (err as { code?: string }).code === "EADDRINUSE";
    say(
      inUse
        ? `Port ${port} is already in use. Is Openfield already running? Set OPENFIELD_PORT to use another port.`
        : `Openfield couldn't start. ${reasonOf(err)}`,
      "err",
    );
    if (desktop) {
      say(
        inUse
          ? errorLine("port_in_use", desktopCopy.portInUse(port))
          : errorLine("start_failed", desktopCopy.startFailed(reasonOf(err))),
      );
    }
    // Nothing was sent yet (the queue starts below), so this only closes the library.
    await server.stop();
    process.exit(1);
  }

  // Stopping drains (§0.12): Ctrl-C, SIGTERM, a closed terminal (SIGHUP), a dev restart and the
  // desktop app's `quit` let images that can't pick up where they left off finish, and leave the
  // ones that can at the company. A second signal, or `now`, stops at once.

  let stoppingSince = 0;
  let forced = false;

  /** The line for the terminal and the log file (logs/openfield.log), so a stop leaves a record. */
  function announce(line: string) {
    server.services.logger.announce(line);
  }

  /** `restart`: bun dev restarting the server after a save. */
  async function shutdown(why: "stop" | "restart" = "stop") {
    if (stoppingSince) return;
    stoppingSince = Date.now();
    server.services.events.close();
    // No new connections from here. Requests already in flight get a moment to finish.
    const closing = Promise.race([http.stop(), Bun.sleep(3_000)]);
    const report = await server.stop({
      closing,
      onDrain: (notice) => {
        const line = drainLine(notice, why, desktop);
        if (line) announce(line);
      },
    });
    void http.stop(true);
    for (const line of stopLines(report, forced)) announce(line);
    process.exit(forced ? 1 : 0);
  }

  /** A second Ctrl-C: every call is cut off, and the process exits. */
  function stopNow() {
    if (!stoppingSince || forced) return;
    forced = true;
    server.forceStop();
    // The stop under way ends within a few seconds; this is only in case it can't.
    setTimeout(() => process.exit(1), 5_000);
  }

  function onSignal() {
    if (stoppingSince === 0) void shutdown();
    else if (Date.now() - stoppingSince >= SECOND_SIGNAL_MS) stopNow();
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);

  // bun dev asks over its IPC channel instead of with signals, because a signal on Windows kills the
  // process outright (§0.16). Each message is sent once, so none is taken for a copy.
  if (dev && process.send) {
    process.on("message", (message: unknown) => {
      const ask = (message as { openfield?: unknown } | null)?.openfield;
      if (ask === "restart") void shutdown("restart");
      else if (ask === "quit") void shutdown();
      else if (ask === "now") stopNow();
    });
    // bun dev went away without stopping this server (it was killed): stop the way Ctrl-C does, so
    // the port and the library are free for the next bun dev.
    process.on("disconnect", () => void shutdown());
  }

  // The desktop app asks on stdin for the same reason. A `now` with no `quit` before it starts the
  // stop and cuts it short at once.
  if (desktop) {
    listenForControl(process.stdin, (command) => {
      if (command === "quit") void shutdown();
      else {
        void shutdown();
        stopNow();
      }
    });
  }

  // Announced last, once every way to stop is in place: whoever reads the line may stop the server
  // straight away, and a signal that arrives before its handler would kill it without a drain.
  say(`\nOpenfield is running at http://127.0.0.1:${port}${dev ? " (dev)" : ""}\n`);
  if (desktop) say(readyLine(port));
  // Only now that the port is ours: a start that couldn't listen must not send, or cut off, a call.
  server.start();
  server.startBackground();
}

/** What the drain waits for, in the order §0.12 gives it. Nothing when it has nothing to wait for. */
function drainLine(notice: DrainNotice, why: "stop" | "restart", desktop: boolean): string | undefined {
  const company = notice.companies.length === 1 ? notice.companies[0] : "each company";
  const parts = [
    ...(notice.finishing ? [`Finishing ${images(notice.finishing)}`] : []),
    ...(notice.confirming ? [`Waiting for ${company} to confirm ${images(notice.confirming)}`] : []),
    ...(notice.stopping ? [`Asking ${company} to stop ${images(notice.stopping)}`] : []),
  ];
  if (parts.length === 0) return undefined;
  // Nobody pressed Ctrl-C for a restart, and Ctrl-C then stops bun dev, so it isn't offered. The
  // listener is closed while it waits, so the app is away until the new server starts.
  if (why === "restart") return `${parts.join(". ")} before restarting. The app is back after that.`;
  // The desktop app has no Ctrl-C to offer: it asks the person itself.
  if (desktop) return `${parts.join(". ")}.`;
  return `${parts.join(". ")}. Press Ctrl-C again to stop now.`;
}

/** The last lines, in the order §0.12 gives them. */
function stopLines(report: StopReport, forced: boolean): string[] {
  const lines: string[] = [];
  if (forced) {
    const { rerun, interrupted } = report.cut;
    const parts = [
      ...(rerun ? [`${images(rerun)} will run again when Openfield starts.`] : []),
      ...(interrupted ? [`${images(interrupted)} ${interrupted === 1 ? "was" : "were"} interrupted.`] : []),
    ];
    lines.push(["Stopped.", ...parts].join(" "));
  }
  if (report.left) {
    const they = report.left === 1 ? "it" : "they";
    lines.push(`${images(report.left)} will pick up where ${they} left off next time.`);
  }
  if (!forced) lines.push("Openfield stopped.");
  return lines;
}
