import { timingSafeEqual } from "node:crypto";
import {
  AGENT_KEY_PREFIX,
  type AgentClient,
  type AgentLaunch,
  type AgentSpend,
  type AgentsStatus,
  t,
} from "@openfield/core";
import { agentUsageSince, type Db, pendingAgentEstimateUsd } from "@openfield/db";
import { type ConfigData, ConfigFileError, type ConfigStore } from "../config/config-file";
import { ApiFailure } from "../http/errors";

// Settings > Agents: whether agent apps may connect, the key they connect with, and what they've
// done today. The key sits in config.json beside the company keys (0600, §6.11). Turning agents off
// or making a new key ends every connection at once (see mcp/sessions.ts).

/** An app used within this long reads as connected now. */
const ACTIVE_MS = 60_000;

export interface AgentServiceDeps {
  config: ConfigStore;
  db: Db;
  /** Where apps that speak HTTP connect. */
  endpoint: string;
  /** How apps that only start programs reach it (the stdio bridge). */
  launch: AgentLaunch;
  now?: () => number;
}

export class AgentService {
  /** App name to when it last did something, since this start. */
  readonly #seen = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly deps: AgentServiceDeps) {}

  /** On, and with a key to check against. */
  get enabled(): boolean {
    return this.deps.config.data.agents.enabled && this.key !== null;
  }

  get key(): string | null {
    return this.deps.config.data.agents.key;
  }

  /** Turning agents on the first time makes the key. Turning them off keeps it for next time. */
  setEnabled(on: boolean): void {
    this.#save((draft) => {
      draft.agents.enabled = on;
      if (on && !draft.agents.key) draft.agents.key = mintAgentKey();
    });
    if (!on) this.#accessChanged();
  }

  /** A new key: apps using the old one are disconnected and have to be set up again. */
  newKey(): void {
    this.#save((draft) => {
      draft.agents.key = mintAgentKey();
    });
    this.#accessChanged();
  }

  /** The key is a secret like the company keys, and a failed save says so the same way. */
  #save(change: (draft: ConfigData) => void): void {
    try {
      this.deps.config.update(change);
    } catch (error) {
      if (!(error instanceof ConfigFileError)) throw error;
      throw new ApiFailure(500, "internal", error.message, {
        userMessage: t(error.reason === "private" ? "errors.keyNotPrivate" : "errors.keyNotSaved"),
      });
    }
  }

  /** Called when agents are turned off or the key changes, so open connections can end. */
  onAccessChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether an Authorization header carries the current key. Constant-time, like the session token. */
  accepts(authorization: string | undefined): boolean {
    const key = this.key;
    if (!this.enabled || !key) return false;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
    if (!match) return false;
    const sent = Buffer.from(match[1]!);
    const expected = Buffer.from(key);
    return sent.length === expected.length && timingSafeEqual(sent, expected);
  }

  /** For the log's redaction filter, beside the company keys. */
  secrets(): string[] {
    return this.key ? [this.key] : [];
  }

  /** An app did something. */
  touch(name: string): void {
    this.#seen.set(name, this.#now());
  }

  /** What agents spent since local midnight, runs still going counted at their estimate. */
  today(): AgentSpend {
    const rows = agentUsageSince(this.deps.db, startOfToday(this.#now()));
    const usd = rows.reduce((sum, r) => sum + r.usd, 0) + pendingAgentEstimateUsd(this.deps.db);
    const images = rows.reduce((sum, r) => sum + r.images, 0);
    return { usd: round(usd), images };
  }

  /** Apps seen since this start, and any that made something today, most recent first. */
  clients(): AgentClient[] {
    const now = this.#now();
    const spent = new Map(agentUsageSince(this.deps.db, startOfToday(now)).map((r) => [r.agent, r]));
    const names = new Set([...this.#seen.keys(), ...spent.keys()]);
    return [...names]
      .map((name) => {
        const seen = this.#seen.get(name);
        const today = spent.get(name);
        return {
          name,
          lastSeenAt: seen === undefined ? null : new Date(seen).toISOString(),
          active: seen !== undefined && now - seen < ACTIVE_MS,
          today: { usd: round(today?.usd ?? 0), images: today?.images ?? 0 },
        };
      })
      .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.name.localeCompare(b.name));
  }

  status(): AgentsStatus {
    const { agents } = this.deps.config.data;
    return {
      enabled: agents.enabled,
      key: agents.key,
      endpoint: this.deps.endpoint,
      launch: this.deps.launch,
      today: this.today(),
      clients: this.clients(),
    };
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #accessChanged(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** 32 random bytes, base64url, after the prefix. */
export function mintAgentKey(): string {
  return AGENT_KEY_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** Local midnight today, as an instant: the agents' day, like the Spending pane's. */
export function startOfToday(now: number = Date.now()): string {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
