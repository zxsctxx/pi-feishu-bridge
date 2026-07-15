import { describe, expect, it } from "vitest";
import {
  clipPreview,
  formatRelativeTime,
  formatResumeList,
  formatSessionListLine,
  resolveSessionFromArg,
  type ResumeSessionInfo,
} from "./resume.js";

function sess(partial: Partial<ResumeSessionInfo> & Pick<ResumeSessionInfo, "id" | "path">): ResumeSessionInfo {
  return {
    name: partial.name,
    modified: partial.modified ?? new Date("2026-07-15T12:00:00Z"),
    messageCount: partial.messageCount ?? 3,
    firstMessage: partial.firstMessage ?? "hello world",
    cwd: partial.cwd,
    id: partial.id,
    path: partial.path,
  };
}

describe("clipPreview", () => {
  it("keeps short text", () => {
    expect(clipPreview("abc")).toBe("abc");
  });

  it("collapses whitespace and truncates", () => {
    const long = "a".repeat(60);
    expect(clipPreview(long, 10)).toBe(`${"a".repeat(9)}…`);
    expect(clipPreview("foo\n\tbar")).toBe("foo bar");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-15T12:00:00Z");

  it("formats recent buckets", () => {
    expect(formatRelativeTime(new Date(now - 10_000), now)).toBe("刚刚");
    expect(formatRelativeTime(new Date(now - 5 * 60_000), now)).toBe("5 分钟前");
    expect(formatRelativeTime(new Date(now - 3 * 3600_000), now)).toBe("3 小时前");
    expect(formatRelativeTime(new Date(now - 2 * 86400_000), now)).toBe("2 天前");
  });
});

describe("formatSessionListLine", () => {
  it("marks current session", () => {
    const s = sess({ id: "abc12345", path: "/tmp/a.jsonl", name: "任务 A" });
    const line = formatSessionListLine(1, s, "abc12345");
    expect(line).toContain("1. 任务 A ← 当前");
    expect(line).toContain("abc12345");
  });
});

describe("formatResumeList", () => {
  it("shows empty help", () => {
    const text = formatResumeList([]);
    expect(text).toContain("没有可恢复的会话");
    expect(text).toContain("/resume");
  });

  it("lists with limit note", () => {
    const sessions = Array.from({ length: 3 }, (_, i) =>
      sess({
        id: `id${i}`,
        path: `/p/${i}.jsonl`,
        name: `S${i}`,
        firstMessage: `msg ${i}`,
      }),
    );
    const text = formatResumeList(sessions, { currentId: "id1", limit: 2 });
    expect(text).toContain("最近 2/3");
    expect(text).toContain("S1 ← 当前");
    expect(text).toContain("另有 1 个未显示");
  });
});

describe("resolveSessionFromArg", () => {
  const sessions = [
    sess({ id: "aaa11111-xxxx", path: "C:/s/a.jsonl", name: "Alpha", firstMessage: "fix login" }),
    sess({ id: "bbb22222-yyyy", path: "C:/s/b.jsonl", name: "Beta", firstMessage: "refactor api" }),
    sess({ id: "bbb33333-zzzz", path: "C:/s/c.jsonl", firstMessage: "other work" }),
  ];

  it("resolves 1-based index in window", () => {
    const r = resolveSessionFromArg(sessions, "2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.id).toBe("bbb22222-yyyy");
  });

  it("rejects out-of-range index", () => {
    const r = resolveSessionFromArg(sessions, "9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("超出");
  });

  it("resolves unique id prefix", () => {
    const r = resolveSessionFromArg(sessions, "aaa");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.name).toBe("Alpha");
  });

  it("reports ambiguous id prefix", () => {
    const r = resolveSessionFromArg(sessions, "bbb");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("多个");
  });

  it("resolves unique name fragment", () => {
    const r = resolveSessionFromArg(sessions, "alpha");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.id).toBe("aaa11111-xxxx");
  });

  it("resolves firstMessage fragment", () => {
    const r = resolveSessionFromArg(sessions, "refactor");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.id).toBe("bbb22222-yyyy");
  });

  it("errors on empty", () => {
    const r = resolveSessionFromArg(sessions, "  ");
    expect(r.ok).toBe(false);
  });
});
