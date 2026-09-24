-- Generated, then corrected by hand: drizzle-kit copied columns the old canvas_versions didn't have,
-- quoted the DESC index expression as a column name, and dropped ON DELETE from folder_id.
ALTER TABLE `canvas_runs` ADD `plan` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_runs` ADD `nodes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_runs` ADD `priority` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvas_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`graph` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`kind` text DEFAULT 'auto' NOT NULL,
	`node_count` integer DEFAULT 0 NOT NULL,
	`edge_count` integer DEFAULT 0 NOT NULL,
	`cover_asset_id` text,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "canvas_versions_kind_check" CHECK(kind IN ('auto','named','before_delete','before_import','before_template','before_restore'))
);
--> statement-breakpoint
INSERT INTO `__new_canvas_versions`("id", "canvas_id", "graph", "label", "created_at") SELECT "id", "canvas_id", "graph", "label", "created_at" FROM `canvas_versions`;--> statement-breakpoint
DROP TABLE `canvas_versions`;--> statement-breakpoint
ALTER TABLE `__new_canvas_versions` RENAME TO `canvas_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_canvas_versions` ON `canvas_versions` (`canvas_id`,created_at DESC);--> statement-breakpoint
ALTER TABLE `canvases` ADD `node_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `cover_asset_id` text;--> statement-breakpoint
ALTER TABLE `canvases` ADD `folder_id` text REFERENCES folders(id) ON DELETE set null;