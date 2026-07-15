import { describe, expect, it } from "vitest";
import {
  aggregateSessionStats,
  formatNameResult,
  formatSessionMeta,
} from "./meta.js";

describe("aggregateSessionStats", () => {
  it("counts roles and usage", () => {
    const stats = aggregateSessionStats([
      { type: "session" },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", name: "bash" },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 20,
            cacheWrite: 0,
            cost: { total: 0.012 },
          },
        },
      },
      {
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "done" }] },
      },
    ]);

    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.toolResults).toBe(1);
    expect(stats.totalMessages).toBe(3);
    expect(stats.tokens.input).toBe(10);
    expect(stats.tokens.output).toBe(5);
    expect(stats.tokens.cacheRead).toBe(20);
    expect(stats.tokens.total).toBe(35);
    expect(stats.cost).toBeCloseTo(0.012);
  });
});

describe("formatSessionMeta", () => {
  it("includes core fields", () => {
    const text = formatSessionMeta({
      name: "任务 A",
      sessionId: "abc-123",
      sessionFile: "C:/s/a.jsonl",
      cwd: "C:/proj",
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 5,
      tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, total: 35 },
      cost: 0.05,
      context: { tokens: 1000, contextWindow: 128000, percent: 1 },
      modelLine: "cpa/grok45 · thinking medium",
    });
    expect(text).toContain("名称: 任务 A");
    expect(text).toContain("ID: abc-123");
    expect(text).toContain("费用: $0.050");
    expect(text).toContain("缓存命中");
    expect(text).toContain("上下文: 1,000/128,000 (1%)");
  });
});

describe("formatNameResult", () => {
  it("formats set/clear/show", () => {
    expect(formatNameResult("x", "set")).toContain("已设置");
    expect(formatNameResult(undefined, "cleared")).toContain("已清除");
    expect(formatNameResult("y", "show")).toContain("当前会话名称：y");
    expect(formatNameResult(undefined, "show")).toContain("未设置");
  });
});
