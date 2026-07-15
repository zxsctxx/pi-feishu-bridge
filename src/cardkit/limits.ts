export function countTags(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTags(item), 0);
  if (!value || typeof value !== "object") return 0;
  const object = value as Record<string, unknown>;
  return (typeof object.tag === "string" ? 1 : 0) + Object.values(object).reduce<number>((sum, item) => sum + countTags(item), 0);
}

function panelChildText(el: Record<string, unknown> | undefined): string {
  if (!el) return "";
  if (typeof el.content === "string") return el.content;
  const text = el.text as { content?: unknown } | undefined;
  return typeof text?.content === "string" ? text.content : "";
}

export function trimPanelToTagLimit<T extends Record<string, unknown>>(panel: T, maxTags = 195): T {
  const clone = structuredClone(panel);
  const elements = (clone as any).elements as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(elements)) return clone;

  // 预留 1 个 tag 给折叠提示（与 hermes 先 reserve hint 再 trim 同思路）
  const hasHint = panelChildText(elements[0]).includes("已折叠");
  const threshold = hasHint ? maxTags : Math.max(1, maxTags - 1);

  let trimmed = 0;
  while (elements.length > 1 && countTags(clone) > threshold) {
    // 保留「已折叠」提示在首部时从其后删；否则删最旧子元素
    const removeIdx = panelChildText(elements[0]).includes("已折叠") ? 1 : 0;
    if (removeIdx >= elements.length) break;
    elements.splice(removeIdx, 1);
    trimmed += 1;
  }

  if (trimmed > 0) {
    const first = elements[0];
    const firstText = panelChildText(first);
    if (firstText.includes("已折叠") && typeof first.content === "string") {
      const m = first.content.match(/(\d+)\s*项/);
      const prev = m ? Number(m[1]) : 0;
      first.content = `⚡ 还有 ${prev + trimmed} 项已折叠`;
    } else if (!firstText.includes("已折叠")) {
      elements.unshift({
        tag: "markdown",
        content: `⚡ 还有 ${trimmed} 项已折叠`,
        text_size: "notation",
      });
    }
  }

  // 插入 hint 后若仍超限，继续删（极端情况）
  while (elements.length > 1 && countTags(clone) > maxTags) {
    const removeIdx = panelChildText(elements[0]).includes("已折叠") ? 1 : 0;
    if (removeIdx >= elements.length) break;
    elements.splice(removeIdx, 1);
  }
  return clone;
}
