import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
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

export interface AnalyzeImageOptions {
  caption?: string;
  /** Path to the user's previous selfie, for relative (comparative) scoring. */
  previousImagePath?: string;
  /** The previous selfie's faceBloatingScore, given to the model as context. */
  previousScore?: number | null;
}

async function imageBlock(path: string): Promise<Anthropic.ImageBlockParam> {
  return {
    type: "image",
    source: { type: "base64", media_type: imageMediaType(path), data: await readBase64(path) },
  };
}

/**
 * Analyze a selfie for appearance/facial-bloating tracking (§8).
 *
 * When a previous selfie is available it's passed as a REFERENCE so the model
 * scores relatively — this is what produces real variance instead of a flat
 * 5/10 every time.
 */
export async function analyzeImage(
  imagePath: string,
  opts: AnalyzeImageOptions = {},
): Promise<VisionOutput> {
  const hasReference = Boolean(opts.previousImagePath);
  const system = visionSystemPrompt(hasReference);

  const newBlock = await imageBlock(imagePath);
  const refBlock = opts.previousImagePath ? await imageBlock(opts.previousImagePath) : null;

  const { value, raw } = await parseJsonWithRetry(
    async (retryHint) => {
      const content: Anthropic.ContentBlockParam[] = [];

      if (refBlock) {
        content.push({
          type: "text",
          text: `REFERENCE — the user's previous selfie${
            opts.previousScore != null ? ` (previously scored ${opts.previousScore}/10)` : ""
          }:`,
        });
        content.push(refBlock);
        content.push({ type: "text", text: "NEW selfie to score, judged relative to the reference above:" });
      }
      content.push(newBlock);
      content.push({
        type: "text",
        text:
          (opts.caption ? `User caption: ${opts.caption}\n\n` : "") +
          (retryHint || "Analyze per the instructions and commit to a faceBloatingScore."),
      });

      const res = await anthropic.messages.create({
        model: MODELS.vision,
        max_tokens: MAX_TOKENS.vision,
        temperature: 0,
        system,
        messages: [{ role: "user", content }],
      });
      return textOf(res);
    },
    (v) => visionResultSchema.parse(v),
  );

  return { result: value, raw };
}
