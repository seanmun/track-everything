import { existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { config } from "../config.js";

export type FileKind = "image" | "pdf" | "other";

/** Ensure the configured FILE_DIR exists. */
export function ensureFileDir(): void {
  if (!existsSync(config.FILE_DIR)) {
    mkdirSync(config.FILE_DIR, { recursive: true });
  }
}

/**
 * Build a deterministic-ish local path for an attachment using the Telegram
 * file's unique id plus its original extension. Collisions are harmless
 * (same file id => same content).
 */
export function localPathFor(remotePath: string, fileUniqueId: string): string {
  ensureFileDir();
  const ext = extname(remotePath) || guessExt(remotePath);
  return join(config.FILE_DIR, `${fileUniqueId}${ext}`);
}

/** Download a remote URL to a local path on disk. */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
}

/** Read a local file as base64 (for Anthropic image/document content blocks). */
export async function readBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}

/** Classify a file kind from its mime type and/or filename. */
export function classifyFile(mime: string | undefined, filename: string | undefined): FileKind {
  const m = (mime ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  if (m.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif)$/.test(name)) {
    return "image";
  }
  if (m === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }
  return "other";
}

/** Map an image file to an Anthropic-supported media type. */
export function imageMediaType(path: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

function guessExt(remotePath: string): string {
  if (/photos?\//.test(remotePath)) return ".jpg";
  return "";
}
