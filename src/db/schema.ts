import { sqliteTable, integer, text, real, index } from "drizzle-orm/sqlite-core";

/**
 * messages — raw inbound record (lossless). Every inbound message, photo, file,
 * and API pull is stored here verbatim BEFORE any processing.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // telegram_text | telegram_photo | telegram_file | oura | system
    source: text("source").notNull(),
    telegramMessageId: integer("telegram_message_id"),
    rawText: text("raw_text"),
    filePath: text("file_path"),
    // image | pdf | other
    fileKind: text("file_kind"),
    messageTime: text("message_time").notNull(),
    // ok | failed | empty | pending
    parseStatus: text("parse_status").notNull().default("pending"),
    parseError: text("parse_error"),
    llmRawResponse: text("llm_raw_response"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sourceIdx: index("messages_source_idx").on(t.source),
    statusIdx: index("messages_parse_status_idx").on(t.parseStatus),
  }),
);

/**
 * entries — derived structured log. Always rebuildable from messages.
 */
export const entries = sqliteTable(
  "entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id").references(() => messages.id),
    // food | sleep | weight | mood | appearance | exercise | environment |
    // routine | wearable | biomarker | note
    category: text("category").notNull(),
    // e.g. oura_sleep, oura_activity, oura_readiness, biomarker name
    subtype: text("subtype"),
    eventTime: text("event_time").notNull(),
    summary: text("summary").notNull(),
    // category-specific structured fields, JSON-encoded
    data: text("data").notNull(),
    // manual | oura | vision | bloodwork
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    categoryIdx: index("entries_category_idx").on(t.category),
    eventTimeIdx: index("entries_event_time_idx").on(t.eventTime),
    messageIdx: index("entries_message_idx").on(t.messageId),
    subtypeIdx: index("entries_subtype_idx").on(t.subtype),
  }),
);

/**
 * oura_tokens — wearable auth. Single row, id always 1.
 */
export const ouraTokens = sqliteTable("oura_tokens", {
  id: integer("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * biomarkers — normalized lab results flattened for trend math.
 */
export const biomarkers = sqliteTable(
  "biomarkers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id),
    name: text("name").notNull(),
    value: real("value").notNull(),
    unit: text("unit"),
    refLow: real("ref_low"),
    refHigh: real("ref_high"),
    // low | normal | high
    flag: text("flag"),
    drawnAt: text("drawn_at").notNull(),
  },
  (t) => ({
    nameIdx: index("biomarkers_name_idx").on(t.name),
    drawnIdx: index("biomarkers_drawn_idx").on(t.drawnAt),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;
export type OuraToken = typeof ouraTokens.$inferSelect;
export type Biomarker = typeof biomarkers.$inferSelect;
export type NewBiomarker = typeof biomarkers.$inferInsert;
