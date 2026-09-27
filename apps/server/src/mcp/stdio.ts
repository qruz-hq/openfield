import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type InitializeResult,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_PORT } from "@openfield/core";
import { resolveHome } from "../config/home";

// `bun run mcp`: the bridge for agent apps that can only start a program (Claude Desktop, Codex).
// It speaks MCP on stdin/stdout and passes every message to the running Openfield at /mcp, with
// the agent key read from the library folder, so nothing needs pasting. It never starts Openfield:
// when it isn't running the app is told how to start it. When Openfield restarts, the bridge
// connects again on the app's next message, replaying the app's own handshake.
//
// stdout carries the protocol only. Anything for a person goes to stderr.

const REPO = join(import.meta.dir, "../../../..");
const HANDSHAKE_TIMEOUT_MS = 10_000;

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface BridgeOptions {
  env?: Record<string, string | undefined>;
  /** For tests: where requests go instead of the network. */
  fetch?: FetchLike;
  /** How long a replayed handshake may take. */
  handshakeTimeoutMs?: number;
}

export const notRunning = () =>
  `Openfield isn't running. Start it with \`bun start\` in ${REPO}, then try again.`;
const notOn =
  "Agents aren't turned on in Openfield. The person can turn them on in Openfield, Settings > Agents.";

/** Where Openfield listens and the key it wants, from the environment and config.json. */
export function bridgeTarget(env: Record<string, string | undefined>): { url: URL; key: string | null } {
  const home = resolveHome(env);
  let config: { port?: unknown; agents?: { key?: unknown } } = {};
  const file = join(home, "config.json");
  try {
    if (existsSync(file)) config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Unreadable: treated as no key, and Openfield itself says what's wrong with the file.
  }
  const fromEnv = Number(env.OPENFIELD_PORT);
  const port =
    Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536
      ? fromEnv
      : typeof config.port === "number"
        ? config.port
        : DEFAULT_PORT;
  const key = typeof config.agents?.key === "string" ? config.agents.key : null;
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), key };
}

export class Bridge {
  #http: StreamableHTTPClientTransport | null = null;
  /** The app's initialize, replayed when the bridge has to connect again. */
  #handshake: JSONRPCRequest | null = null;
  #initialized = false;
  #replays = 0;
  readonly #ours = new Map<string, (message: JSONRPCMessage) => void>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    /** Sends a message back to the app. */
    private readonly reply: (message: JSONRPCMessage) => Promise<void>,
    private readonly opts: BridgeOptions = {},
  ) {}

  /** One message from the app, passed on in order. */
  receive(message: JSONRPCMessage): Promise<void> {
    this.#queue = this.#queue.then(() => this.#forward(message));
    return this.#queue;
  }

  async close(): Promise<void> {
    await this.#http?.close().catch(() => {});
    this.#http = null;
  }

  async #forward(message: JSONRPCMessage): Promise<void> {
    if (isInitializeRequest(message)) this.#handshake = message as JSONRPCRequest;
    if (isJSONRPCNotification(message) && message.method === "notifications/initialized")
      this.#initialized = true;
    try {
      await this.#send(message);
    } catch (first) {
      let error = first;
      // Openfield restarted, so this session is gone, or it wasn't up a moment ago. Connect again.
      if (this.#handshake && message !== this.#handshake && worthRetrying(error)) {
        try {
          await this.#reconnect();
          await this.#send(message);
          return;
        } catch (again) {
          error = again;
        }
      }
      await this.#fail(message, error);
    }
  }

  async #send(message: JSONRPCMessage): Promise<void> {
    const http = await this.#connection();
    await http.send(message);
  }

  async #connection(): Promise<StreamableHTTPClientTransport> {
    if (this.#http) return this.#http;
    const { url, key } = bridgeTarget(this.opts.env ?? process.env);
    if (!key) throw new BridgeError(notOn);
    const http = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      ...(this.opts.fetch && { fetch: this.opts.fetch }),
    });
    http.onmessage = (message) => {
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        typeof message.id === "string"
      ) {
        const ours = this.#ours.get(message.id);
        if (ours) {
          this.#ours.delete(message.id);
          ours(message);
          return;
        }
      }
      // Later requests carry the protocol version the handshake settled on.
      if (isJSONRPCResultResponse(message) && this.#handshake && message.id === this.#handshake.id) {
        const version = (message.result as InitializeResult).protocolVersion;
        if (version) http.setProtocolVersion(version);
      }
      void this.reply(message).catch(() => {});
    };
    // Failures reach the app through the request that failed.
    http.onerror = () => {};
    await http.start();
    this.#http = http;
    return http;
  }

  async #reconnect(): Promise<void> {
    await this.close();
    const http = await this.#connection();
    const handshake = this.#handshake!;
    const id = `openfield-bridge-${++this.#replays}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<JSONRPCMessage>((resolve, reject) => {
      this.#ours.set(id, resolve);
      timer = setTimeout(
        () => reject(new BridgeError(notRunning())),
        this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    let result: JSONRPCMessage;
    try {
      await http.send({ ...handshake, id });
      result = await answer;
    } finally {
      // A send that fails leaves the answer unawaited: its timer must not fire later.
      clearTimeout(timer);
      this.#ours.delete(id);
    }
    if (isJSONRPCErrorResponse(result)) throw new BridgeError(result.error.message);
    const version = isJSONRPCResultResponse(result)
      ? (result.result as InitializeResult).protocolVersion
      : undefined;
    if (version) http.setProtocolVersion(version);
    if (this.#initialized) await http.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Tells the app why, in words it can pass on. A tool call gets a tool error the agent can read. */
  async #fail(message: JSONRPCMessage, error: unknown): Promise<void> {
    // Nothing is left to use: the next message tries again from the start.
    await this.close();
    if (!isJSONRPCRequest(message)) return;
    const text = reasonOf(error);
    if (message.method === "tools/call") {
      await this.reply({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }], isError: true },
      });
      return;
    }
    await this.reply({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  }
}

class BridgeError extends Error {}

/** A session Openfield no longer knows (it restarted), or no answer at all (it's stopped). */
function worthRetrying(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 404;
  return !(error instanceof BridgeError);
}

function reasonOf(error: unknown): string {
  if (error instanceof BridgeError) return error.message;
  if (error instanceof StreamableHTTPError) {
    // Openfield's own refusals carry a JSON-RPC error with words for the person.
    const body = /\{.*\}/s.exec(error.message)?.[0];
    try {
      const parsed = JSON.parse(body ?? "") as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      // Not ours: fall through.
    }
    return `Openfield answered with an error (HTTP ${error.code}).`;
  }
  return notRunning();
}

if (import.meta.main) {
  const stdio = new StdioServerTransport();
  const bridge = new Bridge((message) => stdio.send(message));
  stdio.onmessage = (message) => void bridge.receive(message);
  stdio.onerror = (error) => console.error(`Openfield bridge: ${error.message}`);
  stdio.onclose = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  await stdio.start();
}
