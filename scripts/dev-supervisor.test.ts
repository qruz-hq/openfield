import { describe, expect, test } from "bun:test";
import { ignored, ServerSupervisor, type StopKind } from "./dev-supervisor";

// bun dev's restarts (§0.16), with a pretend server: each start is a promise that settles when the
// test says the server exited, and each stop is recorded.

const DEBOUNCE_MS = 20;

function harness(opts: { drainMs?: number } = {}) {
  const stops: StopKind[] = [];
  const lines: string[] = [];
  let starts = 0;
  let exit: (() => void) | undefined;
  const supervisor = new ServerSupervisor({
    debounceMs: DEBOUNCE_MS,
    start: () => {
      starts++;
      return new Promise<void>((resolve) => {
        exit = () => {
          exit = undefined;
          resolve();
        };
      });
    },
    stop: (kind) => {
      if (!exit) return false;
      stops.push(kind);
      // A drain takes a while, then the server exits on its own.
      const done = exit;
      if (kind === "now") done();
      else setTimeout(done, opts.drainMs ?? 50);
      return true;
    },
    alive: () => exit !== undefined,
    say: (line) => lines.push(line),
  });
  const running = supervisor.run();
  return {
    supervisor,
    running,
    stops,
    lines,
    starts: () => starts,
    /** The server stops on its own: a failed start or a crash. */
    crash: () => exit?.(),
  };
}

const wait = (ms: number) => Bun.sleep(ms);

describe("bun dev restarts", () => {
  test("saves close together restart the server once, after they go quiet", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.supervisor.changed("apps/server/src/app.ts");
      await wait(5);
    }
    expect(h.stops).toEqual([]);
    await wait(DEBOUNCE_MS + 10);
    expect(h.stops).toEqual(["restart"]);
    expect(h.lines).toEqual(["Restarting the server."]);
    await wait(80);
    expect(h.starts()).toBe(2);
    expect(h.supervisor.phase).toBe("running");
  });

  test("a save while the server drains folds into the restart under way", async () => {
    const h = harness({ drainMs: 100 });
    h.supervisor.restart();
    await wait(30);
    h.supervisor.changed("packages/core/src/index.ts");
    await wait(DEBOUNCE_MS + 10);
    expect(h.stops).toEqual(["restart"]);
    await wait(100);
    expect(h.starts()).toBe(2);
    expect(h.lines).toEqual(["Restarting the server."]);
  });

  test("a server that stops on its own waits for the next save instead of looping", async () => {
    const h = harness();
    h.crash();
    await wait(10);
    expect(h.supervisor.phase).toBe("down");
    expect(h.lines).toEqual(["The server stopped. It starts again when you save a change."]);
    expect(h.starts()).toBe(1);
    h.supervisor.changed("apps/server/src/app.ts");
    await wait(DEBOUNCE_MS + 10);
    expect(h.starts()).toBe(2);
    expect(h.stops).toEqual([]);
  });

  test("Ctrl-C drains a running server once; a second Ctrl-C stops it now", async () => {
    const h = harness({ drainMs: 1_000 });
    h.supervisor.quit();
    expect(h.stops).toEqual(["quit"]);
    h.supervisor.changed("apps/server/src/app.ts");
    await wait(DEBOUNCE_MS + 10);
    h.supervisor.stopNow();
    expect(h.stops).toEqual(["quit", "now"]);
    await h.running;
    expect(h.starts()).toBe(1);
  });

  test("Ctrl-C during a restart doesn't cut the drain short, and says a second one will", async () => {
    const h = harness({ drainMs: 80 });
    h.supervisor.restart();
    h.supervisor.quit();
    expect(h.stops).toEqual(["restart"]);
    expect(h.lines).toEqual([
      "Restarting the server.",
      "Stopping once the server finishes. Press Ctrl-C again to stop now.",
    ]);
    await h.running;
    // It doesn't start again after the drain.
    expect(h.starts()).toBe(1);
  });

  test("tests, dotfiles, dependencies and editor temp files don't restart it", () => {
    for (const file of [
      "app.test.ts",
      ".DS_Store",
      "runner/.runner.ts.swp",
      "node_modules/x/index.js",
      "4913",
      "app.ts~",
      "#app.ts#",
      "app.ts___jb_tmp___",
      "draft.tmp",
    ]) {
      expect(ignored(file)).toBe(true);
    }
    for (const file of ["app.ts", "runner/runner.ts", "0005_resume.sql", "i18n/en.json"]) {
      expect(ignored(file)).toBe(false);
    }
  });
});
