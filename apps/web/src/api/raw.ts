import {
  type ApiErrorCode,
  ERROR_CODES,
  type ErrorCode,
  errorCopy,
  errorEnvelopeSchema,
  parseSseFrame,
  type SseEvent,
  TRANSPORT_ERROR_CODES,
  type TransportErrorCode,
  t,
} from "@openfield/core";
import { useLive } from "../lib/live";
import { tabId } from "../lib/tab";
import { renewSessionToken, sessionHeaders, sessionToken } from "./session";

// Plain HTTP for what the typed client can't carry: file bytes and the event stream (§8.3.3).
// Every request sends the session header.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    readonly field?: string,
    /** The server's own copy for this failure, from the catalogue. Safe to show. */
    readonly userMessage?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const isErrorCode = (code: string): code is ErrorCode => (ERROR_CODES as readonly string[]).includes(code);
const isTransportCode = (code: string): code is TransportErrorCode =>
  (TRANSPORT_ERROR_CODES as readonly string[]).includes(code);

/**
 * Words for a failed request. Server messages are detail for the error log and never shown; only
 * the catalogue copy some replies carry as userMessage is.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.userMessage) return error.userMessage;
    if (isErrorCode(error.code)) return errorCopy(error.code).reason;
    if (isTransportCode(error.code)) return t(`errors.transport.${error.code}`);
  }
  if (error instanceof TypeError) return errorCopy("network").reason;
  return t("errors.transport.internal");
}

/** fetch with the session header. Network failures surface as ApiError("network"). */
export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(sessionHeaders())) headers.set(name, value);
  try {
    return await fetch(path, { ...init, headers });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, "network", errorCopy("network").reason, true);
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  // The only 403 our own page can get: the server restarted and minted a new session token.
  // Picking up the new one makes the request worth repeating; only if that fails must we reload.
  let renewed = false;
  if (res.status === 403 && sessionToken()) {
    renewed = await renewSessionToken();
    if (!renewed) useLive.getState().expireSession();
  }
  const body = await res.json().catch(() => null);
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, retryable, field, userMessage } = parsed.data.error;
    return new ApiError(res.status, code, message, retryable || renewed, field, userMessage);
  }
  // A body too big for the server at all gets its bare 413, before any route can answer.
  if (res.status === 413)
    return new ApiError(413, "payload_too_large", res.statusText || "payload_too_large");
  const code: TransportErrorCode =
    res.status === 404
      ? "not_found"
      : res.status === 409
        ? "conflict"
        : res.status < 500
          ? "bad_request"
          : "internal";
  return new ApiError(res.status, code, res.statusText || code);
}

// Event stream (§8.3.2). EventSource can't send the session header, so this reads the stream with
// fetch and reconnects by hand, with Last-Event-ID, the way EventSource would.

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Splits text/event-stream chunks into frames. Pure, so it's tested without a server. */
export function createSseParser(onFrame: (frame: SseFrame) => void) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = () => {
    if (data.length) onFrame({ event: event || "message", data: data.join("\n"), id });
    event = "";
    data = [];
    id = undefined;
  };

  const line = (text: string) => {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      let at = buffer.search(/\r\n|\r|\n/);
      while (at >= 0) {
        // A lone \r at the end may be half of a \r\n split across chunks: wait for the rest.
        if (at === buffer.length - 1 && buffer[at] === "\r") break;
        const newline = buffer.startsWith("\r\n", at) ? 2 : 1;
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + newline);
        at = buffer.search(/\r\n|\r|\n/);
      }
    },
  };
}

export interface EventStreamOptions {
  signal: AbortSignal;
  lastEventId?: string;
  onOpen: () => void;
  onEvent: (event: SseEvent, id: string | undefined) => void;
}

/** Reads GET /api/events until the server closes it or the signal aborts. */
export async function readEventStream({ signal, lastEventId, onOpen, onEvent }: EventStreamOptions) {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  // The tab id lets the server forget this tab once the stream closes (§7.11).
  const res = await rawFetch(`/api/events?tab=${tabId}`, { headers, signal, cache: "no-store" });
  if (!res.ok || !res.body) throw await toApiError(res);
  onOpen();

  const parser = createSseParser((frame) => {
    const event = parseSseFrame(frame.event, frame.data);
    if (event) onEvent(event, frame.id);
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    parser.feed(value);
  }
}
