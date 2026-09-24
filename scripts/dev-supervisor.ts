// The part of `bun dev` that decides when the server restarts (§0.16), apart from processes and
// signals so it can be tested: saves fold into one restart, a save while the server drains joins
// the restart under way, and a server that stops on its own waits for the next save.

/** How the supervisor asks the running server to stop. Each is one message, sent once. */
export type StopKind =
  /** A save: drain, then a new server starts. */
  | "restart"
  /** Ctrl-C: drain, then bun dev exits. */
  | "quit"
  /** A second Ctrl-C: stop at once. */
  | "now";

export interface SupervisorDeps {
  /** Starts a server and resolves once it has exited. */
  start(): Promise<unknown>;
  /** Asks the running server to stop. False when none is running. */
  stop(kind: StopKind): boolean;
  /** Whether a server is running now. */
  alive(): boolean;
  say(line: string): void;
  /** Quiet time after the last change before restarting, so a save that touches several files restarts once. */
  debounceMs: number;
}

/** Dotfiles, tests, dependencies and editor temp files never restart the server. */
export function ignored(file: string): boolean {
  const parts = file.split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  return (
    parts.includes("node_modules") ||
    parts.some((part) => part.startsWith(".")) ||
    name.endsWith(".test.ts") ||
    // vim (4913, x.swp, x~), emacs (#x#, .#x), JetBrains (x___jb_tmp___) and plain .tmp files.
    /^\d+$|~$|\.sw[a-p]x?$|^#|___jb_(tmp|old)___$|\.tmp$/.test(name)
  );
}

export class ServerSupervisor {
  /** "restarting": asked to stop so a new one can start. "down": exited on its own, waiting for a change. */
  #phase: "running" | "restarting" | "down" = "running";
  #quitting = false;
  #wake: (() => void) | undefined;
  #debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: SupervisorDeps) {}

  get phase(): "running" | "restarting" | "down" {
    return this.#phase;
  }

  /** Runs one server after another until quit(). */
  async run(): Promise<void> {
    for (;;) {
      this.#phase = "running";
      await this.deps.start();
      if (this.#quitting) return;
      // Asked to restart: the old one has let go of the port and the library, so start again. Read
      // through the getter: restart() changes the phase while this awaits.
      if (this.phase === "restarting") continue;
      // It stopped on its own: a failed start (a syntax error, a failed migration) or a crash. It
      // printed why. Starting it again at once would fail the same way, so wait for a fix.
      this.#phase = "down";
      this.deps.say("The server stopped. It starts again when you save a change.");
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
      if (this.#quitting) return;
    }
  }

  /** A watched file changed. */
  changed(file?: string | null): void {
    if (this.#quitting || (file && ignored(file))) return;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => this.restart(), this.deps.debounceMs);
  }

  /** Stops the server gracefully, and starts it again once it has exited. */
  restart(): void {
    if (this.#quitting) return;
    if (this.#phase === "down") {
      this.#wake?.();
      return;
    }
    // Already on its way down: this change folds into the restart under way.
    if (this.#phase === "restarting") return;
    this.#phase = "restarting";
    this.deps.say("Restarting the server.");
    this.deps.stop("restart");
  }

  /** Ctrl-C: nothing restarts from here, and the server drains, however long that takes (§0.12). */
  quit(): void {
    this.#quitting = true;
    clearTimeout(this.#debounce);
    this.#wake?.();
    if (this.#phase === "running") this.deps.stop("quit");
    // Already draining for a restart, which the server finishes before it exits.
    else if (this.#phase === "restarting" && this.deps.alive())
      this.deps.say("Stopping once the server finishes. Press Ctrl-C again to stop now.");
  }

  /** A second Ctrl-C. */
  stopNow(): void {
    this.deps.stop("now");
  }
}
