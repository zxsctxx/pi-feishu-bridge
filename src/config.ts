/**
 * 配置加载与校验。
 *
 * 优先级（从高到低）：环境变量 → 项目 .pi/settings.json → 全局 ~/.pi/agent/settings.json。
 * CLI 标志由 index.ts 在客户端启动时叠加（需要 pi.getFlag，此处拿不到）。
 *
 * 3.0 起 settings.json 只接受 camelCase 键名。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FeishuConfig, FooterConfig, FooterFieldId } from "./types.js";
import { DEFAULT_ACCESS_POLICY } from "./access/policy.js";

/** 数值字段的取值区间；超出时钳制而非报错，避免因配置笔误直接不可用 */
export const LIMITS = {
  flushIntervalMs: { min: 80, max: 2000, fallback: 200 },
  printStep: { min: 1, max: 100, fallback: 4 },
  maxToolSteps: { min: 1, max: 200, fallback: 20 },
  maxThinkingRounds: { min: 1, max: 200, fallback: 20 },
  maxAnswerElementChars: { min: 1000, max: 30000, fallback: 30000 },
  maxReasoningChars: { min: 200, max: 30000, fallback: 3500 },
  maxToolDetailChars: { min: 50, max: 10000, fallback: 500 },
  maxToolOutputChars: { min: 50, max: 10000, fallback: 800 },
  printFrequencyMs: { min: 20, max: 1000, fallback: 70 },
  clarifyTimeoutSec: { min: 10, max: 3600, fallback: 300 },
  taskTimeoutSec: { min: 30, max: 86400, fallback: 900 },
} as const satisfies Record<string, { min: number; max: number; fallback: number }>;

type LimitedField = keyof typeof LIMITS;

// ─── 原始值解析 ────────────────────────────────────────

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 解析并钳制到 LIMITS 定义的区间；未配置或非数值时回落到默认值。
 * null/空串必须先挡掉——Number(null) 和 Number("") 都是 0，会被误当作有效输入。
 */
function clamped(field: LimitedField, raw: unknown): number {
  const { min, max, fallback } = LIMITS[field];
  if (raw === null || raw === undefined || raw === "") return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const FOOTER_FIELDS = new Set<string>([
  "status", "elapsed", "model", "api_calls", "tokens",
  "context", "cache", "error", "cost", "stop_reason",
]);

export function parseFooter(value: unknown): FooterConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const footer: FooterConfig = {};

  const showRaw = obj.showFooter;
  if (typeof showRaw === "boolean") footer.showFooter = showRaw;
  else if (showRaw === "true" || showRaw === "1") footer.showFooter = true;
  else if (showRaw === "false" || showRaw === "0") footer.showFooter = false;

  if (Array.isArray(obj.lines)) {
    footer.lines = obj.lines
      .filter((row): row is unknown[] => Array.isArray(row))
      // 丢弃无法渲染的字段名，避免终态页脚出现空洞
      .map((row) => row.filter((item): item is FooterFieldId => typeof item === "string" && FOOTER_FIELDS.has(item)))
      .filter((row) => row.length > 0);
  }

  if (footer.showFooter === undefined && footer.lines === undefined) return undefined;
  return footer;
}

// ─── settings.json ─────────────────────────────────────

/** 读取 settings.json 的 feishu 段；仅接受 camelCase */
export function readFeishuFromSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const json = JSON.parse(readFileSync(filePath, "utf-8"));
    const section = json?.feishu;
    return section && typeof section === "object" ? section : {};
  } catch {
    return {};
  }
}

export function globalSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

export function projectSettingsPath(): string {
  return join(process.cwd(), ".pi", "settings.json");
}

// ─── 加载 ──────────────────────────────────────────────

/** 从已合并的原始配置对象构建 FeishuConfig；导出供测试直接注入 */
export function buildConfig(source: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): FeishuConfig {
  const s = source;
  return {
    appId: env.FEISHU_APP_ID || stringValue(s.appId),
    appSecret: env.FEISHU_APP_SECRET || stringValue(s.appSecret),
    domain: (env.FEISHU_DOMAIN || stringValue(s.domain) || "feishu") as "feishu" | "lark",
    encryptKey: env.FEISHU_ENCRYPT_KEY || stringValue(s.encryptKey) || undefined,
    verificationToken: env.FEISHU_VERIFICATION_TOKEN || stringValue(s.verificationToken) || undefined,
    flushIntervalMs: clamped("flushIntervalMs", env.FEISHU_FLUSH_INTERVAL_MS ?? s.flushIntervalMs),
    showThinking: booleanValue(env.FEISHU_SHOW_THINKING ?? s.showThinking, false),
    printStrategy: (env.FEISHU_PRINT_STRATEGY || stringValue(s.printStrategy) || "delay") as "fast" | "delay",
    printStep: clamped("printStep", env.FEISHU_PRINT_STEP ?? s.printStep),
    panelExpanded: booleanValue(env.FEISHU_PANEL_EXPANDED ?? s.panelExpanded, false),
    maxToolSteps: clamped("maxToolSteps", env.FEISHU_MAX_TOOL_STEPS ?? s.maxToolSteps),
    maxThinkingRounds: clamped("maxThinkingRounds", env.FEISHU_MAX_THINKING_ROUNDS ?? s.maxThinkingRounds),
    accessPolicy: (env.FEISHU_ACCESS_POLICY || stringValue(s.accessPolicy) || DEFAULT_ACCESS_POLICY) as "open" | "allowlist",
    allowedChatIds: stringList(env.FEISHU_ALLOWED_CHAT_IDS ?? s.allowedChatIds),
    allowedOpenIds: stringList(env.FEISHU_ALLOWED_OPEN_IDS ?? s.allowedOpenIds),
    requireMentionInGroup: booleanValue(env.FEISHU_REQUIRE_MENTION_IN_GROUP ?? s.requireMentionInGroup, false),
    streamingPanelExpanded: booleanValue(env.FEISHU_STREAMING_PANEL_EXPANDED ?? s.streamingPanelExpanded, false),
    maxAnswerElementChars: clamped("maxAnswerElementChars", env.FEISHU_MAX_ANSWER_ELEMENT_CHARS ?? s.maxAnswerElementChars),
    maxReasoningChars: clamped("maxReasoningChars", env.FEISHU_MAX_REASONING_CHARS ?? s.maxReasoningChars),
    maxToolDetailChars: clamped("maxToolDetailChars", env.FEISHU_MAX_TOOL_DETAIL_CHARS ?? s.maxToolDetailChars),
    maxToolOutputChars: clamped("maxToolOutputChars", env.FEISHU_MAX_TOOL_OUTPUT_CHARS ?? s.maxToolOutputChars),
    printFrequencyMs: clamped("printFrequencyMs", env.FEISHU_PRINT_FREQUENCY_MS ?? s.printFrequencyMs),
    clarifyTimeoutSec: clamped("clarifyTimeoutSec", env.FEISHU_CLARIFY_TIMEOUT_SEC ?? s.clarifyTimeoutSec),
    taskTimeoutSec: clamped("taskTimeoutSec", env.FEISHU_TASK_TIMEOUT_SEC ?? s.taskTimeoutSec),
    sameChatBusyPolicy: (() => {
      const raw = String(env.FEISHU_SAME_CHAT_BUSY_POLICY ?? s.sameChatBusyPolicy ?? "queue").toLowerCase();
      return raw === "interrupt" || raw === "abort" || raw === "replace" ? "interrupt" : "queue";
    })(),
    footer: parseFooter(s.footer),
  };
}

/** 项目配置覆盖全局配置；两者都可缺省 */
export function loadConfig(): FeishuConfig {
  return buildConfig({
    ...readFeishuFromSettingsFile(globalSettingsPath()),
    ...readFeishuFromSettingsFile(projectSettingsPath()),
  });
}

// ─── 校验 ──────────────────────────────────────────────

export interface ConfigProblem {
  field: string;
  message: string;
}

/**
 * 启动前校验。只报告无法自动修正的问题——数值越界已在加载时钳制。
 */
export function validateConfig(config: FeishuConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (!config.appId) {
    problems.push({ field: "appId", message: "缺少 appId，无法连接飞书" });
  }
  if (!config.appSecret) {
    problems.push({ field: "appSecret", message: "缺少 appSecret，无法连接飞书" });
  }
  if (
    config.accessPolicy === "allowlist" &&
    (config.allowedChatIds?.length ?? 0) === 0 &&
    (config.allowedOpenIds?.length ?? 0) === 0
  ) {
    problems.push({
      field: "allowedOpenIds",
      message: "accessPolicy=allowlist 但白名单为空，所有消息都会被拒绝",
    });
  }
  return problems;
}

export function formatConfigProblems(problems: ConfigProblem[]): string {
  return problems.map((p) => `· ${p.field}: ${p.message}`).join("\n");
}
