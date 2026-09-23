CREATE TABLE `asset_edges` (
	`parent_asset_id` text NOT NULL,
	`child_asset_id` text NOT NULL,
	`relation` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`parent_asset_id`, `child_asset_id`, `relation`, `ordinal`),
	FOREIGN KEY (`child_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asset_edges_relation_check" CHECK(relation IN ('derived','reference','import'))
);
--> statement-breakpoint
CREATE INDEX `idx_edges_parent` ON `asset_edges` (`parent_asset_id`);--> statement-breakpoint
CREATE INDEX `idx_edges_child` ON `asset_edges` (`child_asset_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`modality` text DEFAULT 'image' NOT NULL,
	`job_id` text,
	`job_set_id` text,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`seed` integer,
	`provider_id` text,
	`model_id` text,
	`prompt` text DEFAULT '' NOT NULL,
	`params` text,
	`tags` text DEFAULT '' NOT NULL,
	`cost_usd` real,
	`parent_asset_id` text,
	`root_asset_id` text NOT NULL,
	`op` text,
	`op_params` text,
	`mask_asset_id` text,
	`generative` integer DEFAULT 1 NOT NULL,
	`approximate` integer DEFAULT 0 NOT NULL,
	`approximate_reason` text,
	`file_state` text DEFAULT 'ok' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_set_id`) REFERENCES `job_sets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mask_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "assets_kind_check" CHECK(kind IN ('generated','uploaded','imported','edited','mask')),
	CONSTRAINT "assets_file_state_check" CHECK(file_state IN ('ok','missing','quarantined'))
);
--> statement-breakpoint
CREATE INDEX `idx_assets_feed` ON `assets` (created_at DESC,id DESC) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_assets_modality` ON `assets` (`modality`,created_at DESC) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_assets_model` ON `assets` (`model_id`,created_at DESC) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_assets_job_set` ON `assets` (`job_set_id`);--> statement-breakpoint
CREATE INDEX `idx_assets_sha256` ON `assets` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_assets_trash` ON `assets` (`deleted_at`) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_assets_root` ON `assets` (`root_asset_id`,`created_at`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `canvas_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "canvas_runs_scope_check" CHECK(scope IN ('node','downstream','all','selection')),
	CONSTRAINT "canvas_runs_status_check" CHECK(status IN ('pending','submitting','queued','running','succeeded','failed','canceled','interrupted','partial'))
);
--> statement-breakpoint
CREATE TABLE `canvas_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`graph` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canvas_versions` ON `canvas_versions` (`canvas_id`,created_at DESC);--> statement-breakpoint
CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Untitled' NOT NULL,
	`graph` text NOT NULL,
	`graph_version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`preview_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`opened_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `job_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text,
	`op` text NOT NULL,
	`modality` text DEFAULT 'image' NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`prompt_original` text,
	`negative_prompt` text,
	`request_json` text NOT NULL,
	`batch_size` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 10 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'composer' NOT NULL,
	`canvas_id` text,
	`canvas_node_id` text,
	`canvas_run_id` text,
	`cost_estimate_usd` real,
	`cost_actual_usd` real,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`canvas_run_id`) REFERENCES `canvas_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "job_sets_op_check" CHECK(op IN ('generate','edit','inpaint','outpaint','variation','upscale','remove_bg','text_edit','relight','angles','enhance','decompose','crop','grade','overlay')),
	CONSTRAINT "job_sets_batch_size_check" CHECK(batch_size BETWEEN 1 AND 4),
	CONSTRAINT "job_sets_status_check" CHECK(status IN ('pending','submitting','queued','running','succeeded','failed','canceled','interrupted','partial')),
	CONSTRAINT "job_sets_source_check" CHECK(source IN ('composer','detail_editor','canvas','api','recreate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_sets_idempotency_key_unique` ON `job_sets` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_job_sets_created` ON `job_sets` (created_at DESC);--> statement-breakpoint
CREATE INDEX `idx_job_sets_sched` ON `job_sets` (priority DESC,`created_at`) WHERE status IN ('pending','submitting','queued','running');--> statement-breakpoint
CREATE INDEX `idx_job_sets_canvas` ON `job_sets` (`canvas_id`,`canvas_node_id`);--> statement-breakpoint
CREATE INDEX `idx_job_sets_run` ON `job_sets` (`canvas_run_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_set_id` text NOT NULL,
	`idx` integer NOT NULL,
	`provider_job_id` text,
	`idempotency_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` real,
	`seed` integer,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`error_code` text,
	`error_message` text,
	`latency_ms` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`job_set_id`) REFERENCES `job_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_status_check" CHECK(status IN ('pending','submitting','queued','running','succeeded','failed','canceled','interrupted'))
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_active` ON `jobs` (`status`,`next_attempt_at`) WHERE status IN ('pending','submitting','queued','running');--> statement-breakpoint
CREATE INDEX `idx_jobs_job_set` ON `jobs` (`job_set_id`,`idx`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_job_set_id_idx_unique` ON `jobs` (`job_set_id`,`idx`);--> statement-breakpoint
CREATE TABLE `character_assets` (
	`character_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`character_id`, `asset_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`descriptor` text,
	`reference_set_id` text,
	`seed` integer,
	`lock_seed` integer DEFAULT 0 NOT NULL,
	`injection` text,
	`token` text,
	`provider_identity_json` text,
	`thumb_asset_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`reference_set_id`) REFERENCES `reference_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thumb_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "characters_injection_check" CHECK(injection IN ('prefix','suffix','replace-token'))
);
--> statement-breakpoint
CREATE TABLE `palettes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hex_json` text NOT NULL,
	`populations_json` text NOT NULL,
	`source_asset_id` text,
	`k` integer NOT NULL,
	`mode` text NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "palettes_mode_check" CHECK(mode IN ('prompt','reference','both'))
);
--> statement-breakpoint
CREATE TABLE `preset_assets` (
	`preset_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`role` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`preset_id`, `asset_id`, `role`),
	FOREIGN KEY (`preset_id`) REFERENCES `presets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "preset_assets_role_check" CHECK(role IN ('reference','palette','thumb'))
);
--> statement-breakpoint
CREATE TABLE `presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`payload_json` text NOT NULL,
	`thumb_asset_id` text,
	`builtin` integer DEFAULT 0 NOT NULL,
	`origin` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thumb_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `reference_set_items` (
	`set_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`position` integer NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`set_id`, `asset_id`),
	FOREIGN KEY (`set_id`) REFERENCES `reference_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reference_set_items_role_check" CHECK(role IN ('style','subject','composition','palette'))
);
--> statement-breakpoint
CREATE INDEX `idx_ref_set_items` ON `reference_set_items` (`set_id`,`position`);--> statement-breakpoint
CREATE TABLE `reference_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`text` text NOT NULL,
	`tags_json` text,
	`preset_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`preset_id`) REFERENCES `presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `asset_folders` (
	`asset_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`asset_id`, `folder_id`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_asset_folders_fld` ON `asset_folders` (`folder_id`,added_at DESC);--> statement-breakpoint
CREATE TABLE `favourites` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_favourites_created` ON `favourites` (created_at DESC);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `models` (
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`family` text,
	`modality` text DEFAULT 'image' NOT NULL,
	`badges` text,
	`capabilities` text NOT NULL,
	`pricing` text,
	`source` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`discovered_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`provider_id`, `model_id`),
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "models_modality_check" CHECK(modality IN ('image','video','audio')),
	CONSTRAINT "models_source_check" CHECK(source IN ('static','discovered','user'))
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`adapter` text NOT NULL,
	`auth_kind` text NOT NULL,
	`credential_ref` text,
	`credential_source` text DEFAULT 'unset' NOT NULL,
	`credential_hint` text,
	`base_url` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`concurrency_cap` integer DEFAULT 2 NOT NULL,
	`last_ok_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "providers_auth_kind_check" CHECK(auth_kind IN ('api_key','key_secret_pair','none')),
	CONSTRAINT "providers_credential_source_check" CHECK(credential_source IN ('env','file','unset'))
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`job_set_id` text,
	`job_id` text,
	`batch_index` integer,
	`operation` text NOT NULL,
	`outcome` text NOT NULL,
	`size` text,
	`quality` text,
	`units` text,
	`estimate_min` real,
	`estimate_max` real,
	`cost_usd` real,
	`cost_source` text,
	`price_as_of` text,
	`discarded` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`http_status` integer,
	CONSTRAINT "usage_log_outcome_check" CHECK(outcome IN ('succeeded','failed','canceled')),
	CONSTRAINT "usage_log_cost_source_check" CHECK(cost_source IN ('reconciled','estimated','unknown'))
);
--> statement-breakpoint
CREATE INDEX `idx_usage_ts` ON `usage_log` (ts DESC);--> statement-breakpoint
CREATE INDEX `idx_usage_model` ON `usage_log` (`provider_id`,`model_id`,ts DESC);