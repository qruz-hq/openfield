// The desktop app (apps/desktop) runs this server as a compiled sidecar with OPENFIELD_DESKTOP=1.
// It can't read a terminal or send a signal Windows would honour, so the two talk in lines: the
// server prints OPENFIELD_READY or OPENFIELD_ERROR with JSON on stdout, and the app writes `quit`
// or `now` on the server's stdin. Nothing here changes `bun start` or `bun dev`.

type Env = Record<string, string | undefined>;

export const isDesktop = (env: Env = process.env): boolean => env.OPENFIELD_DESKTOP === "1";

/**
 * True inside a `bun build --compile` binary, where this file lives in Bun's embedded file system
 * (`/$bunfs/root` on macOS and Linux, `B:\~BUN\root` on Windows) instead of a checkout.
 */
export function isCompiled(dir: string = import.meta.dir): boolean {
  return dir.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(dir);
}

export type DesktopErrorCode = "port_in_use" | "library_in_use" | "start_failed";

export function readyLine(port: number): string {
  return `OPENFIELD_READY ${JSON.stringify({ port, url: `http://127.0.0.1:${port}` })}`;
}

export function errorLine(code: DesktopErrorCode, message: string): string {
  return `OPENFIELD_ERROR ${JSON.stringify({ code, message })}`;
}

/** What the app shows when the server can't start, in words for the person using it. */
export const desktopCopy = {
  portInUse: (port: number) =>
    `Another app is using port ${port}, which Openfield needs. If Openfield is running in a terminal, stop it there, then open the app again.`,
  libraryInUse:
    "Openfield is already open with your library, maybe in a terminal. Stop it there, then open the app again.",
  startFailed: (reason: string) => `Openfield couldn't start. ${reason}`,
} as const;

/** `quit` drains like a first Ctrl-C; `now` stops at once like a second. */
export type ControlCommand = "quit" | "now";

/** Splits stdin into lines and keeps the ones that are commands. Anything else is ignored. */
export class ControlReader {
  #pending = "";

  push(chunk: string): ControlCommand[] {
    this.#pending += chunk;
    const lines = this.#pending.split(/\r?\n/);
    this.#pending = lines.pop() ?? "";
    // A runaway line without a newline must not grow forever.
    if (this.#pending.length > 1024) this.#pending = "";
    return lines.flatMap((line) => {
      const word = line.trim();
      return word === "quit" || word === "now" ? [word] : [];
    });
  }
}

/**
 * Listens for the app's commands. The end of stdin means the app is gone (it crashed or was
 * killed), which is a `quit`: the library and the port must be free for the next start.
 */
export function listenForControl(stream: NodeJS.ReadableStream, on: (command: ControlCommand) => void): void {
  const reader = new ControlReader();
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const command of reader.push(text)) on(command);
  });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    on("quit");
  };
  stream.on("end", end);
  stream.on("close", end);
  stream.on("error", end);
  stream.resume?.();
}
