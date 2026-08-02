import { describe, expect, it } from "vitest";
import { CardSession } from "./card-session.js";
import { buildPanelElement, buildTerminalStatus, panelContent } from "./card-renderer.js";

// ─── 渲染面板选项 ─────────────────────────────────────

const OPTIONS = {
  showThinking: true,
  panelExpanded: false,
  maxToolSteps: 20,
  maxThinkingRounds: 20,
  printStrategy: "delay" as const,
  printStep: 4,
  maxReasoningChars: 50,
  maxToolDetailChars: 30,
  maxToolOutputChars: 40,
};

function makeSession(): CardSession {
  return new CardSession("req-1", "chat-1", "msg-1", 70);
}

function renderPanelText(session: CardSession): string {
  return panelContent(buildPanelElement(session, OPTIONS));
}

// ─── 推理正文截断标注 ──────────────────────────────────

describe("推理正文截断标注", () => {
  it("thinking 超限时标注已截断且附原文长度", () => {
    const s = makeSession();
    const long = "思".repeat(120);
    s.appendThinking(long);
    const text = renderPanelText(s);
    expect(text).toContain("已截断，共 120 字");
  });

  it("thinking 未超限时不含截断标注", () => {
    const s = makeSession();
    s.appendThinking("短推理");
    const text = renderPanelText(s);
    expect(text).toContain("短推理");
    expect(text).not.toContain("已截断");
  });

  it("已完成轮次的推理同样标注（thinkingRounds 路径）", () => {
    const s = makeSession();
    s.appendThinking("前一轮".repeat(40)); // 120 字，超 50 上限
    s.finishThinking();
    const text = renderPanelText(s);
    expect(text).toContain("已截断，共 120 字");
  });
});

// ─── 工具 detail / output 截断标注 ─────────────────────

describe("工具 detail/output 截断标注", () => {
  it("工具 detail 超限时标注已截断", () => {
    const s = makeSession();
    const id = "tool-1";
    s.recordTool(id);
    s.tools.start(id, "bash", { command: "c".repeat(200) });
    const text = renderPanelText(s);
    expect(text).toContain("已截断");
  });

  it("工具 output 超限时标注已截断", () => {
    const s = makeSession();
    const id = "tool-2";
    s.recordTool(id);
    s.tools.start(id, "bash", { command: "echo hi" });
    s.tools.end(id, { content: [{ type: "text", text: "o".repeat(200) }] }, false);
    const text = renderPanelText(s);
    expect(text).toContain("已截断");
  });

  it("工具 detail 未超限时不标注", () => {
    const s = makeSession();
    const id = "tool-3";
    s.recordTool(id);
    s.tools.start(id, "read", { path: "a.ts" });
    const text = renderPanelText(s);
    expect(text).not.toContain("已截断");
  });
});

// ─── 其他调用点不受影响 ────────────────────────────────

describe("非三处的 truncate 调用保持原样", () => {
  it("错误信息截断不带标注（buildTerminalStatus 路径）", () => {
    const s = makeSession();
    s.errorMessage = "e".repeat(2500);
    const status = buildTerminalStatus(s);
    expect(status.content).toContain("\u2026"); // 仍显示省略号
    expect(status.content).not.toContain("已截断");
  });
});
