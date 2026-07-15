import type { CardSession } from "./card-session.js";
import type { ToolStep } from "./tool-tracker.js";

export const ANSWER_ELEMENT_ID = "answer_content";
export const PANEL_ELEMENT_ID = "agent_process_panel";
/** @deprecated 多元素面板后不再使用单 markdown 内容 id；保留导出以免外部引用断裂 */
export const PANEL_CONTENT_ELEMENT_ID = "agent_process_text";
export const STATUS_ELEMENT_ID = "terminal_status";
export const FOOTER_ELEMENT_ID = "footer_metrics";
export const LOADING_HINT_ELEMENT_ID = "context_loading_hint";
export const LOADING_ELEMENT_ID = "loading_icon";

export interface CardRenderOptions {
  showThinking: boolean;
  panelExpanded: boolean;
  streamingPanelExpanded?: boolean;
  maxToolSteps: number;
  maxThinkingRounds: number;
  printStrategy: "fast" | "delay";
  printStep: number;
}

/** 推理正文上限（单轮）；工具 detail/output 另有更短展示上限 */
const REASONING_LIMIT = 3500;
const TOOL_DETAIL_LIMIT = 500;
const TOOL_OUTPUT_LIMIT = 800;

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

const MD_SPECIAL = /([`*_{}\[\]<>])/g;

/** 防止工具名等在 lark_md 中被解析为标记 */
function escapeMd(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(MD_SPECIAL, "\\$1");
}

function statusIcon(status: ToolStep["status"]): string {
  if (status === "running") return "⏳";
  if (status === "error") return "❌";
  return "✅";
}

function statusColor(status: ToolStep["status"]): string {
  if (status === "running") return "orange";
  if (status === "error") return "red";
  return "green";
}

function mdTitle(content: string, color?: string): Record<string, unknown> {
  const body = color ? `<font color='${color}'>**${content}**</font>` : `**${content}**`;
  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content: body,
      text_size: "notation",
    },
  };
}

function plainIndented(content: string): Record<string, unknown> {
  return {
    tag: "div",
    margin: "0px 0px 0px 22px",
    text: {
      tag: "plain_text",
      content,
      text_color: "grey",
      text_size: "notation",
    },
  };
}

function mdIndented(content: string): Record<string, unknown> {
  return {
    tag: "div",
    margin: "0px 0px 0px 22px",
    text: {
      tag: "lark_md",
      content,
      text_size: "notation",
    },
  };
}

function notationLine(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_size: "notation",
  };
}

/** 工具：标题(lark_md) + detail(plain_text) + output(安全 fence) */
function buildToolElements(step: ToolStep): Record<string, unknown>[] {
  const elapsed = step.elapsedMs ? ` · ${(step.elapsedMs / 1000).toFixed(1)}s` : "";
  const title = `${statusIcon(step.status)} ${escapeMd(step.name)}${elapsed}`;
  const out: Record<string, unknown>[] = [mdTitle(title, statusColor(step.status))];

  const detail = step.detail?.trim();
  if (detail) out.push(plainIndented(truncate(detail, TOOL_DETAIL_LIMIT)));

  // 输出已是人类可读一行；plain_text 避免再被当成 JSON 代码块
  const output = step.output?.trim();
  if (output) out.push(plainIndented(truncate(output, TOOL_OUTPUT_LIMIT)));
  return out;
}

/** 推理：标题 + 正文(lark_md，独立元素，不与工具 JSON 拼成一大段 markdown) */
function buildReasoningElements(index: number, text: string, showBody: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [mdTitle(`💭 推理 ${index}`)];
  if (showBody && text.trim()) {
    out.push(mdIndented(truncate(text, REASONING_LIMIT)));
  }
  return out;
}

/** Agent 保留英文；轮次/工具/耗时用中文单位。 */
export function buildPanelTitle(session: CardSession, toolCount: number, terminal = false): string {
  const rounds = session.thinkingRounds.length + (session.currentThinking ? 1 : 0);
  const end = terminal ? (session.completedAt ?? Date.now()) : Date.now();
  const elapsed = ((end - session.createdAt) / 1000).toFixed(1);
  return `Agent loop · ${rounds} 轮 · ${toolCount} 工具 · ${elapsed}s`;
}

/**
 * 统一过程面板：多子元素结构（对齐 hermes-lark-streaming）。
 * - 工具 detail → plain_text（避免 JSON 被 markdown 当成代码块）
 * - 工具 output → 安全 fence 代码块（可控展示）
 * - 推理 → 独立 div/lark_md，不与工具拼成单段 markdown
 */
export function buildPanelElement(
  session: CardSession,
  options: CardRenderOptions,
  terminal = false,
): Record<string, unknown> {
  const children: Record<string, unknown>[] = [];
  const thinkingStart = Math.max(0, session.thinkingRounds.length - options.maxThinkingRounds);
  const tools = session.tools.list(options.maxToolSteps);
  const visible = new Set(tools.steps.map((step) => step.toolCallId));

  if (thinkingStart) {
    children.push(notationLine(`💭 早期 ${thinkingStart} 轮推理已折叠`));
  }
  if (tools.hidden) {
    children.push(notationLine(`⚡ 早期 ${tools.hidden} 个工具步骤已折叠`));
  }

  for (const event of session.panelEvents) {
    if (event.type === "thinking" && event.index >= thinkingStart) {
      const body = options.showThinking ? (session.thinkingRounds[event.index] ?? "") : "";
      children.push(...buildReasoningElements(event.index + 1, body, options.showThinking));
    } else if (event.type === "tool" && visible.has(event.toolCallId)) {
      const step = session.tools.get(event.toolCallId);
      if (step) children.push(...buildToolElements(step));
    }
  }

  if (session.currentThinking) {
    children.push(
      ...buildReasoningElements(
        session.thinkingRounds.length + 1,
        session.currentThinking,
        options.showThinking,
      ),
    );
  }

  if (children.length === 0) {
    children.push({ tag: "markdown", content: "正在处理…", text_size: "notation" });
  }

  const toolCount = tools.hidden + tools.steps.length;
  return {
    tag: "collapsible_panel",
    element_id: PANEL_ELEMENT_ID,
    expanded: terminal ? options.panelExpanded : (options.streamingPanelExpanded ?? false),
    header: {
      title: {
        tag: "plain_text",
        content: buildPanelTitle(session, toolCount, terminal),
      },
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "4px",
    padding: "8px 8px 8px 8px",
    elements: children,
  };
}

/** 从多元素面板抽出纯文本（fallback / 调试用） */
export function panelContent(panel: Record<string, unknown>): string {
  const elements = panel.elements as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(elements) || elements.length === 0) return "正在处理…";
  const parts: string[] = [];
  for (const el of elements) {
    if (typeof el.content === "string" && el.content.trim()) {
      parts.push(el.content);
      continue;
    }
    const text = el.text as { content?: unknown } | undefined;
    if (text && typeof text.content === "string" && text.content.trim()) {
      parts.push(text.content);
    }
  }
  return parts.join("\n") || "正在处理…";
}

export function buildCreatingCard(options: CardRenderOptions): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: options.printStep },
        print_strategy: options.printStrategy,
      },
      summary: { content: "处理中…" },
    },
    body: {
      elements: [
        { tag: "markdown", element_id: LOADING_HINT_ELEMENT_ID, content: "⏳ 正在加载上下文…" },
        { tag: "markdown", element_id: LOADING_ELEMENT_ID, content: " " },
      ],
    },
  };
}

export function buildTerminalStatus(session: CardSession): Record<string, unknown> {
  const status =
    session.phase === "completed"
      ? "已完成"
      : session.phase === "aborted"
        ? "已停止"
        : session.phase === "terminated"
          ? "已终止"
          : "失败";
  const error = session.errorMessage ? `\n**原因：** ${truncate(session.errorMessage, 2000)}` : "";
  return {
    tag: "markdown",
    element_id: STATUS_ELEMENT_ID,
    content: `---\n${status} · ${(((session.completedAt ?? Date.now()) - session.createdAt) / 1000).toFixed(1)}s${error}`,
  };
}

/** 口径对齐 pi 终端 formatTokens：1.2k / 31k / 1.1M */
/** 展示用压缩数字：1.5K / 122.2K / 1.1M（仅格式，不改取值） */
function compactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  const absolute = Math.abs(value);
  if (absolute < 1000) return String(Math.round(value));
  if (absolute < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function buildFooter(session: CardSession): Record<string, unknown> {
  const f = session.footer;
  const status =
    session.phase === "completed"
      ? "已完成"
      : session.phase === "aborted"
        ? "已停止"
        : session.phase === "terminated"
          ? "已终止"
          : "失败";
  const duration = (((session.completedAt ?? Date.now()) - session.createdAt) / 1000).toFixed(1);

  // 第二行展示：↑ input ↓ output 💭 reasoning · 上下文 · 缓存 read/prompt (hit%)
  // 字段仍来自 footer 既有累计值，不在此重新统计
  const input = f.inputTokens ?? 0;
  const output = f.outputTokens ?? 0;
  const cacheRead = f.cacheRead ?? 0;
  const cacheWrite = f.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;

  const tokenParts = [`↑ ${compactNumber(input)}`, `↓ ${compactNumber(output)}`];
  if (typeof f.reasoningTokens === "number" && f.reasoningTokens > 0) {
    tokenParts.push(`💭 ${compactNumber(f.reasoningTokens)}`);
  }
  const tokens = tokenParts.join(" ");

  const context = f.contextWindow
    ? `${compactNumber(f.contextTokens)}/${compactNumber(f.contextWindow)} (${Math.round(f.contextPercent ?? ((f.contextTokens ?? 0) / f.contextWindow * 100))}%)`
    : "?";

  let cache = "";
  if (cacheRead > 0 || cacheWrite > 0) {
    // 与分子/分母同一口径：会话累计 cacheRead / (input+cacheRead+cacheWrite)
    // 不用 footer.cacheHitPercent（那是最后一次请求的 CH，会和累计分数不一致）
    const denom = promptTokens > 0 ? promptTokens : cacheRead + cacheWrite;
    const hit = denom > 0 ? (cacheRead / denom) * 100 : 0;
    cache = ` · 缓存 ${compactNumber(cacheRead)}/${compactNumber(denom)} (${Math.round(hit)}%)`;
  }

  const error = session.errorMessage ? ` · ${truncate(session.errorMessage, 300)}` : "";
  return {
    tag: "markdown",
    element_id: FOOTER_ELEMENT_ID,
    text_size: "notation",
    content: `${status} · 耗时 ${duration}s · ${f.model ?? "未知模型"} · API ${f.apiCalls}\n${tokens} · 上下文 ${context}${cache}${error}`,
  };
}

export function buildFallbackText(session: CardSession, options: CardRenderOptions): string {
  const panel = buildPanelElement(session, options, true);
  const title =
    (panel.header as { title?: { content?: string } } | undefined)?.title?.content ?? "Agent loop";
  const timeline = panelContent(panel);
  const sections = [
    session.fallbackReason
      ? `> ⚠️ CardKit 原生流式不可用，已切换兼容模式：${truncate(session.fallbackReason, 800)}`
      : "",
    timeline ? `### ${title}\n\n${timeline}` : "",
    session.answer ? `### 回答\n\n${session.answer}` : "",
    session.errorMessage ? `### 错误\n\n${session.errorMessage}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function buildFallbackCard(
  session: CardSession,
  options: CardRenderOptions,
  terminal: boolean,
): Record<string, unknown> {
  const status = terminal
    ? session.phase === "aborted"
      ? `⏹️ 已停止：${truncate(session.errorMessage, 1000)}`
      : session.phase === "terminated"
        ? `⚠️ 已终止：${truncate(session.errorMessage, 1000)}`
        : session.errorMessage
          ? `❌ 处理失败：${truncate(session.errorMessage, 1000)}`
          : "✅ 已完成（CardKit 兼容模式）"
    : "⚠️ CardKit 原生流式不可用，正在使用兼容更新模式…";
  return {
    schema: "2.0",
    config: {
      summary: {
        content: terminal
          ? (session.answer || session.errorMessage || "处理结束").slice(0, 120)
          : "处理中（兼容模式）…",
      },
    },
    body: {
      elements: [
        { tag: "markdown", content: status },
        buildPanelElement(session, options, terminal),
        { tag: "markdown", content: session.answer || "正在处理…" },
        ...(terminal ? [buildFooter(session)] : []),
      ],
    },
  };
}

export function addElementsAction(
  elements: Record<string, unknown>[],
  targetElementId: string,
): Record<string, unknown> {
  return {
    action: "add_elements",
    params: { type: "insert_before", target_element_id: targetElementId, elements },
  };
}

export function deleteElementsAction(elementIds: string[]): Record<string, unknown> {
  return { action: "delete_elements", params: { element_ids: elementIds } };
}

export function partialUpdateElementAction(
  elementId: string,
  partialElement: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action: "partial_update_element",
    params: { element_id: elementId, partial_element: partialElement },
  };
}
