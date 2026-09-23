// @openfield/providers/server: the server entry (§0.16 rule 3). Adapters, the registry,
// normalize() and the error helpers. Only apps/server imports this; the browser never does.

export { createGoogleProvider } from "./google";
export * from "./manifest";
export {
  appendAvoid,
  type NormalizeOptions,
  type NormalizeResult,
  normalize,
  type PromptResolver,
  planCalls,
  type ResolvedPrompt,
} from "./normalize";
export { HIDDEN, redact } from "./redact";
export { builtinProviders, createModelRegistry, type RegistryOptions } from "./registry";
export { createFakeFetch, type FakeFetch, type FakeFetchOptions } from "./testing/fake-fetch";
export type { FakeScenario } from "./testing/types";
export * from "./types";
