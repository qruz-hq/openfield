import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HOST, ORIGIN, type TestServer } from "./helpers";

// An agent app connected to a test server: the SDK's own client, its requests handed to the app
// in process with the Host a real one would send.

export async function turnOnAgents(server: TestServer): Promise<string> {
  const res = await server.json<{ key: string }>("/api/agents", { method: "PUT", body: { enabled: true } });
  if (res.status !== 200) throw new Error(`Turning agents on failed: ${JSON.stringify(res.body)}`);
  return res.body.key;
}

/** The app's fetch, straight into the Hono app. */
export function appFetch(server: TestServer) {
  return (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", HOST);
    return Promise.resolve(server.app.request(String(url), { ...init, headers }));
  };
}

export async function connectAgent(
  server: TestServer,
  opts: { key?: string; name?: string } = {},
): Promise<Client> {
  const key = opts.key ?? server.services.agents.key;
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: appFetch(server),
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: opts.name ?? "claude-code", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** A tool's JSON summary, its images, and whether it refused. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first, ...rest] = result.content;
  const text = first?.type === "text" ? first.text : "";
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A refusal is plain text.
  }
  return {
    isError: result.isError === true,
    text,
    json: json as Record<string, unknown> & { [key: string]: never },
    images: rest.filter((b) => b.type === "image"),
  };
}
