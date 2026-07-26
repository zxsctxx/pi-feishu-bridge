import { describe, expect, it } from "vitest";
import { accumulateUsage, type MessageUsage, type UsageEntry } from "./usage.js";

function assistant(usage: MessageUsage): UsageEntry {
  return { type: "message", message: { role: "assistant", usage } };
}

describe("accumulateUsage", () => {
  it("空会话返回全零", () => {
    const totals = accumulateUsage([]);
    expect(totals.inputTokens).toBe(0);
    expect(totals.cost).toBe(0);
    expect(totals.reasoningTokens).toBeUndefined();
    expect(totals.cacheHitPercent).toBeUndefined();
  });

  it("累加多条 assistant 消息", () => {
    const totals = accumulateUsage([
      assistant({ input: 100, output: 50, cost: { total: 0.01 } }),
      assistant({ input: 200, output: 80, cost: { total: 0.02 } }),
    ]);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(130);
    expect(totals.cost).toBeCloseTo(0.03);
  });

  it("只统计 assistant，忽略 user 与非 message 条目", () => {
    const totals = accumulateUsage([
      assistant({ input: 100 }),
      { type: "message", message: { role: "user", usage: { input: 999 } } },
      { type: "tool_result", message: { role: "assistant", usage: { input: 888 } } },
    ]);
    expect(totals.inputTokens).toBe(100);
  });

  it("无推理 token 时返回 undefined 而非 0", () => {
    expect(accumulateUsage([assistant({ input: 10 })]).reasoningTokens).toBeUndefined();
    expect(accumulateUsage([assistant({ input: 10, reasoning: 5 })]).reasoningTokens).toBe(5);
  });

  it("pending 计入累计（message_end 尚未落盘）", () => {
    const totals = accumulateUsage([assistant({ input: 100 })], { input: 50, output: 20 });
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(20);
  });

  it("缓存命中率取最近一次有缓存的请求", () => {
    const totals = accumulateUsage([
      assistant({ input: 100, cacheRead: 0, cacheWrite: 0 }),
      assistant({ input: 50, cacheRead: 150, cacheWrite: 0 }),
    ]);
    // 150 / (50 + 150 + 0) = 75%
    expect(totals.cacheHitPercent).toBeCloseTo(75);
  });

  it("无缓存时命中率为 undefined", () => {
    const totals = accumulateUsage([assistant({ input: 100, output: 20 })]);
    expect(totals.cacheHitPercent).toBeUndefined();
  });

  it("缺失字段按 0 处理", () => {
    const totals = accumulateUsage([assistant({}), assistant({ output: 5 })]);
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(5);
    expect(totals.cost).toBe(0);
  });
});
