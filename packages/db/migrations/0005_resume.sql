ALTER TABLE `jobs` ADD `handle` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `resumable` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `resumed_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `rerun_at` text;--> statement-breakpoint
ALTER TABLE `usage_log` ADD `rerun` integer DEFAULT 0 NOT NULL;