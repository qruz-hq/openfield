import type { ProviderSummary } from "@openfield/core";
import { type Db, listProviders } from "@openfield/db";
import type { Provider } from "@openfield/providers/server";
import { toProviderSummary } from "../mappers/provider";
import type { CredentialService } from "./credentials";

/**
 * Every company, in registry order like the model picker's groups (§3.4.1), not by id: in fake mode
 * the test company ("fake") would otherwise come before Google and take first run's key field.
 */
export function providerSummaries(deps: {
  db: Db;
  providers: readonly Provider[];
  credentials: CredentialService;
}): ProviderSummary[] {
  const rows = new Map(listProviders(deps.db).map((row) => [row.id, row]));
  return deps.providers.flatMap((provider) => {
    const row = rows.get(provider.meta.id);
    return row ? [toProviderSummary(row, provider, deps.credentials.status(row.id))] : [];
  });
}
