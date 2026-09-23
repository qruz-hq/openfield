import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { assets } from "./assets";

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  parentId: text("parent_id").references((): AnySQLiteColumn => folders.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const assetFolders = sqliteTable(
  "asset_folders",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.folderId] }),
    index("idx_asset_folders_fld").on(t.folderId, sql`added_at DESC`),
  ],
);

export const favourites = sqliteTable(
  "favourites",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  () => [index("idx_favourites_created").on(sql`created_at DESC`)],
);
