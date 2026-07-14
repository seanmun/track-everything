CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer,
	`title` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`notes` text,
	`remind_at` text,
	`reminded` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`start_time`);--> statement-breakpoint
CREATE INDEX `events_remind_idx` ON `events` (`remind_at`);