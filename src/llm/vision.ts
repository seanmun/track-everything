import { z } from "zod";
import { MODELS, MAX_TOKENS } from "../config.js";
import { anthropic, textOf, parseJsonWithRetry } from "./anthropic.js";
import { visionSystemPrompt } from "./prompts.js";
import { readBase64, imageMediaType } from "../util/files.js";

const visionResultSchema = z.object({
  faceBloatingScore: z.number(),
  underEyePuffiness: z.number(),
  skinTone: z.enum(["pale", "normal", "flushed", "tanned", "sunburned"]).catch("normal"),
  redness: z.number(),
  blemishes: z.array(z.string()).default([]),
  jawlineDefinition: z.enum(["sharp", "moderate", "soft"]).catch("moderate"),
  otherObservations: z.array(z.string()).default([]),
  confidence: z.number(),
});

export type VisionResult = z.infer<typeof visionResultSchema>;

export interface VisionOutput {
  result: VisionResult;
  raw: string;
}

/**
 * Analyze a selfie image for appearance/facial-bloating tracking (§8).
 */
export async function analyzeImage(imagePath: string, caption?: string): Promise<VisionOutput> {
  const base64 = await readBase64(imagePath);
  const mediaType = imageMediaType(imagePath);
  const system = visionSystemPrompt();

  const { value, raw } = await parseJsonWithRetry(
    async (retryHint) => {
      const res = await anthropic.messages.create({
        model: MODELS.vision,
        max_tokens: MAX_TOKENS.vision,
        temperature: 0,
        system,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text:
                  (caption ? `User caption: ${caption}\n\n` : "") +
                  (retryHint || "Analyze this photo per the instructions."),
              },
            ],
          },
        ],
      });
      return textOf(res);
    },
    (v) => visionResultSchema.parse(v),
  );

  return { result: value, raw };
}
