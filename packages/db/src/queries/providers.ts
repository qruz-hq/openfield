import type { CredentialSource, ErrorCode } from "@openfield/core/constants";
import { asc, eq } from "drizzle-orm";
import type { Executor } from "../client";
import type { NewProviderRow, ProviderRow } from "../rows";
import { providers } from "../schema";
import { type Draft, nowIso } from "./_util";

export function listProviders(db: Executor): ProviderRow[] {
  return db.select().from(providers).orderBy(asc(providers.id)).all();
}

export function getProvider(db: Executor, id: string): ProviderRow | undefined {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

/** Seeds built-in providers on boot. Existing rows keep the person's choices. Returns ids added. */
export function seedProviders(
  db: Executor,
  rows: Draft<NewProviderRow, "createdAt" | "updatedAt">[],
): string[] {
  if (rows.length === 0) return [];
  const at = nowIso();
  return db
    .insert(providers)
    .values(rows.map((r) => ({ ...r, createdAt: r.createdAt ?? at, updatedAt: r.updatedAt ?? at })))
    .onConflictDoNothing({ target: providers.id })
    .returning({ id: providers.id })
    .all()
    .map((r) => r.id);
}

/** PATCH /api/providers/:id */
export function updateProvider(
  db: Executor,
  id: string,
  patch: Partial<Pick<NewProviderRow, "enabled" | "concurrencyCap">>,
): ProviderRow | undefined {
  return db
    .update(providers)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(providers.id, id))
    .returning()
    .get();
}

/**
 * Records where a key now comes from and its last four characters. Never the key itself.
 * A new key hasn't been checked yet, so the last check result is cleared.
 */
export function setProviderCredential(
  db: Executor,
  id: string,
  cred: { source: CredentialSource; ref: string | null; hint: string | null },
): ProviderRow | undefined {
  return db
    .update(providers)
    .set({
      credentialSource: cred.source,
      credentialRef: cred.ref,
      credentialHint: cred.hint,
      lastOkAt: null,
      lastError: null,
      updatedAt: nowIso(),
    })
    .where(eq(providers.id, id))
    .returning()
    .get();
}

/** The outcome of "Check key" or of a real call that proved or broke the key. */
export function recordKeyCheck(
  db: Executor,
  id: string,
  result: { ok: true } | { ok: false; code: ErrorCode },
  at = nowIso(),
): ProviderRow | undefined {
  return db
    .update(providers)
    .set(
      result.ok
        ? { lastOkAt: at, lastError: null, updatedAt: at }
        : { lastError: result.code, updatedAt: at },
    )
    .where(eq(providers.id, id))
    .returning()
    .get();
}

export interface KeyStatusRow {
  providerId: string;
  source: CredentialSource;
  hint: string | null;
  lastOkAt: string | null;
  lastError: ErrorCode | null;
}

/** GET /api/settings/keys: status only. The server adds which environment variable is in effect. */
export function listKeyStatus(db: Executor): KeyStatusRow[] {
  return db
    .select({
      providerId: providers.id,
      source: providers.credentialSource,
      hint: providers.credentialHint,
      lastOkAt: providers.lastOkAt,
      lastError: providers.lastError,
    })
    .from(providers)
    .orderBy(asc(providers.id))
    .all();
}
