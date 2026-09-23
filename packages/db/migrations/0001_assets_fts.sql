-- Prompt and tag search over assets (§8.2.3). Hand-written because Drizzle can't model FTS5.
-- Soft delete fires no trigger on purpose: the row stays searchable until a hard delete.
CREATE VIRTUAL TABLE assets_fts USING fts5(
  prompt,
  model_id UNINDEXED,
  tags,
  content = 'assets',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
--> statement-breakpoint
CREATE TRIGGER assets_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts(rowid, prompt, model_id, tags)
  VALUES (new.rowid, new.prompt, new.model_id, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER assets_ad AFTER DELETE ON assets BEGIN
  INSERT INTO assets_fts(assets_fts, rowid, prompt, model_id, tags)
  VALUES ('delete', old.rowid, old.prompt, old.model_id, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER assets_au AFTER UPDATE OF prompt, model_id, tags ON assets BEGIN
  INSERT INTO assets_fts(assets_fts, rowid, prompt, model_id, tags)
  VALUES ('delete', old.rowid, old.prompt, old.model_id, old.tags);
  INSERT INTO assets_fts(rowid, prompt, model_id, tags)
  VALUES (new.rowid, new.prompt, new.model_id, new.tags);
END;
