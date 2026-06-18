import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/** Concatenate all text blocks from a Messages API response. */
export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Strip stray ```json / ``` fences and surrounding prose before JSON.parse. */
export function stripFences(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }
  // If there is leading/trailing prose, isolate the outermost JSON object/array.
  const firstBrace = text.search(/[[{]/);
  const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

/**
 * Parse JSON from a model's text, retrying the model call once with a
 * "valid JSON only" nudge if the first parse fails. Returns both the parsed
 * value and the raw response text (for storage / reprocessing).
 */
export async function parseJsonWithRetry<T>(
  call: (retryHint: string) => Promise<string>,
  validate: (value: unknown) => T,
): Promise<{ value: T; raw: string }> {
  const firstRaw = await call("");
  try {
    return { value: validate(JSON.parse(stripFences(firstRaw))), raw: firstRaw };
  } catch (firstErr) {
    const retryRaw = await call(
      "Your previous response was not valid JSON. Respond with VALID JSON ONLY — no prose, no markdown fences.",
    );
    try {
      return { value: validate(JSON.parse(stripFences(retryRaw))), raw: retryRaw };
    } catch (secondErr) {
      const reason = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`JSON parse failed after retry: ${reason}`);
    }
  }
}
