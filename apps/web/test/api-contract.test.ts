// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { expect, test } from "bun:test";
import type {
  AssetsListResponse,
  JobSetAccepted,
  JobSetsListResponse,
  KeyStatus,
  KeyTestResponse,
  ModelsListResponse,
  ProviderSummary,
  Settings,
  UsageResponse,
} from "@openfield/core";
import type { InferResponseType } from "hono/client";
import type { api } from "../src/api/client";

// M0-11a: what the typed client says a route returns must match the core schema the UI is
// written against. Rename a field in a core response schema and `bun run typecheck` fails here.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type Api = typeof api.api;

export type Contracts = [
  Assert<Same<InferResponseType<Api["settings"]["$get"], 200>, Settings>>,
  Assert<Same<InferResponseType<Api["settings"]["keys"]["$get"], 200>, KeyStatus[]>>,
  Assert<
    Same<InferResponseType<Api["settings"]["keys"][":providerId"]["test"]["$post"], 200>, KeyTestResponse>
  >,
  Assert<Same<InferResponseType<Api["providers"]["$get"], 200>, ProviderSummary[]>>,
  Assert<Same<InferResponseType<Api["models"]["$get"], 200>, ModelsListResponse>>,
  Assert<Same<InferResponseType<Api["assets"]["$get"], 200>, AssetsListResponse>>,
  Assert<Same<InferResponseType<Api["job-sets"]["$get"], 200>, JobSetsListResponse>>,
  Assert<Same<InferResponseType<Api["generate"]["$post"], 202>, JobSetAccepted>>,
  Assert<Same<InferResponseType<Api["usage"]["$get"], 200>, UsageResponse>>,
];

test("route types line up with core schemas (checked by tsc)", () => {
  const checked: Contracts["length"] = 9;
  expect(checked).toBe(9);
});
