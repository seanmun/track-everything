import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { MODELS, MAX_TOKENS } from "../config.js";
import { anthropic, textOf, parseJsonWithRetry } from "./anthropic.js";
import { bloodworkSystemPrompt } from "./prompts.js";
import { readBase64, imageMediaType, type FileKind } from "../util/files.js";

const markerSchema = z.object({
  name: z.string(),
  normalizedName: z.string(),
  value: z.number(),
  unit: z.string().nullable().default(null),
  refLow: z.number().nullable().default(null),
  refHigh: z.number().nullable().default(null),
  flag: z.enum(["low", "normal", "high"]).nullable().default(null),
});

const panelSchema = z.object({
  name: z.string(),
  markers: z.array(markerSchema),
});

const bloodworkResultSchema = z.object({
  drawnAt: z.string().nullable().default(null),
  panels: z.array(panelSchema),
});

export type BloodworkMarker = z.infer<typeof markerSchema>;
export type BloodworkPanel = z.infer<typeof panelSchema>;
export type BloodworkResult = z.infer<typeof bloodworkResultSchema>;

export interface BloodworkOutput {
  result: BloodworkResult;
  raw: string;
}

/**
 * Extract structured biomarkers from a bloodwork PDF or image (§9).
 * `fileKind` selects a document content block (pdf) or image content block.
 */
export async function extractBloodwork(
  filePath: string,
  fileKind: FileKind,
  caption?: string,
): Promise<BloodworkOutput> {
  const base64 = await readBase64(filePath);
  const system = bloodworkSystemPrompt();

  const fileBlock: Anthropic.ContentBlockParam =
    fileKind === "pdf"
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        }
      : {
          type: "image",
          source: { type: "base64", media_type: imageMediaType(filePath), data: base64 },
        };

  const { value, raw } = await parseJsonWithRetry(
    async (retryHint) => {
      const res = await anthropic.messages.create({
        model: MODELS.bloodwork,
        max_tokens: MAX_TOKENS.bloodwork,
        temperature: 0,
        system,
        messages: [
          {
            role: "user",
            content: [
              fileBlock,
              {
                type: "text",
                text:
                  (caption ? `User caption: ${caption}\n\n` : "") +
                  (retryHint || "Extract every lab result per the instructions."),
              },
            ],
          },
        ],
      });
      return textOf(res);
    },
    (v) => bloodworkResultSchema.parse(v),
  );

  return { result: value, raw };
}
