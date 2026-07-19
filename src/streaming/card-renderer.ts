import type { FooterConfig, FooterFieldId } from "../types.js";
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

/** 默认两行布局，保持与 2.0 既有行为一致 */
export const DEFAULT_FOOTER_LINES: FooterFieldId[][] = [
  ["status", "elapsed", "model", "api_calls"],
  ["tokens", "context", "cache", "error"],
];

const FOOTER_FIELD_ALIASES: Record<string, FooterFieldId> = {
  status: "status",
  elapsed: "elapsed",
  duration: "elapsed",
  time: "elapsed",
  model: "model",
  api: "api_calls",
  api_calls: "api_calls",
  apicalls: "api_calls",
  tokens: "tokens",
  token: "tokens",
  context: "context",
  cache: "cache",
  error: "error",
  cost: "cost",
  stop_reason: "stop_reason",
  stopreason: "stop_reason",
};

export interface CardRenderOptions {
  showThinking: boolean;
  panelExpanded: boolean;
  streamingPanelExpanded?: boolean;
  maxToolSteps: number;
  maxThinkingRounds: number;
  printStrategy: "fast" | "delay";
  printStep: number;
  /** CardKit print_frequency_ms，默认 70 */
  printFrequencyMs?: number;
  /** 单轮推理正文展示上限，默认 3500 */
  maxReasoningChars?: number;
  /** 工具 detail 展示上限，默认 500 */
  maxToolDetailChars?: number;
  /** 工具 output 展示上限，默认 800 */
  maxToolOutputChars?: number;
  /** 页脚布局；未配置时用 DEFAULT_FOOTER_LINES */
  footer?: FooterConfig;
}

export const DEFAULT_REASONING_CHARS = 3500;
export const DEFAULT_TOOL_DETAIL_CHARS = 500;
export const DEFAULT_TOOL_OUTPUT_CHARS = 800;
export const DEFAULT_PRINT_FREQUENCY_MS = 70;

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
function buildToolElements(
  step: ToolStep,
  detailLimit: number,
  outputLimit: number,
): Record<string, unknown>[] {
  const elapsed = step.elapsedMs ? ` · ${(step.elapsedMs / 1000).toFixed(1)}s` : "";
  const title = `${statusIcon(step.status)} ${escapeMd(step.name)}${elapsed}`;
  const out: Record<string, unknown>[] = [mdTitle(title, statusColor(step.status))];

  const detail = step.detail?.trim();
  if (detail) out.push(plainIndented(truncate(detail, detailLimit)));

  // 输出已是人类可读一行；plain_text 避免再被当成 JSON 代码块
  const output = step.output?.trim();
  if (output) out.push(plainIndented(truncate(output, outputLimit)));
  return out;
}

/** 推理：标题 + 正文(lark_md，独立元素，不与工具 JSON 拼成一大段 markdown) */
function buildReasoningElements(
  index: number,
  text: string,
  showBody: boolean,
  reasoningLimit: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [mdTitle(`💭 推理 ${index}`)];
  if (showBody && text.trim()) {
    out.push(mdIndented(truncate(text, reasoningLimit)));
  }
  return out;
}

/** Agent 保留英文；轮次/工具/耗时用中文单位。耗时 = 过程活动墙钟，不是整轮 footer 时间。 */
export function buildPanelTitle(session: CardSession, toolCount: number, terminal = false): string {
  const rounds = session.thinkingRounds.length + (session.currentThinking ? 1 : 0);
  const elapsed = session.loopSeconds(terminal).toFixed(1);
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
  const reasoningLimit = options.maxReasoningChars ?? DEFAULT_REASONING_CHARS;
  const detailLimit = options.maxToolDetailChars ?? DEFAULT_TOOL_DETAIL_CHARS;
  const outputLimit = options.maxToolOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;

  if (thinkingStart) {
    children.push(notationLine(`💭 早期 ${thinkingStart} 轮推理已折叠`));
  }
  if (tools.hidden) {
    children.push(notationLine(`⚡ 早期 ${tools.hidden} 个工具步骤已折叠`));
  }

  for (const event of session.panelEvents) {
    if (event.type === "thinking" && event.index >= thinkingStart) {
      const body = options.showThinking ? (session.thinkingRounds[event.index] ?? "") : "";
      children.push(...buildReasoningElements(event.index + 1, body, options.showThinking, reasoningLimit));
    } else if (event.type === "tool" && visible.has(event.toolCallId)) {
      const step = session.tools.get(event.toolCallId);
      if (step) children.push(...buildToolElements(step, detailLimit, outputLimit));
    }
  }

  if (session.currentThinking) {
    children.push(
      ...buildReasoningElements(
        session.thinkingRounds.length + 1,
        session.currentThinking,
        options.showThinking,
        reasoningLimit,
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
    // header 与 footer 同用 notation，避免标题比指标行更抢眼
    header: {
      title: {
        tag: "plain_text",
        content: buildPanelTitle(session, toolCount, terminal),
        text_size: "notation",
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
        print_frequency_ms: { default: options.printFrequencyMs ?? DEFAULT_PRINT_FREQUENCY_MS },
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
    content: `---\n${status} · ${session.wallClockSeconds().toFixed(1)}s${error}`,
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

function resolveFooterFieldId(raw: unknown): FooterFieldId | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/-/g, "_");
  return FOOTER_FIELD_ALIASES[key] ?? null;
}

/**
 * 规范化 footer.lines：外层 = 行，内层 = 同行字段。
 * 过滤未知字段与空行；空配置回退默认两行。
 */
export function normalizeFooterLines(lines: unknown): FooterFieldId[][] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return DEFAULT_FOOTER_LINES.map((line) => [...line]);
  }
  const out: FooterFieldId[][] = [];
  for (const row of lines) {
    if (!Array.isArray(row)) continue;
    const fields = row
      .map((item) => resolveFooterFieldId(item))
      .filter((id): id is FooterFieldId => id !== null);
    if (fields.length > 0) out.push(fields);
  }
  return out.length > 0 ? out : DEFAULT_FOOTER_LINES.map((line) => [...line]);
}

function formatFooterField(id: FooterFieldId, session: CardSession): string | null {
  const f = session.footer;
  if (id === "status") {
    if (session.phase === "completed") return "已完成";
    if (session.phase === "aborted") return "已停止";
    if (session.phase === "terminated") return "已终止";
    return "失败";
  }
  if (id === "elapsed") {
    // footer：整轮墙钟（建卡 → 终态），通常 ≥ 过程面板时间
    return `耗时 ${session.wallClockSeconds().toFixed(1)}s`;
  }
  if (id === "model") return f.model ?? "未知模型";
  if (id === "api_calls") return `API ${f.apiCalls}`;
  if (id === "tokens") {
    const input = f.inputTokens ?? 0;
    const output = f.outputTokens ?? 0;
    const parts = [`↑ ${compactNumber(input)}`, `↓ ${compactNumber(output)}`];
    if (typeof f.reasoningTokens === "number" && f.reasoningTokens > 0) {
      parts.push(`💭 ${compactNumber(f.reasoningTokens)}`);
    }
    return parts.join(" ");
  }
  if (id === "context") {
    if (!f.contextWindow) return "上下文 ?";
    const pct = Math.round(
      f.contextPercent ?? ((f.contextTokens ?? 0) / f.contextWindow) * 100,
    );
    return `上下文 ${compactNumber(f.contextTokens)}/${compactNumber(f.contextWindow)} (${pct}%)`;
  }
  if (id === "cache") {
    const input = f.inputTokens ?? 0;
    const cacheRead = f.cacheRead ?? 0;
    const cacheWrite = f.cacheWrite ?? 0;
    if (cacheRead <= 0 && cacheWrite <= 0) return null;
    // 会话累计 cacheRead / (input+cacheRead+cacheWrite)，不用单次 CH
    const promptTokens = input + cacheRead + cacheWrite;
    const denom = promptTokens > 0 ? promptTokens : cacheRead + cacheWrite;
    const hit = denom > 0 ? (cacheRead / denom) * 100 : 0;
    return `缓存 ${compactNumber(cacheRead)}/${compactNumber(denom)} (${Math.round(hit)}%)`;
  }
  if (id === "error") {
    return session.errorMessage ? truncate(session.errorMessage, 300) : null;
  }
  if (id === "cost") {
    if (typeof f.cost !== "number" || !Number.isFinite(f.cost)) return null;
    return `$${f.cost.toFixed(4)}`;
  }
  if (id === "stop_reason") {
    return f.stopReason ? `停止 ${f.stopReason}` : null;
  }
  return null;
}

/** 按 lines 模板拼页脚；空值字段跳过，空行丢弃 */
export function formatFooterContent(
  session: CardSession,
  lines: FooterFieldId[][] = DEFAULT_FOOTER_LINES,
): string {
  const rendered: string[] = [];
  for (const row of lines) {
    const parts: string[] = [];
    for (const id of row) {
      const text = formatFooterField(id, session);
      if (text) parts.push(text);
    }
    if (parts.length > 0) rendered.push(parts.join(" · "));
  }
  return rendered.join("\n");
}

export function buildFooter(
  session: CardSession,
  footerConfig?: FooterConfig,
): Record<string, unknown> | null {
  if (footerConfig?.showFooter === false) return null;
  const lines = normalizeFooterLines(footerConfig?.lines);
  const content = formatFooterContent(session, lines);
  if (!content.trim()) return null;
  return {
    tag: "markdown",
    element_id: FOOTER_ELEMENT_ID,
    text_size: "notation",
    content,
  };
}

export function buildFallbackText(session: CardSession, options: CardRenderOptions): string {
  const panel = buildPanelElement(session, options, true);
  const title =
    (panel.header as { title?: { content?: string } } | undefined)?.title?.content ?? "Agent loop";
  const timeline = panelContent(panel);
  const answer = (session.answer || "").trim();
  const error = (session.errorMessage || "").trim();
  // 空正文兜底：stop_reason / 错误 / 时间线尾部，避免飞书侧只剩空白终态
  let answerSection = answer;
  if (!answerSection) {
    const stop = session.footer.stopReason ? `stop_reason=${session.footer.stopReason}` : "";
    const tail = timeline ? truncate(timeline.replace(/\s+/g, " ").trim(), 300) : "";
    if (error) answerSection = `处理结束，但未生成文本回复。\n\n错误：${error}${stop ? `\n${stop}` : ""}`;
    else if (stop || tail) answerSection = `处理结束，但未生成文本回复。${stop ? `\n${stop}` : ""}${tail ? `\n…${tail}` : ""}`;
    else answerSection = "处理结束，但未生成文本回复。";
  }
  const sections = [
    session.fallbackReason
      ? `> ⚠️ CardKit 原生流式不可用，已切换兼容模式：${truncate(session.fallbackReason, 800)}`
      : "",
    timeline ? `### ${title}\n\n${timeline}` : "",
    `### 回答\n\n${answerSection}`,
    error && answer ? `### 错误\n\n${error}` : "",
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
        ...(terminal ? footerElements(session, options.footer) : []),
      ],
    },
  };
}

/** buildFooter 可能返回 null（showFooter=false 或内容为空） */
export function footerElements(
  session: CardSession,
  footerConfig?: FooterConfig,
): Record<string, unknown>[] {
  const footer = buildFooter(session, footerConfig);
  return footer ? [footer] : [];
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
