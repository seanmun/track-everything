import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { config } from "../config.js";
import * as schema from "./schema.js";

// Ensure the directory for the SQLite file exists before opening it.
const dbDir = dirname(config.DB_PATH);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(config.DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

/** Run drizzle migrations on boot. Safe to call repeatedly. */
export function runMigrations(): void {
  migrate(db, { migrationsFolder: "./drizzle" });
}

/** Close the underlying connection on graceful shutdown. */
export function closeDb(): void {
  sqlite.close();
}
