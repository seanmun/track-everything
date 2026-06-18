import { z } from "zod";
import { MODELS, MAX_TOKENS } from "../config.js";
import { anthropic, textOf, parseJsonWithRetry } from "./anthropic.js";
import { parserSystemPrompt } from "./prompts.js";

const CATEGORIES = [
  "food",
  "sleep",
  "weight",
  "mood",
  "appearance",
  "exercise",
  "environment",
  "routine",
  "note",
] as const;

const parsedEntrySchema = z.object({
  category: z.enum(CATEGORIES),
  event_time: z.string().min(1),
  summary: z.string().min(1),
  data: z.record(z.unknown()).default({}),
});

const parserResultSchema = z.object({
  entries: z.array(parsedEntrySchema),
});

export type ParsedEntry = z.infer<typeof parsedEntrySchema>;

export interface ParserOutput {
  entries: ParsedEntry[];
  raw: string;
}

/**
 * Parse free-text into one or more structured entries (§7).
 * Throws on hard failure; the caller keeps the raw message regardless.
 */
export async function parseText(text: string, messageTimeIso: string): Promise<ParserOutput> {
  const system = parserSystemPrompt(messageTimeIso);

  const { value, raw } = await parseJsonWithRetry(
    async (retryHint) => {
      const res = await anthropic.messages.create({
        model: MODELS.parse,
        max_tokens: MAX_TOKENS.parse,
        temperature: 0,
        system,
        messages: [
          {
            role: "user",
            content: retryHint ? `${text}\n\n${retryHint}` : text,
          },
        ],
      });
      return textOf(res);
    },
    (v) => parserResultSchema.parse(v),
  );

  return { entries: value.entries, raw };
}
