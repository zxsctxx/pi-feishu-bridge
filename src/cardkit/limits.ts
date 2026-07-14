export function countTags(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTags(item), 0);
  if (!value || typeof value !== "object") return 0;
  const object = value as Record<string, unknown>;
  return (typeof object.tag === "string" ? 1 : 0) + Object.values(object).reduce<number>((sum, item) => sum + countTags(item), 0);
}

export function trimPanelToTagLimit<T extends Record<string, unknown>>(panel: T, maxTags = 195): T {
  const clone = structuredClone(panel);
  const elements = (clone as any).elements;
  if (!Array.isArray(elements)) return clone;
  while (elements.length > 1 && countTags(clone) > maxTags) elements.shift();
  return clone;
}
