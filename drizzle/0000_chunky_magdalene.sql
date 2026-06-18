CREATE TABLE `biomarkers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`name` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	`ref_low` real,
	`ref_high` real,
	`flag` text,
	`drawn_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `biomarkers_name_idx` ON `biomarkers` (`name`);--> statement-breakpoint
CREATE INDEX `biomarkers_drawn_idx` ON `biomarkers` (`drawn_at`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer,
	`category` text NOT NULL,
	`subtype` text,
	`event_time` text NOT NULL,
	`summary` text NOT NULL,
	`data` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entries_category_idx` ON `entries` (`category`);--> statement-breakpoint
CREATE INDEX `entries_event_time_idx` ON `entries` (`event_time`);--> statement-breakpoint
CREATE INDEX `entries_message_idx` ON `entries` (`message_id`);--> statement-breakpoint
CREATE INDEX `entries_subtype_idx` ON `entries` (`subtype`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`telegram_message_id` integer,
	`raw_text` text,
	`file_path` text,
	`file_kind` text,
	`message_time` text NOT NULL,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`parse_error` text,
	`llm_raw_response` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_source_idx` ON `messages` (`source`);--> statement-breakpoint
CREATE INDEX `messages_parse_status_idx` ON `messages` (`parse_status`);--> statement-breakpoint
CREATE TABLE `oura_tokens` (
	`id` integer PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text NOT NULL
);
