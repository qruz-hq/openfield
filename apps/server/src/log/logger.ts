import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import type { LogLevel } from "@openfield/core";
import { type RedactingLogger, redact } from "@openfield/providers/server";

// One logger for the whole server. Every record is scrubbed before any sink sees it, so a key
// can't reach the console, the log files or the error log by any path (§6.11).

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  scope?: string;
  data?: unknown;
}

export interface LogSink {
  write(record: LogRecord): void;
}

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LoggerOptions {
  /** Every key currently loaded, from the environment or config.json. */
  secrets: () => readonly string[];
  level?: LogLevel;
}

export class Logger {
  readonly #sinks: LogSink[] = [];
  readonly #secrets: () => readonly string[];
  #level: LogLevel;

  constructor(opts: LoggerOptions) {
    this.#secrets = opts.secrets;
    this.#level = opts.level ?? "info";
  }

  addSink(sink: LogSink): void {
    this.#sinks.push(sink);
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  scrub<T>(value: T): T {
    return redact(value, this.#secrets());
  }

  log(level: LogLevel, msg: string, data?: unknown, scope?: string): void {
    if (RANK[level] > RANK[this.#level]) return;
    const record = this.scrub<LogRecord>({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(scope && { scope }),
      ...(data !== undefined && { data }),
    });
    for (const sink of this.#sinks) {
      try {
        sink.write(record);
      } catch {
        // A full disk or a closed stream must never take a request down with it.
      }
    }
  }

  debug = (msg: string, data?: unknown) => this.log("debug", msg, data);
  info = (msg: string, data?: unknown) => this.log("info", msg, data);
  warn = (msg: string, data?: unknown) => this.log("warn", msg, data);
  error = (msg: string, data?: unknown) => this.log("error", msg, data);

  /** The adapter-facing logger (§6.2), tagged with where the line came from. */
  scoped(scope: string): RedactingLogger {
    return {
      debug: (msg, data) => this.log("debug", msg, data, scope),
      info: (msg, data) => this.log("info", msg, data, scope),
      warn: (msg, data) => this.log("warn", msg, data, scope),
      error: (msg, data) => this.log("error", msg, data, scope),
      scrub: (value) => this.scrub(value),
    };
  }
}

/** Human-readable lines for the terminal. Errors go to stderr. */
export function consoleSink(): LogSink {
  return {
    write(record) {
      const scope = record.scope ? ` [${record.scope}]` : "";
      const data = record.data === undefined ? "" : ` ${JSON.stringify(record.data)}`;
      const line = `${record.level.padEnd(5)}${scope} ${record.msg}${data}`;
      if (record.level === "error" || record.level === "warn") console.error(line);
      else console.log(line);
    },
  };
}

/** Appends JSON lines and rolls over at `maxBytes`, keeping `keep` old files (§8.1: 10 MB × 5). */
export class RollingFile {
  #size: number;

  constructor(
    readonly file: string,
    readonly maxBytes = 10 * 1024 * 1024,
    readonly keep = 5,
  ) {
    this.#size = existsSync(file) ? statSync(file).size : 0;
  }

  append(line: string): void {
    const bytes = Buffer.byteLength(line) + 1;
    if (this.#size > 0 && this.#size + bytes > this.maxBytes) this.#roll();
    appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    this.#size += bytes;
  }

  #roll(): void {
    rmSync(`${this.file}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
    this.#size = 0;
  }
}

export function fileSink(file: RollingFile): LogSink {
  return { write: (record) => file.append(JSON.stringify(record)) };
}

/**
 * logs/jobs.ndjson: one line per job transition, for post-mortems. Scrubbed like every other
 * sink, because error messages can quote a provider's response.
 */
export function createJobLog(logger: Logger, file: RollingFile): (entry: Record<string, unknown>) => void {
  return (entry) => {
    try {
      file.append(JSON.stringify(logger.scrub({ ts: new Date().toISOString(), ...entry })));
    } catch {
      // Same rule as the other sinks: logging never fails a run.
    }
  };
}
