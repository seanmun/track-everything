const TELEGRAM_MAX = 4096;

/**
 * Split a long message into chunks under Telegram's 4096-char limit,
 * preferring to break on paragraph/line/word boundaries.
 */
export function chunkMessage(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    let slice = remaining.slice(0, max);

    // Prefer breaking on the last paragraph break, then newline, then space.
    let breakAt = slice.lastIndexOf("\n\n");
    if (breakAt < max * 0.5) breakAt = slice.lastIndexOf("\n");
    if (breakAt < max * 0.5) breakAt = slice.lastIndexOf(" ");
    if (breakAt <= 0) breakAt = max;

    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
