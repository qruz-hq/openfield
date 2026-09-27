import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Services } from "../context";
import type { AgentSession } from "./kit";
import { clientDisplayName } from "./names";
import { createMcpServer } from "./server";

// /mcp: agent apps connect here over Streamable HTTP (MCP). The host and cross-site guards run
// first, like everywhere; the session token doesn't, since apps aren't the browser. Instead:
// - 404 while agents are off in Settings > Agents, so nothing is there to find.
// - The agent key, as a bearer token, on every request.
// Each app's connection is a session with its own MCP server, kept in memory. A session idle for
// half an hour ends, as do all of them when agents are turned off or the key changes. An app whose
// session ended connects again on its own.

const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;
/** Tool calls are small: images come in by id, path or address, never in the body. */
const MAX_BODY = 2 * 1024 * 1024;
/** Plenty for one person's apps; past it the longest idle one goes. */
const MAX_SESSIONS = 32;

interface Live {
  id: string;
  server: McpServer;
  lastUsed: number;
}

export interface McpSessionsOptions {
  idleMs?: number;
  now?: () => number;
}

export class McpSessions {
  readonly #live = new Map<string, Live>();
  readonly #sweep: ReturnType<typeof setInterval>;
  readonly #idleMs: number;
  readonly #now: () => number;
  #unsubscribe: (() => void) | undefined;

  /** `svc` is a getter: the sessions are made before the services object they belong to. */
  constructor(
    private readonly svc: () => Services,
    opts: McpSessionsOptions = {},
  ) {
    this.#idleMs = opts.idleMs ?? IDLE_MS;
    this.#now = opts.now ?? Date.now;
    this.#sweep = setInterval(() => this.sweep(), SWEEP_MS);
    this.#sweep.unref?.();
  }

  get count(): number {
    return this.#live.size;
  }

  async handle(req: Request): Promise<Response> {
    const svc = this.svc();
    this.#unsubscribe ??= svc.agents.onAccessChange(() => this.closeAll());
    if (!svc.agents.enabled) {
      return rpcError(
        404,
        "Agents are turned off in Openfield. The person can turn them on in Settings > Agents.",
      );
    }
    if (!svc.agents.accepts(req.headers.get("authorization") ?? undefined)) {
      return rpcError(
        401,
        "Openfield didn't accept this access key. Copy it again from Openfield, Settings > Agents, and set up the app again.",
      );
    }
    const id = req.headers.get("mcp-session-id");
    if (id) {
      const live = this.#live.get(id);
      // 404 tells the app to start a new session (MCP Streamable HTTP).
      if (!live) return rpcError(404, "This connection to Openfield ended. Connect again.");
      live.lastUsed = this.#now();
      return this.#transport(live).handleRequest(req);
    }
    if (req.method !== "POST") return rpcError(405, "Connect with a POST that starts a session.");
    return this.#open(svc, req);
  }

  /** Ends every connection: agents were turned off, the key changed, or the server is stopping. */
  closeAll(): void {
    for (const id of [...this.#live.keys()]) this.#drop(id);
  }

  stop(): void {
    clearInterval(this.#sweep);
    this.#unsubscribe?.();
    this.closeAll();
  }

  async #open(svc: Services, req: Request): Promise<Response> {
    const live: Live = { id: "", server: undefined as unknown as McpServer, lastUsed: this.#now() };
    const session: AgentSession = {
      get id() {
        return live.id || undefined;
      },
      get client() {
        return clientDisplayName(live.server.server.getClientVersion()?.name);
      },
      get canAsk() {
        return !!live.server.server.getClientCapabilities()?.elicitation;
      },
    };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        live.id = sid;
        if (this.#live.size >= MAX_SESSIONS) this.#dropOldest();
        this.#live.set(sid, live);
      },
      onsessionclosed: (sid) => this.#drop(sid),
      maxRequestBodySize: MAX_BODY,
    });
    live.server = createMcpServer(svc, session);
    live.server.server.oninitialized = () => svc.agents.touch(session.client);
    await live.server.connect(transport);
    const res = await transport.handleRequest(req);
    // Anything but an initialize without a session is refused by the transport; keep nothing.
    if (!live.id) await live.server.close();
    return res;
  }

  #transport(live: Live): WebStandardStreamableHTTPServerTransport {
    return live.server.server.transport as WebStandardStreamableHTTPServerTransport;
  }

  #drop(id: string): void {
    const live = this.#live.get(id);
    if (!live) return;
    this.#live.delete(id);
    void live.server.close().catch(() => {});
  }

  #dropOldest(): void {
    let oldest: Live | undefined;
    for (const live of this.#live.values()) if (!oldest || live.lastUsed < oldest.lastUsed) oldest = live;
    if (oldest) this.#drop(oldest.id);
  }

  /** Ends sessions idle past the limit. Runs every minute. */
  sweep(): void {
    const cutoff = this.#now() - this.#idleMs;
    for (const live of [...this.#live.values()]) if (live.lastUsed < cutoff) this.#drop(live.id);
  }
}

/** A JSON-RPC error with no id, the shape MCP apps show when a request can't be handled. */
function rpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status });
}
