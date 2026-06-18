import { z } from "zod";
import { config as loadEnv } from "dotenv";

loadEnv();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ALLOWED_TELEGRAM_USER_ID: z.coerce.number().int().positive(),
  DB_PATH: z.string().default("./data/lifelog.db"),
  FILE_DIR: z.string().default("./data/files"),
  TZ: z.string().default("America/New_York"),
  OURA_CLIENT_ID: z.string().default(""),
  OURA_CLIENT_SECRET: z.string().default(""),
  OURA_REDIRECT_URI: z.string().default("http://localhost:3000/oura/callback"),
  OAUTH_HTTP_PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

// Timezone is fixed for the single user; ensure downstream date math uses it.
process.env.TZ = config.TZ;

export const MODELS = {
  parse: "claude-sonnet-4-6",
  vision: "claude-sonnet-4-6",
  bloodwork: "claude-sonnet-4-6",
  analysis: "claude-opus-4-8",
} as const;

export const MAX_TOKENS = {
  parse: 4096,
  vision: 2048,
  bloodwork: 4096,
  analysis: 8192,
} as const;
