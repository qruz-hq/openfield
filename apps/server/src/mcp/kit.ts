import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ContentBlock,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { errorCopy, t } from "@openfield/core";
import { InvalidCursorError } from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import type { Services } from "../context";
import { ApiFailure } from "../http/errors";

// What every tool shares: the services, which app is calling, and the two ways a tool answers.

export interface AgentSession {
  /** Set once the app's initialize has been answered. */
  readonly id: string | undefined;
  /** The app's display name, such as "Claude Code". */
  readonly client: string;
}

export interface ToolContext {
  svc: Services;
  session: AgentSession;
}

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * A refusal the agent should read and act on (a missing image, a price to confirm). Answered as a
 * tool error with this message, never logged as a failure.
 */
export class Refusal extends Error {
  override readonly name = "Refusal";
}

/** A result: a JSON summary the agent can read, then any images. */
export function reply(summary: unknown, blocks: ContentBlock[] = []): CallToolResult {
  const text = typeof summary === "string" ? summary : JSON.stringify(summary, null, 2);
  return { content: [{ type: "text", text }, ...blocks] };
}

export function refuse(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Runs a tool body. Known failures become a message the agent can pass on: our own copy when
 * there is some, else the detail, which names the field at fault. Anything else is logged.
 */
export function guarded<A>(
  ctx: ToolContext,
  name: string,
  run: (args: A, extra: Extra) => Promise<CallToolResult>,
): (args: A, extra: Extra) => Promise<CallToolResult> {
  return async (args, extra) => {
    ctx.svc.agents.touch(ctx.session.client);
    try {
      return await run(args, extra);
    } catch (err) {
      return refuse(explain(err, (msg, data) => ctx.svc.logger.error(msg, { tool: name, ...data })));
    }
  };
}

export function explain(err: unknown, log: (msg: string, data: Record<string, unknown>) => void): string {
  if (err instanceof Refusal) return err.message;
  if (err instanceof ApiFailure) {
    const detail = err.field ? `${err.field}: ${err.message}` : err.message;
    return err.userMessage && err.userMessage !== err.message ? `${err.userMessage} (${detail})` : detail;
  }
  if (err instanceof InvalidCursorError) return "That page cursor has expired. Search again from the start.";
  if (isProviderError(err)) return err.userMessage || errorCopy(err.code).reason;
  log("An agent tool failed", { error: err });
  return t("errors.transport.internal");
}
