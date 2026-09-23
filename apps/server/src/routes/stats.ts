import type { StatsResponse } from "@openfield/core";
import { libraryStats } from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { directorySize, fileSize, freeSpace } from "../files/disk";

// Settings > Storage (§8.6), including whether thumbnails are on (§8.5.2).
export const statsRoutes = new Hono<Env>().get("/stats", async (c) => {
  const { db, paths, thumbs } = c.var.svc;
  const stats: StatsResponse = {
    ...libraryStats(db),
    thumbsBytes: await directorySize(paths.thumbs),
    dbBytes: fileSize(paths.db) + fileSize(`${paths.db}-wal`),
    freeBytes: freeSpace(paths.root),
    thumbnailEngine: thumbs.engine,
  };
  return c.json(stats satisfies StatsResponse, 200);
});
