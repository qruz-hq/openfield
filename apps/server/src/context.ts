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
import type { CallContexts } from "./runner/provider-fetch";
import type { Runner } from "./runner/runner";
import type { CredentialService } from "./services/credentials";
import type { ModelService } from "./services/models";
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
  credentials: CredentialService;
  contexts: CallContexts;
  models: ModelService;
  events: EventHub;
  ingest: Ingest;
  thumbs: Thumbs;
  runner: Runner;
  canvases: CanvasService;
  canvasRuns: CanvasRunService;
  webDist: string | null;
  viteOrigin: string;
}

export type Env = { Variables: { svc: Services } };
