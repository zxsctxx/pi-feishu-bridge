import type { CardSession } from "./card-session.js";
import type { ToolStep } from "./tool-tracker.js";

export const ANSWER_ELEMENT_ID = "answer_content";
export const PANEL_ELEMENT_ID = "agent_process_panel";
export const PANEL_CONTENT_ELEMENT_ID = "agent_process_text";
export const STATUS_ELEMENT_ID = "terminal_status";
export const FOOTER_ELEMENT_ID = "footer_metrics";
export const LOADING_HINT_ELEMENT_ID = "context_loading_hint";
export const LOADING_ELEMENT_ID = "loading_icon";

export interface CardRenderOptions { showThinking: boolean; panelExpanded: boolean; streamingPanelExpanded?: boolean; maxToolSteps: number; maxThinkingRounds: number; printStrategy: "fast" | "delay"; printStep: number; }
const truncate = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
function toolLine(step: ToolStep): string { const icon = step.status === "running" ? "⏳" : step.status === "error" ? "❌" : "✅"; const elapsed = step.elapsedMs ? ` · ${(step.elapsedMs / 1000).toFixed(1)}s` : ""; return `${icon} **${step.name}**${elapsed}${step.detail ? `\n${truncate(step.detail, 40)}` : ""}${step.output ? `\n${truncate(step.output, 40)}` : ""}`; }

/** Agent 保留英文；轮次/工具/耗时用中文单位。 */
export function buildPanelTitle(session: CardSession, toolCount: number, terminal = false): string {
  const rounds = session.thinkingRounds.length + (session.currentThinking ? 1 : 0);
  const end = terminal ? (session.completedAt ?? Date.now()) : Date.now();
  const elapsed = ((end - session.createdAt) / 1000).toFixed(1);
  return `Agent loop · ${rounds} 轮 · ${toolCount} 工具 · ${elapsed}s`;
}

export function buildPanelElement(session: CardSession, options: CardRenderOptions, terminal = false): Record<string, unknown> {
  const lines: string[] = [];
  const thinkingStart = Math.max(0, session.thinkingRounds.length - options.maxThinkingRounds);
  const tools = session.tools.list(options.maxToolSteps); const visible = new Set(tools.steps.map((step) => step.toolCallId));
  if (thinkingStart) lines.push(`💭 早期 ${thinkingStart} 轮推理已折叠`);
  if (tools.hidden) lines.push(`⚡ 早期 ${tools.hidden} 个工具步骤已折叠`);
  for (const event of session.panelEvents) {
    if (event.type === "thinking" && event.index >= thinkingStart) {
      const body = options.showThinking ? `\n${truncate(session.thinkingRounds[event.index] ?? "", 3500)}` : "";
      lines.push(`💭 推理 ${event.index + 1}${body}`);
    } else if (event.type === "tool" && visible.has(event.toolCallId)) {
      const step = session.tools.get(event.toolCallId); if (step) lines.push(toolLine(step));
    }
  }
  if (session.currentThinking) lines.push(options.showThinking ? `💭 推理 ${session.thinkingRounds.length + 1}\n${truncate(session.currentThinking, 3500)}` : `💭 推理 ${session.thinkingRounds.length + 1}`);
  const toolCount = tools.hidden + tools.steps.length;
  return {
    tag: "collapsible_panel",
    element_id: PANEL_ELEMENT_ID,
    expanded: terminal ? options.panelExpanded : (options.streamingPanelExpanded ?? false),
    header: { title: { tag: "plain_text", content: buildPanelTitle(session, toolCount, terminal) } },
    elements: [{ tag: "markdown", element_id: PANEL_CONTENT_ELEMENT_ID, content: lines.join("\n\n") || "正在处理…" }],
  };
}

export function panelContent(panel: Record<string, unknown>): string {
  const elements = panel.elements as Array<{ content?: unknown }> | undefined;
  const content = elements?.[0]?.content;
  return typeof content === "string" ? content : "正在处理…";
}

export function buildCreatingCard(options: CardRenderOptions): Record<string, unknown> {
  return { schema: "2.0", config: { update_multi: true, streaming_mode: true, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: options.printStep }, print_strategy: options.printStrategy }, summary: { content: "处理中…" } }, body: { elements: [
    { tag: "markdown", element_id: LOADING_HINT_ELEMENT_ID, content: "⏳ 正在加载上下文…" },
    { tag: "markdown", element_id: LOADING_ELEMENT_ID, content: " " },
  ] } };
}

export function buildTerminalStatus(session: CardSession): Record<string, unknown> {
  const status = session.phase === "completed" ? "已完成" : session.phase === "aborted" ? "已停止" : session.phase === "terminated" ? "已终止" : "失败";
  const error = session.errorMessage ? `\n**原因：** ${truncate(session.errorMessage, 2000)}` : "";
  return { tag: "markdown", element_id: STATUS_ELEMENT_ID, content: `---\n${status} · ${(((session.completedAt ?? Date.now()) - session.createdAt) / 1000).toFixed(1)}s${error}` };
}

/** 口径对齐 pi 终端 formatTokens：1.2k / 31k / 1.1M */
function compactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  const absolute = Math.abs(value);
  if (absolute < 1000) return String(Math.round(value));
  if (absolute < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (absolute < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (absolute < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function buildFooter(session: CardSession): Record<string, unknown> {
  const f = session.footer;
  const status = session.phase === "completed" ? "已完成" : session.phase === "aborted" ? "已停止" : session.phase === "terminated" ? "已终止" : "失败";
  const duration = (((session.completedAt ?? Date.now()) - session.createdAt) / 1000).toFixed(1);
  // 与终端 footer 一致：↑input ↓output RcacheRead WcacheWrite CHhit%
  const tokenParts: string[] = [];
  if (f.inputTokens) tokenParts.push(`↑${compactNumber(f.inputTokens)}`);
  if (f.outputTokens) tokenParts.push(`↓${compactNumber(f.outputTokens)}`);
  if (f.cacheRead) tokenParts.push(`R${compactNumber(f.cacheRead)}`);
  if (f.cacheWrite) tokenParts.push(`W${compactNumber(f.cacheWrite)}`);
  if (typeof f.cacheHitPercent === "number" && (f.cacheRead || f.cacheWrite)) {
    tokenParts.push(`CH${f.cacheHitPercent.toFixed(1)}%`);
  }
  // reasoning 是 output 子集；仅 provider 上报且 >0 时展示（终端无此字段，飞书额外保留）
  if (typeof f.reasoningTokens === "number" && f.reasoningTokens > 0) {
    tokenParts.push(`💭 ${compactNumber(f.reasoningTokens)}`);
  }
  const tokens = tokenParts.length > 0 ? tokenParts.join(" ") : "↑0 ↓0";
  const context = f.contextWindow
    ? `${compactNumber(f.contextTokens)}/${compactNumber(f.contextWindow)} (${Math.round(f.contextPercent ?? ((f.contextTokens ?? 0) / f.contextWindow * 100))}%)`
    : "?";
  const error = session.errorMessage ? ` · ${truncate(session.errorMessage, 300)}` : "";
  return {
    tag: "markdown",
    element_id: FOOTER_ELEMENT_ID,
    text_size: "notation",
    content: `${status} · 耗时 ${duration}s · ${f.model ?? "未知模型"} · API ${f.apiCalls}\n${tokens} · 上下文 ${context}${error}`,
  };
}

export function buildFallbackText(session: CardSession, options: CardRenderOptions): string {
  const panel = buildPanelElement(session, options, true) as { header?: { title?: { content?: string } }; elements?: Array<{ content?: string }> };
  const timeline = (panel.elements ?? []).map((element) => element.content).filter((content): content is string => Boolean(content)).join("\n\n");
  const sections = [
    session.fallbackReason ? `> ⚠️ CardKit 原生流式不可用，已切换兼容模式：${truncate(session.fallbackReason, 800)}` : "",
    timeline ? `### ${panel.header?.title?.content ?? "Agent loop"}\n\n${timeline}` : "",
    session.answer ? `### 回答\n\n${session.answer}` : "",
    session.errorMessage ? `### 错误\n\n${session.errorMessage}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function buildFallbackCard(session: CardSession, options: CardRenderOptions, terminal: boolean): Record<string, unknown> {
  const status = terminal
    ? (session.phase === "aborted" ? `⏹️ 已停止：${truncate(session.errorMessage, 1000)}` : session.phase === "terminated" ? `⚠️ 已终止：${truncate(session.errorMessage, 1000)}` : session.errorMessage ? `❌ 处理失败：${truncate(session.errorMessage, 1000)}` : "✅ 已完成（CardKit 兼容模式）")
    : "⚠️ CardKit 原生流式不可用，正在使用兼容更新模式…";
  return {
    schema: "2.0",
    config: { summary: { content: terminal ? (session.answer || session.errorMessage || "处理结束").slice(0, 120) : "处理中（兼容模式）…" } },
    body: { elements: [
      { tag: "markdown", content: status },
      buildPanelElement(session, options, terminal),
      { tag: "markdown", content: session.answer || "正在处理…" },
      ...(terminal ? [buildFooter(session)] : []),
    ] },
  };
}

export function addElementsAction(elements: Record<string, unknown>[], targetElementId: string): Record<string, unknown> {
  return { action: "add_elements", params: { type: "insert_before", target_element_id: targetElementId, elements } };
}

export function deleteElementsAction(elementIds: string[]): Record<string, unknown> {
  return { action: "delete_elements", params: { element_ids: elementIds } };
}

export function partialUpdateElementAction(elementId: string, partialElement: Record<string, unknown>): Record<string, unknown> {
  return { action: "partial_update_element", params: { element_id: elementId, partial_element: partialElement } };
}
