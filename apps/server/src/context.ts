import type { Db } from "@openfield/db";
import type { Provider } from "@openfield/providers/server";
import type { CanvasService } from "./canvas/canvases";
import type { CanvasRunService } from "./canvas/runs";
import type { ConfigStore } from "./config/config-file";
import type { HomePaths } from "./config/home";
import type { EventHub } from "./events/hub";
import type { Ingest } from "./files/ingest";
import type { Thumbs } from "./files/thumbs";
import type { Logger } from "./log/logger";
import type { McpSessions } from "./mcp/sessions";
import type { CallContexts } from "./runner/provider-fetch";
import type { Runner } from "./runner/runner";
import type { AgentService } from "./services/agents";
import type { CredentialService } from "./services/credentials";
import type { LibraryService } from "./services/library";
import type { ModelService } from "./services/models";
import type { PresenceService } from "./services/presence";
import type { ProviderSettingsService } from "./services/provider-settings";
import type { RemotePrices } from "./services/remote-prices";
import type { SettingsService } from "./services/settings";

/** Everything a route can reach, set on the Hono context as `svc`. */
export interface Services {
  version: string;
  port: number;
  dev: boolean;
  token: string;
  paths: HomePaths;
  config: ConfigStore;
  logger: Logger;
  db: Db;
  /** Newest applied migration. */
  schemaTag: string | null;
  providers: readonly Provider[];
  settings: SettingsService;
  /** Company settings for the modal and for each run (§0.3). */
  providerSettings: ProviderSettingsService;
  credentials: CredentialService;
  contexts: CallContexts;
  models: ModelService;
  /** Prices a company answers per request (Higgsfield's estimate), asked once a day (§6.9). */
  prices: RemotePrices;
  events: EventHub;
  ingest: Ingest;
  thumbs: Thumbs;
  /** The Assets library's changes, with their events and file cleanup (§2.8, §8.6). */
  library: LibraryService;
  runner: Runner;
  canvases: CanvasService;
  canvasRuns: CanvasRunService;
  /** Where each open tab is, for agents and ui.navigate (§7.11). */
  presence: PresenceService;
  /** OPENFIELD_FAKE_PROVIDERS=1: fake models, and the test-only routes that act as an agent. */
  fake: boolean;
  /** Settings > Agents: whether agent apps may connect, their key, and what they did today. */
  agents: AgentService;
  /** The agent apps connected at /mcp. */
  mcp: McpSessions;
  webDist: string | null;
  viteOrigin: string;
}

export type Env = { Variables: { svc: Services } };
