import type { JobSetWithJobs, SseEventType, SsePayload } from "@openfield/core";
import { sseEventSchema } from "@openfield/core";

// One stream, GET /api/events (§8.3.2). Ids only ever go up. A reconnect gets a fresh snapshot
// instead of a replay: active state is small and always rebuilt from the database.

const encoder = new TextEncoder();

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

export interface EventHubOptions {
  /** Active job sets for the opening snapshot. */
  snapshot: () => JobSetWithJobs[];
  heartbeatMs?: number;
  /** Called with frames that don't match sseEventSchema. They're still sent. */
  onInvalid?: (event: string, issue: string) => void;
}

export class EventHub {
  readonly #subs = new Set<Subscriber>();
  readonly #listeners = new Set<(event: SseEventType, data: unknown) => void>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  // Seeded from the clock so ids keep rising across restarts.
  #nextId = Date.now();

  constructor(private readonly opts: EventHubOptions) {
    this.#heartbeat = setInterval(() => this.#broadcast(": ping\n\n"), opts.heartbeatMs ?? 15_000);
    this.#heartbeat.unref?.();
  }

  get connections(): number {
    return this.#subs.size;
  }

  publish<E extends SseEventType>(event: E, data: SsePayload<E>): void {
    const check = sseEventSchema.safeParse({ event, data });
    if (!check.success) this.opts.onInvalid?.(event, check.error.issues[0]?.message ?? "invalid");
    for (const listener of this.#listeners) listener(event, data);
    if (this.#subs.size) this.#broadcast(this.#frame(event, data));
  }

  /** In-process listeners, for tests and anything else that wants the same events. */
  subscribe(listener: (event: SseEventType, data: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The text/event-stream response for one browser tab. */
  connect(signal?: AbortSignal): Response {
    let sub: Subscriber | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const current: Subscriber = { controller, closed: false };
        sub = current;
        this.#subs.add(current);
        this.#write(current, ": openfield stream\nretry: 2000\n\n");
        this.#write(
          current,
          this.#frame("snapshot", {
            activeJobSets: this.opts.snapshot(),
            serverTime: new Date().toISOString(),
          }),
        );
        signal?.addEventListener("abort", () => this.#drop(current), { once: true });
      },
      cancel: () => {
        if (sub) this.#drop(sub);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  /** Ends every stream, for shutdown. */
  close(): void {
    clearInterval(this.#heartbeat);
    for (const sub of this.#subs) {
      this.#drop(sub);
      try {
        sub.controller.close();
      } catch {
        // Already closed by the client.
      }
    }
  }

  #frame(event: SseEventType, data: unknown): string {
    return `id: ${this.#nextId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  #broadcast(text: string): void {
    for (const sub of this.#subs) this.#write(sub, text);
  }

  #write(sub: Subscriber, text: string): void {
    if (sub.closed) return;
    try {
      sub.controller.enqueue(encoder.encode(text));
    } catch {
      this.#drop(sub);
    }
  }

  #drop(sub: Subscriber): void {
    sub.closed = true;
    this.#subs.delete(sub);
  }
}
