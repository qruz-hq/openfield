import { zValidator } from "@hono/zod-validator";
import { type EmptyTrashResponse, emptyTrashBodySchema, type LibrarySummary } from "@openfield/core";
import { libraryCounts, libraryFacets } from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// The sidebar's counts with the Model and Company filter choices (§2.8), and Empty trash (§8.6).

export const libraryRoutes = new Hono<Env>()
  .get("/library/summary", (c) => {
    const { db } = c.var.svc;
    const body: LibrarySummary = { counts: libraryCounts(db), ...libraryFacets(db) };
    return c.json(body satisfies LibrarySummary, 200);
  })
  .post("/maintenance/empty-trash", zValidator("json", emptyTrashBodySchema, onInvalid), async (c) => {
    const { changed, reclaimedBytes } = await c.var.svc.library.emptyTrash();
    return c.json({ affected: changed.length, reclaimedBytes } satisfies EmptyTrashResponse, 200);
  });
