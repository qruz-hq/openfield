import type { Modality } from "@openfield/core/constants";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { type ModelRow, type NewModelRow, newModelRow } from "../rows";
import { models } from "../schema";
import { type Draft, nowIso } from "./_util";

export function listModels(
  db: Executor,
  q: { providerId?: string; modality?: Modality; enabledOnly?: boolean } = {},
): ModelRow[] {
  return db
    .select()
    .from(models)
    .where(
      and(
        q.providerId ? eq(models.providerId, q.providerId) : undefined,
        q.modality ? eq(models.modality, q.modality) : undefined,
        q.enabledOnly ? eq(models.enabled, true) : undefined,
      ),
    )
    .orderBy(asc(models.providerId), asc(models.sortOrder), asc(models.displayName))
    .all();
}

export function getModel(db: Executor, providerId: string, modelId: string): ModelRow | undefined {
  return db
    .select()
    .from(models)
    .where(and(eq(models.providerId, providerId), eq(models.modelId, modelId)))
    .get();
}

/**
 * Writes catalog or discovered models. Every capabilities blob is checked against core's
 * manifest schema first, so a bad manifest never reaches the composer. `enabled` is the
 * person's choice and survives a refresh.
 */
export function upsertModels(db: Executor, rows: Draft<NewModelRow, "updatedAt">[]): ModelRow[] {
  if (rows.length === 0) return [];
  const at = nowIso();
  const values = rows.map((r) => newModelRow.parse({ ...r, updatedAt: r.updatedAt ?? at }) as NewModelRow);
  return db
    .insert(models)
    .values(values)
    .onConflictDoUpdate({
      target: [models.providerId, models.modelId],
      set: {
        displayName: sql`excluded.display_name`,
        family: sql`excluded.family`,
        modality: sql`excluded.modality`,
        badges: sql`excluded.badges`,
        capabilities: sql`excluded.capabilities`,
        pricing: sql`excluded.pricing`,
        speeds: sql`excluded.speeds`,
        source: sql`excluded.source`,
        sortOrder: sql`excluded.sort_order`,
        discoveredAt: sql`coalesce(excluded.discovered_at, ${models.discoveredAt})`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning()
    .all();
}

export function removeModels(db: Executor, providerId: string, modelIds: readonly string[]): number {
  if (modelIds.length === 0) return 0;
  return db
    .delete(models)
    .where(and(eq(models.providerId, providerId), inArray(models.modelId, [...modelIds])))
    .returning({ modelId: models.modelId })
    .all().length;
}

export function setModelEnabled(
  db: Executor,
  providerId: string,
  modelId: string,
  enabled: boolean,
): ModelRow | undefined {
  return db
    .update(models)
    .set({ enabled, updatedAt: nowIso() })
    .where(and(eq(models.providerId, providerId), eq(models.modelId, modelId)))
    .returning()
    .get();
}
