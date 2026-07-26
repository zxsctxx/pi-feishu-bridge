export function normalizeMarkdown(input: string): string {
  const lines = input.replace(/!\[[^\]]*\]\((?!https?:\/\/)[^)]+\)/g, "").split("\n");
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.replace(/^(#{1,6})\s+/, (_match, hashes: string) => `${"#".repeat(Math.min(6, hashes.length + 2))} `);
  }).join("\n");
}

export interface MarkdownSplit { head: string; tail: string; consumed: number; }

export function splitMarkdown(input: string, limit: number): MarkdownSplit {
  if (input.length <= limit) return { head: input, tail: "", consumed: input.length };
  const search = input.slice(0, limit);
  let boundary = Math.max(search.lastIndexOf("\n\n"), search.lastIndexOf("\n"), search.lastIndexOf(" "));
  if (boundary < Math.floor(limit * 0.5)) boundary = limit;
  let head = input.slice(0, boundary); let tail = input.slice(boundary).replace(/^\s+/, "");
  const fences = [...head.matchAll(/^\s*```([^\n]*)/gm)];
  if (fences.length % 2 === 1) {
    const language = fences[fences.length - 1][1]?.trim() ?? "";
    head += "\n```";
    tail = `\`\`\`${language}\n${tail}`;
  }
  return { head, tail, consumed: boundary };
}

/**
 * 按卡片长度上限反复切分，用于静态消息发送。
 * 默认 30000 适配 interactive 卡片；空串返回单个空块，保证至少发一条。
 */
export function splitTextCards(text: string, limit = 30000): string[] {
  if (!text) return [""];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const split = splitMarkdown(remaining, limit);
    chunks.push(split.head);
    remaining = split.tail;
  }
  chunks.push(remaining);
  return chunks;
}
