import { describe, expect, it } from "vitest";

/**
 * 与 FeishuClient.tryRecordDedupKeys 等价的纯逻辑，避免拉起完整 SDK 客户端。
 */
function tryRecordDedupKeys(
  map: Map<string, number>,
  keys: string[],
  now: number,
  ttlMs: number,
  maxEntries: number,
): boolean {
  const unique = [...new Set(keys.filter(Boolean))];
  for (const key of unique) {
    const existing = map.get(key);
    if (existing !== undefined && now - existing < ttlMs) return false;
  }
  while (map.size + unique.length > maxEntries) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
  for (const key of unique) map.set(key, now);
  return true;
}

describe("inbound message dedup keys", () => {
  const TTL = 10 * 60 * 1000;

  it("accepts first delivery and rejects redelivery via either key", () => {
    const map = new Map<string, number>();
    const now = Date.now();
    expect(tryRecordDedupKeys(map, ["t1:m1", "mid:m1"], now, TTL, 100)).toBe(true);
    expect(tryRecordDedupKeys(map, ["t1:m1", "mid:m1"], now + 1000, TTL, 100)).toBe(false);
    // tenant 变化但 message_id 相同仍应命中 mid: 键
    expect(tryRecordDedupKeys(map, ["unknown:m1", "mid:m1"], now + 2000, TTL, 100)).toBe(false);
  });

  it("allows reuse after TTL expires", () => {
    const map = new Map<string, number>();
    const now = Date.now();
    expect(tryRecordDedupKeys(map, ["t1:m1", "mid:m1"], now, TTL, 100)).toBe(true);
    expect(tryRecordDedupKeys(map, ["t1:m1", "mid:m1"], now + TTL + 1, TTL, 100)).toBe(true);
  });
});
