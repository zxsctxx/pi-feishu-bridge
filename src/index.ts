/**
 * Pi-Feishu 扩展主入口
 *
 * 使用飞书官方 Bot API（WebSocket 长连接）将飞书作为聊天渠道控制 Pi。
 *
 * 功能：
 * 1. 飞书 WebSocket 入站、消息去重与媒体收发
 * 2. Pi v0.80.6 assistant/thinking delta 单卡流式输出
 * 3. thinking 与工具调用按时间线展示，工具通过 toolCallId 关联
 * 4. 节流刷新、完成/错误/中断封卡与静态消息降级
 * 5. Reaction、聊天队列、/feishu 命令和主动发送工具
 *
 * 消息流程：用户消息 → 占位卡 → delta/工具事件原卡更新 → agent_settled 封卡。
 *
 * 配置优先级（从高到低）：
 *   1. CLI 标志: --feishu-app-id, --feishu-app-secret 等
 *   2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET 等
 *   3. Pi settings.json 中的 feishu 字段
 */

import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { FeishuClient } from "./feishu-client.js";
import type { FeishuConfig, InboundMessageContext, InboundResource } from "./types.js";
import { accessRiskWarning, evaluateAccess } from "./access/policy.js";
import { StreamingCardManager } from "./streaming/card-manager.js";
import { MetricsCollector, formatMetrics } from "./monitoring/metrics.js";
import { formatDoctor, runDoctor } from "./monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "./version.js";
import { ClarifyManager } from "./clarify/manager.js";
import { ConfigReloadCoordinator } from "./monitoring/reload.js";

// ─── 常量 ─────────────────────────────────────────────

/** 工具名到友好名称的映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: "Shell",
  read: "读取文件",
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索",
  find: "查找文件",
  ls: "列出目录",
  glob: "匹配文件",
  agent: "子代理",
  send_to_feishu: "发送消息",
  send_image_to_feishu: "发送图片",
  send_file_to_feishu: "发送文件",
};

/** 友好化工具名 */
function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name;
}

// ─── 从 Pi settings.json 读取 feishu 配置段 ──────────────

function readFeishuFromSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    const fs = json?.feishu;
    if (!fs || typeof fs !== "object") return {};
    return {
      appId: fs.appId ?? fs.app_id ?? "",
      appSecret: fs.appSecret ?? fs.app_secret ?? "",
      domain: fs.domain ?? "",
      encryptKey: fs.encryptKey ?? fs.encrypt_key ?? "",
      verificationToken: fs.verificationToken ?? fs.verification_token ?? "",
      flushIntervalMs: fs.flushIntervalMs ?? fs.flush_interval_ms,
      showThinking: fs.showThinking ?? fs.show_thinking ?? fs.showReasoning ?? fs.show_reasoning,
      printStrategy: fs.printStrategy ?? fs.print_strategy,
      printStep: fs.printStep ?? fs.print_step,
      panelExpanded: fs.panelExpanded ?? fs.panel_expanded,
      maxToolSteps: fs.maxToolSteps ?? fs.max_tool_steps,
      maxThinkingRounds: fs.maxThinkingRounds ?? fs.max_thinking_rounds,
      accessPolicy: fs.accessPolicy ?? fs.access_policy,
      allowedChatIds: fs.allowedChatIds ?? fs.allowed_chat_ids,
      allowedOpenIds: fs.allowedOpenIds ?? fs.allowed_open_ids,
      requireMentionInGroup: fs.requireMentionInGroup ?? fs.require_mention_in_group,
      streamingPanelExpanded: fs.streamingPanelExpanded ?? fs.streaming_panel_expanded,
      maxAnswerElementChars: fs.maxAnswerElementChars ?? fs.max_answer_element_chars,
      clarifyTimeoutSec: fs.clarifyTimeoutSec ?? fs.clarify_timeout_sec,
      monitoringEnabled: fs.monitoringEnabled ?? fs.monitoring_enabled,
      streamingTransport: fs.streamingTransport ?? fs.streaming_transport,
    };
  } catch {
    return {};
  }
}

function loadConfig(): FeishuConfig {
  const globalSettings = readFeishuFromSettingsFile(
    join(homedir(), ".pi", "agent", "settings.json"),
  );
  const projectSettings = readFeishuFromSettingsFile(
    join(process.cwd(), ".pi", "settings.json"),
  );
  const s: Record<string, unknown> = { ...globalSettings, ...projectSettings };
  const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
  const numberValue = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const booleanValue = (value: unknown, fallback: boolean): boolean => {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return fallback;
  };
  const stringList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
    return [];
  };

  const domain = (process.env.FEISHU_DOMAIN || stringValue(s.domain) || "feishu") as "feishu" | "lark";

  return {
    appId: process.env.FEISHU_APP_ID || stringValue(s.appId),
    appSecret: process.env.FEISHU_APP_SECRET || stringValue(s.appSecret),
    domain,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || stringValue(s.encryptKey) || undefined,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || stringValue(s.verificationToken) || undefined,
    flushIntervalMs: numberValue(process.env.FEISHU_FLUSH_INTERVAL_MS ?? s.flushIntervalMs, 200),
    showThinking: booleanValue(process.env.FEISHU_SHOW_THINKING ?? process.env.FEISHU_SHOW_REASONING ?? s.showThinking, false),
    printStrategy: (process.env.FEISHU_PRINT_STRATEGY || stringValue(s.printStrategy) || "delay") as "fast" | "delay",
    printStep: numberValue(process.env.FEISHU_PRINT_STEP ?? s.printStep, 4),
    panelExpanded: booleanValue(process.env.FEISHU_PANEL_EXPANDED ?? s.panelExpanded, false),
    maxToolSteps: numberValue(process.env.FEISHU_MAX_TOOL_STEPS ?? s.maxToolSteps, 20),
    maxThinkingRounds: numberValue(process.env.FEISHU_MAX_THINKING_ROUNDS ?? s.maxThinkingRounds, 20),
    accessPolicy: (process.env.FEISHU_ACCESS_POLICY || stringValue(s.accessPolicy) || "open") as "open" | "allowlist",
    allowedChatIds: stringList(process.env.FEISHU_ALLOWED_CHAT_IDS ?? s.allowedChatIds),
    allowedOpenIds: stringList(process.env.FEISHU_ALLOWED_OPEN_IDS ?? s.allowedOpenIds),
    requireMentionInGroup: booleanValue(process.env.FEISHU_REQUIRE_MENTION_IN_GROUP ?? s.requireMentionInGroup, false),
    streamingPanelExpanded: booleanValue(process.env.FEISHU_STREAMING_PANEL_EXPANDED ?? s.streamingPanelExpanded, false),
    maxAnswerElementChars: numberValue(process.env.FEISHU_MAX_ANSWER_ELEMENT_CHARS ?? s.maxAnswerElementChars, 30000),
    clarifyTimeoutSec: numberValue(process.env.FEISHU_CLARIFY_TIMEOUT_SEC ?? s.clarifyTimeoutSec, 300),
    monitoringEnabled: booleanValue(process.env.FEISHU_MONITORING_ENABLED ?? s.monitoringEnabled, true),
    streamingTransport: (process.env.FEISHU_STREAMING_TRANSPORT || stringValue(s.streamingTransport) || "auto") as "auto" | "cardkit" | "im_patch",
  };
}

// ─── 扩展入口 ───────────────────────────────────────────

/** newSession/reload 会拆掉旧扩展实例；用 globalThis 跨实例投递飞书回执 */
type PendingFeishuNotify = { chatId: string; text: string; at: number };
const PENDING_NOTIFY_KEY = "__piFeishuBridgePendingNotify";

function setPendingFeishuNotify(notify: PendingFeishuNotify | null): void {
  (globalThis as Record<string, unknown>)[PENDING_NOTIFY_KEY] = notify;
}

function takePendingFeishuNotify(): PendingFeishuNotify | null {
  const g = globalThis as Record<string, unknown>;
  const notify = (g[PENDING_NOTIFY_KEY] as PendingFeishuNotify | null | undefined) ?? null;
  g[PENDING_NOTIFY_KEY] = null;
  return notify;
}

/** 内部命令名：仅供飞书斜杠经 sendUserMessage 触发，勿与内置 /new /reload 抢名 */
const CMD_FEISHU_SESSION_NEW = "feishu-session-new";
const CMD_FEISHU_RUNTIME_RELOAD = "feishu-runtime-reload";
const INTERNAL_SESSION_COMMANDS = new Set([CMD_FEISHU_SESSION_NEW, CMD_FEISHU_RUNTIME_RELOAD]);

/** 与 TUI `/model pattern:level` 对齐的 thinking 后缀 */
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type ThinkingLevelName =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

function parseModelArg(raw: string): { pattern: string; thinking?: ThinkingLevelName } {
  const trimmed = raw.trim();
  if (!trimmed) return { pattern: "" };
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { pattern: trimmed };
  const suffix = trimmed.slice(lastColon + 1).toLowerCase();
  if (!THINKING_LEVELS.has(suffix)) return { pattern: trimmed };
  return {
    pattern: trimmed.slice(0, lastColon).trim(),
    thinking: suffix as ThinkingLevelName,
  };
}

function formatModelRef(model: { provider: string; id: string; name?: string }): string {
  const base = `${model.provider}/${model.id}`;
  return model.name && model.name !== model.id ? `${base} (${model.name})` : base;
}

type ListedModel = { provider: string; id: string; name?: string };

function readSettingsObject(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const json = JSON.parse(readFileSync(filePath, "utf-8"));
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 读取 settings.enabledModels（项目覆盖全局），供飞书精简列表使用 */
function readEnabledModelPatterns(): string[] {
  const global = readSettingsObject(join(homedir(), ".pi", "agent", "settings.json"));
  const project = readSettingsObject(join(process.cwd(), ".pi", "settings.json"));
  const raw = project.enabledModels ?? global.enabledModels;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function stripThinkingSuffix(pattern: string): string {
  const lastColon = pattern.lastIndexOf(":");
  if (lastColon === -1) return pattern;
  const suffix = pattern.slice(lastColon + 1).toLowerCase();
  return THINKING_LEVELS.has(suffix) ? pattern.slice(0, lastColon).trim() : pattern;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function modelMatchesEnabledPattern(model: ListedModel, pattern: string): boolean {
  const raw = stripThinkingSuffix(pattern.trim());
  if (!raw) return false;
  const full = `${model.provider}/${model.id}`;
  if (raw.includes("*") || raw.includes("?")) {
    const re = globToRegExp(raw);
    return re.test(full) || re.test(model.id);
  }
  return full.toLowerCase() === raw.toLowerCase() || model.id.toLowerCase() === raw.toLowerCase();
}

/**
 * 飞书列表优先显示 enabledModels（与 TUI Ctrl+P 范围一致）。
 * 未配置时回退为按 provider 汇总，避免 dump 全量目录。
 */
function buildModelListLines(
  available: ListedModel[],
  current: ListedModel | undefined,
): { lines: string[]; mode: "scoped" | "providers" | "empty"; total: number } {
  if (available.length === 0) {
    return { lines: ["（无可用模型）"], mode: "empty", total: 0 };
  }

  const patterns = readEnabledModelPatterns();
  if (patterns.length > 0) {
    const scoped: ListedModel[] = [];
    for (const pattern of patterns) {
      for (const model of available) {
        if (!modelMatchesEnabledPattern(model, pattern)) continue;
        if (scoped.some((m) => m.provider === model.provider && m.id === model.id)) continue;
        scoped.push(model);
      }
    }
    if (scoped.length > 0) {
      const lines = scoped.map((m) => {
        const mark =
          current && m.provider === current.provider && m.id === current.id ? " *" : "";
        return `  - ${formatModelRef(m)}${mark}`;
      });
      return { lines, mode: "scoped", total: scoped.length };
    }
  }

  // 无 enabledModels 或均不可用：按 provider 汇总，不列全量模型
  const byProvider = new Map<string, number>();
  for (const model of available) {
    byProvider.set(model.provider, (byProvider.get(model.provider) ?? 0) + 1);
  }
  const lines = [...byProvider.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, count]) => `  - ${provider} (${count})`);
  return { lines, mode: "providers", total: available.length };
}

/**
 * 解析飞书 `/model` 参数，对齐 TUI 常见写法：
 * - `cpa/grok45`
 * - `grok45`（仅当全局唯一）
 * - `cpa/grok45:high`
 */
function resolveModelFromArg(
  registry: ExtensionContext["modelRegistry"],
  pattern: string,
): { model: NonNullable<ExtensionContext["model"]> } | { error: string } {
  const available = registry.getAvailable();
  if (available.length === 0) {
    return { error: "当前没有可用模型（请先配置 auth / models.json）。" };
  }

  const normalized = pattern.trim();
  if (!normalized) {
    return { error: "请指定模型，例如 /model cpa/grok45" };
  }

  const lower = normalized.toLowerCase();
  const slash = normalized.indexOf("/");
  if (slash !== -1) {
    const provider = normalized.slice(0, slash).trim();
    const modelId = normalized.slice(slash + 1).trim();
    if (provider && modelId) {
      const exact =
        registry.find(provider, modelId) ??
        available.find(
          (m) =>
            m.provider.toLowerCase() === provider.toLowerCase() &&
            m.id.toLowerCase() === modelId.toLowerCase(),
        );
      if (exact) {
        if (!registry.hasConfiguredAuth(exact)) {
          return { error: `模型 ${formatModelRef(exact)} 已注册但未配置鉴权。` };
        }
        return { model: exact };
      }
    }
  }

  const idExact = available.filter((m) => m.id.toLowerCase() === lower);
  if (idExact.length === 1) return { model: idExact[0] };
  if (idExact.length > 1) {
    const list = idExact.map((m) => `  - ${formatModelRef(m)}`).join("\n");
    return { error: `模型 id 在多个 provider 中重复，请用 provider/id：\n${list}` };
  }

  const partial = available.filter(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      m.name?.toLowerCase().includes(lower) ||
      `${m.provider}/${m.id}`.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return { model: partial[0] };
  if (partial.length > 1) {
    const list = partial
      .slice(0, 12)
      .map((m) => `  - ${formatModelRef(m)}`)
      .join("\n");
    const more = partial.length > 12 ? `\n  …共 ${partial.length} 个` : "";
    return { error: `匹配到多个模型，请写更精确的 provider/id：\n${list}${more}` };
  }

  return {
    error: `未找到模型：${normalized}\n示例：/model cpa/grok45  或  /model cpa/grok45:high`,
  };
}

/**
 * pi.sendUserMessage 硬编码 expandPromptTemplates:false，不会执行扩展命令。
 * 对白名单内部命令改走 expandPromptTemplates:true，才能拿到 ExtensionCommandContext
 *（newSession/reload 只在该上下文可用）。
 */
function installInternalCommandPromptPatch(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__piFeishuBridgeCmdPatch) return;
  const proto = AgentSession.prototype as unknown as {
    sendUserMessage: (content: unknown, options?: { deliverAs?: string }) => Promise<void>;
    prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
  };
  const original = proto.sendUserMessage;
  if (typeof original !== "function" || typeof proto.prompt !== "function") return;
  proto.sendUserMessage = async function patchedSendUserMessage(
    this: typeof proto,
    content: unknown,
    options?: { deliverAs?: string },
  ) {
    let text: string | undefined;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((part: { type?: string; text?: string }) => part?.type === "text" && typeof part.text === "string")
        .map((part: { text: string }) => part.text)
        .join("\n");
    }
    const trimmed = text?.trim() ?? "";
    if (trimmed.startsWith("/")) {
      const space = trimmed.indexOf(" ");
      const name = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      if (INTERNAL_SESSION_COMMANDS.has(name)) {
        await this.prompt(trimmed, {
          expandPromptTemplates: true,
          streamingBehavior: options?.deliverAs,
          source: "extension",
        });
        return;
      }
    }
    return original.call(this, content, options);
  };
  g.__piFeishuBridgeCmdPatch = true;
}

export default function (pi: ExtensionAPI) {
  installInternalCommandPromptPatch();
  let client: FeishuClient | null = null;
  let config: FeishuConfig = loadConfig();
  let ctxRef: ExtensionContext | null = null;
  let streaming: StreamingCardManager | null = null;
  let latestChatId: string | null = null;
  const metrics = new MetricsCollector();
  let clarify: ClarifyManager | null = null;
  const configReload = new ConfigReloadCoordinator();


  // ─── 消息队列 ──────────────────────────────────────────

  interface QueuedMessage {
    msgId: string;
    text: string;
    resources: InboundResource[];
    chatType: "p2p" | "group";
  }

  interface ChatQueue {
    processing: boolean;
    queue: QueuedMessage[];
  }

  /** 每个聊天的消息队列 */
  const chatQueues: Map<string, ChatQueue> = new Map();

  // ─── 注册 CLI 标志 ────────────────────────────────────

  pi.registerFlag("feishu-app-id", {
    description: "飞书 App ID",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-app-secret", {
    description: "飞书 App Secret",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-domain", {
    description: "飞书域名 (feishu 或 lark)",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-encrypt-key", {
    description: "飞书事件加密密钥（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-verification-token", {
    description: "飞书事件验证令牌（可选）",
    type: "string",
    default: "",
  });

  // ─── 启动飞书客户端 ──────────────────────────────────

  async function startFeishuClient(): Promise<void> {
    if (client) {
      client.disconnect();
      client = null;
    }

    const flagMap: Record<string, string> = {
      appId: "feishu-app-id",
      appSecret: "feishu-app-secret",
      domain: "feishu-domain",
      encryptKey: "feishu-encrypt-key",
      verificationToken: "feishu-verification-token",
    };
    const overrides: Partial<FeishuConfig> = {};
    for (const [key, flag] of Object.entries(flagMap)) {
      const val = pi.getFlag(flag);
      if (val) (overrides as any)[key] = String(val);
    }
    config = { ...config, ...overrides };

    if (!config.appId || !config.appSecret) {
      if (ctxRef?.hasUI) {
        ctxRef.ui.notify("飞书连接失败：缺少 appId/appSecret", "error");
      }
      return;
    }

    client = new FeishuClient(config);
    streaming = new StreamingCardManager(client.createCardKitClient(metrics), client, {
      flushIntervalMs: Math.max(80, config.flushIntervalMs ?? 200),
      showThinking: config.showThinking ?? false,
      printStrategy: config.printStrategy ?? "delay",
      printStep: config.printStep ?? 4,
      panelExpanded: config.panelExpanded ?? false,
      maxToolSteps: config.maxToolSteps ?? 20,
      maxThinkingRounds: config.maxThinkingRounds ?? 20,
      streamingPanelExpanded: config.streamingPanelExpanded ?? false,
      maxAnswerElementChars: Math.max(1000, config.maxAnswerElementChars ?? 30000),
    }, metrics);
    clarify = new ClarifyManager(client);

    client.setOnMessage((context) => {
      handleFeishuMessage(context);
    });
    client.setOnStatusChange((status) => {
      updateStatus(ctxRef, status);
    });
    client.setOnCardAction((action) => { void clarify?.handleAction(action); });

    try {
      await client.connect();
      if (config.streamingTransport === "im_patch") {
        streaming?.useLegacyMode("配置已强制使用 IM PATCH 兼容流式");
      } else if (config.streamingTransport !== "cardkit") {
        const nativeAvailable = await client.checkCardKitAvailability();
        if (!nativeAvailable) {
          streaming?.useLegacyMode("CardKit 原生流式探针未通过，自动使用 IM PATCH 兼容流式");
          console.warn("[pi-feishu] CardKit native streaming probe failed; using IM PATCH transport");
        }
      }
      const warning = accessRiskWarning(config);
      if (warning) {
        console.warn(`[pi-feishu] ${warning}`);
        if (ctxRef?.hasUI) ctxRef.ui.notify(warning, "warning");
      }
    } catch (err) {
      if (ctxRef?.hasUI) {
        ctxRef.ui.notify(`飞书连接错误: ${err}`, "error");
      }
    }
  }

  // ─── 处理飞书入站消息 → 排队或直接处理 ────────────────

  async function handleFeishuMessage(context: InboundMessageContext): Promise<void> {
    const decision = evaluateAccess(context, config);
    if (!decision.allowed) {
      await client?.sendMessage(context.chatId, "无权访问此机器人。", context.messageId);
      return;
    }

    const { chatId, messageId: msgId, text, chatType, resources } = context;
    const content = text.trim();
    if (!content && resources.length === 0) return;

    // ── 拦截斜杠命令 ──
    if (content.startsWith("/")) {
      await handleSlashCommand(chatId, msgId, content);
      return;
    }

    // ── 入队 ──
    const queue = chatQueues.get(chatId) ?? { processing: false, queue: [] };
    chatQueues.set(chatId, queue);

    queue.queue.push({ msgId, text: content, resources, chatType });

    const anotherRequestIsRunning = [...chatQueues.entries()].some(([id, candidate]) => id !== chatId && candidate.processing);
    if (queue.processing || anotherRequestIsRunning || (ctxRef ? !ctxRef.isIdle() : false)) {
      // 当前正在处理 → 通知排队
      const pos = [...chatQueues.values()].reduce((total, candidate) => total + candidate.queue.length, 0);
      await client?.sendMessage(
        chatId,
        `已排队 (前面还有 ${pos - 1} 条)`,
        msgId,
      );
      flashStatus(`飞书: 📥 排队中 (${pos})`);
      return;
    }

    // 当前空闲 → 开始处理
    await dequeueAndProcess(chatId);
  }

  /** 从队列取出下一条消息并开始处理 */
  async function dequeueAndProcess(chatId: string): Promise<void> {
    const queue = chatQueues.get(chatId);
    if (!queue || queue.queue.length === 0) {
      // 队列空，标记空闲
      if (queue) queue.processing = false;
      return;
    }

    // Pi 正忙（压缩中/流式中）→ 不出队，保持 processing=false 等空闲时再触发
    if (ctxRef && !ctxRef.isIdle()) {
      queue.processing = false;
      return;
    }
    if ([...chatQueues.entries()].some(([id, candidate]) => id !== chatId && candidate.processing)) {
      queue.processing = false;
      return;
    }

    queue.processing = true;
    const item = queue.queue.shift()!;

    flashStatus(`飞书: 📩 ${item.text.substring(0, 20)}${item.text.length > 20 ? "..." : ""}`);

    // 下载入站媒体
    let resourceDescription = "";
    for (const res of item.resources) {
      const localPath = await client!.downloadResource(
        item.msgId,
        res.fileKey,
        res.type,
        res.fileName,
      );
      if (localPath) {
        const typeLabel =
          res.type === "image" ? "图片" :
          res.type === "audio" ? "语音" :
          res.type === "video" ? "视频" : "文件";
        resourceDescription += `\n[收到${typeLabel}: ${localPath}]`;
      }
    }

    latestChatId = chatId;

    // 添加 Typing Reaction 并创建单张流式卡片
    await client!.startTyping(chatId, item.msgId);
    await streaming?.start(chatId, item.msgId);

    // 发送给 Pi
    const fullContent = item.text + (resourceDescription ? "\n" + resourceDescription : "");
    pi.sendUserMessage(fullContent);
  }

  // ─── 斜杠命令处理 ──────────────────────────────────────

  /** 为 /new /reload 做前置清理：中断流式、清空本聊天队列、abort Agent */
  async function prepareRemoteSessionControl(chatId: string): Promise<void> {
    latestChatId = chatId;
    await clarify?.abort();
    if (streaming?.activeSession) await streaming.abort("会话控制命令中断当前任务");
    client?.stopTyping(chatId, false).catch(() => {});
    const queue = chatQueues.get(chatId);
    if (queue) {
      queue.queue = [];
      queue.processing = false;
    }
    if (ctxRef && !ctxRef.isIdle()) ctxRef.abort();
  }

  /**
   * 处理从飞书发来的斜杠命令。
   * 这些命令不会发给 LLM，而是直接在扩展层执行或回复提示。
   */
  async function handleSlashCommand(
    chatId: string,
    msgId: string,
    text: string,
  ): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (cmd) {
      case "/feishu": {
        const action = args.toLowerCase() || "help";
        if (action === "monitor") await client?.sendMessage(chatId, formatMetrics(metrics.snapshot()), msgId);
        else if (action === "monitor reset") { metrics.reset(); await client?.sendMessage(chatId, "Pi-Feishu 监控指标已清零。", msgId); }
        else if (action === "doctor") { const connected = client?.getStatus() === "connected"; const cardkit = connected ? await client!.checkCardKitAvailability() : null; await client?.sendMessage(chatId, formatDoctor(runDoctor(config, connected, cardkit)), msgId); }
        else if (action === "status") {
          const warning = accessRiskWarning(config);
          await client?.sendMessage(chatId, `${PRODUCT_NAME} ${PRODUCT_VERSION} (${PRODUCT_ID})\n飞书连接: ${client?.getStatus() ?? "未启动"}\n访问策略: ${config.accessPolicy ?? "open"}${warning ? `\n${warning}` : ""}`, msgId);
        } else if (action === "config") {
          await client?.sendMessage(chatId, `Domain: ${config.domain ?? "feishu"}\nStreaming transport: ${config.streamingTransport ?? "auto"}\nShow thinking: ${config.showThinking ?? false}\nAccess policy: ${config.accessPolicy ?? "open"}\nAllowed chats: ${config.allowedChatIds?.length ?? 0}\nAllowed users: ${config.allowedOpenIds?.length ?? 0}`, msgId);
        } else if (action === "config reload") {
          const result = await configReload.request(ctxRef?.isIdle() ?? true, async () => { config = loadConfig(); await startFeishuClient(); });
          await client?.sendMessage(chatId, result === "deferred" ? "配置将在当前 Agent 完全 settled 后重载。" : "配置已重载。", msgId);
        } else {
          await client?.sendMessage(chatId, "/feishu status | monitor [reset] | config [reload] | doctor | help", msgId);
        }
        break;
      }
      case "/new": {
        await prepareRemoteSessionControl(chatId);
        setPendingFeishuNotify({
          chatId,
          text: "已新建会话。先前上下文已清空，可继续对话。",
          at: Date.now(),
        });
        await client?.sendMessage(chatId, "正在新建会话…", msgId);
        // newSession 仅在命令上下文可用；经 followUp 触发内部命令
        pi.sendUserMessage(`/${CMD_FEISHU_SESSION_NEW}`, { deliverAs: "followUp" });
        break;
      }

      case "/reload": {
        await prepareRemoteSessionControl(chatId);
        setPendingFeishuNotify({
          chatId,
          text: "已热重载扩展、技能、提示词、主题与上下文文件；飞书连接已恢复。\n（仅重载飞书配置请用 /feishu config reload）",
          at: Date.now(),
        });
        await client?.sendMessage(chatId, "正在热重载…", msgId);
        pi.sendUserMessage(`/${CMD_FEISHU_RUNTIME_RELOAD}`, { deliverAs: "followUp" });
        break;
      }

      case "/stop": {
        await clarify?.abort();
        if (streaming?.activeSession?.chatId === chatId) await streaming.abort("用户已停止当前任务");
        // 中断当前处理 + 清空队列
        const queue = chatQueues.get(chatId);
        const clearedCount = queue?.queue.length ?? 0;

        if (streaming?.activeSession?.chatId === chatId) client?.stopTyping(chatId, false).catch(() => {});
        if (queue) {
          queue.queue = [];
          queue.processing = false;
        }

        if (ctxRef && !ctxRef.isIdle()) {
          ctxRef.abort();
          await client?.sendMessage(chatId, "已中断当前处理，队列已清空。", msgId);
        } else if (clearedCount > 0) {
          await client?.sendMessage(chatId, `已清空 ${clearedCount} 条排队消息。`, msgId);
        } else {
          await client?.sendMessage(chatId, "当前没有正在处理的任务。", msgId);
        }
        break;
      }

      case "/queue": {
        const queue = chatQueues.get(chatId);
        const state = streaming?.activeSession?.chatId === chatId ? streaming.activeSession : null;
        const count = queue?.queue.length ?? 0;
        const idle = ctxRef?.isIdle() ?? true;

        if (!state && count === 0) {
          await client?.sendMessage(chatId, "队列为空，当前空闲。", msgId);
        } else {
          let reply = idle ? "状态: 空闲" : "状态: 处理中";
          if (count > 0) {
            reply += `\n排队中: ${count} 条消息`;
          }
          await client?.sendMessage(chatId, reply, msgId);
        }
        break;
      }

      case "/compact": {
        if (!ctxRef) {
          await client?.sendMessage(chatId, "无法执行：会话上下文不可用。", msgId);
          break;
        }
        const replyChatId = chatId;
        const replyMsgId = msgId;
        ctxRef.compact({
          onComplete: () => {
            void client?.sendMessage(replyChatId, "上下文压缩已完成。", replyMsgId);
          },
          onError: (error) => {
            void client?.sendMessage(
              replyChatId,
              `上下文压缩失败：${error instanceof Error ? error.message : String(error)}`,
              replyMsgId,
            );
          },
        });
        await client?.sendMessage(chatId, "已触发上下文压缩…", msgId);
        break;
      }

      case "/model": {
        if (!ctxRef) {
          await client?.sendMessage(chatId, "无法切换模型：会话上下文不可用。", msgId);
          break;
        }
        const registry = ctxRef.modelRegistry;
        const current = ctxRef.model;
        const thinking = pi.getThinkingLevel();

        if (!args.trim()) {
          const available = registry.getAvailable();
          const currentLine = current
            ? `当前: ${formatModelRef(current)} · thinking ${thinking}`
            : "当前: （未选择模型）";
          const listed = buildModelListLines(available, current);
          const header =
            listed.mode === "scoped"
              ? `常用模型 (enabledModels, ${listed.total}):`
              : listed.mode === "providers"
                ? `已配置 provider (${listed.total} 个模型，未设置 enabledModels):`
                : "可用模型:";
          await client?.sendMessage(
            chatId,
            [
              currentLine,
              "用法: /model <provider/id[:thinking]>",
              "示例: /model cpa/grok45",
              "      /model cpa/grok45:high",
              "",
              header,
              ...listed.lines,
            ].join("\n"),
            msgId,
          );
          break;
        }

        const { pattern, thinking: nextThinking } = parseModelArg(args);
        const resolved = resolveModelFromArg(registry, pattern);
        if ("error" in resolved) {
          await client?.sendMessage(chatId, resolved.error, msgId);
          break;
        }

        const ok = await pi.setModel(resolved.model);
        if (!ok) {
          await client?.sendMessage(
            chatId,
            `切换失败：${formatModelRef(resolved.model)} 无可用 API key / 鉴权。`,
            msgId,
          );
          break;
        }

        if (nextThinking) {
          pi.setThinkingLevel(nextThinking);
        }
        const appliedThinking = pi.getThinkingLevel();
        const busyNote = ctxRef.isIdle()
          ? ""
          : "\n（当前任务仍在运行，新模型将从下一轮对话生效）";
        await client?.sendMessage(
          chatId,
          `已切换模型: ${formatModelRef(resolved.model)} · thinking ${appliedThinking}${busyNote}`,
          msgId,
        );
        break;
      }

      case "/status": {
        const status = client?.getStatus() ?? "未启动";
        const ctxUsage = ctxRef?.getContextUsage();
        const queue = chatQueues.get(chatId);
        const currentModel = ctxRef?.model;
        let reply = `Pi 状态:\n- 飞书连接: ${status}\n- App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}`;
        if (currentModel) {
          reply += `\n- 模型: ${formatModelRef(currentModel)} · thinking ${pi.getThinkingLevel()}`;
        }
        const warning = accessRiskWarning(config); if (warning) reply += `\n- ${warning}`;
        if (ctxUsage && ctxUsage.tokens !== null) {
          reply += `\n- 上下文: ${ctxUsage.tokens}/${ctxUsage.contextWindow} tokens (${ctxUsage.percent ?? "?"}%)`;
        }
        if (queue && queue.queue.length > 0) {
          reply += `\n- 排队: ${queue.queue.length} 条`;
        }
        await client?.sendMessage(chatId, reply, msgId);
        break;
      }

      case "/help": {
        const helpText = [
          "可用命令:",
          "  /new       - 新建 Pi 会话（清空上下文）",
          "  /reload    - 热重载扩展/技能/主题等（等同终端 /reload）",
          "  /stop      - 中断当前处理，清空排队",
          "  /queue     - 查看排队状态",
          "  /compact   - 压缩上下文",
          "  /model     - 查看/切换模型（如 /model cpa/grok45）",
          "  /status    - 查看 Pi 状态",
          "  /help      - 显示帮助",
          "",
          "飞书扩展:",
          "  /feishu status | monitor [reset] | config [reload] | doctor | help",
          "",
          "以下命令请在 Pi 终端中执行:",
          "  /tools     - 管理工具",
        ].join("\n");
        await client?.sendMessage(chatId, helpText, msgId);
        break;
      }

      default: {
        await client?.sendMessage(
          chatId,
          `命令 ${cmd} 不支持通过飞书执行。请在 Pi 终端中使用。`,
          msgId,
        );
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Pi v0.80.6 事件 → 单卡流式状态
  // ═══════════════════════════════════════════════════════

  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      streaming?.onTextDelta(update.delta);
      flashStatus("飞书: 正在流式输出");
    } else if (update.type === "thinking_delta") {
      streaming?.onThinkingDelta(update.delta);
    } else if (update.type === "error") {
      streaming?.recordError(update.error.errorMessage ?? "LLM 返回了未知错误");
    }
  });

  /** 与终端 footer 一致：遍历 session 全部 assistant usage 累加；pending 用于 message_end 尚未落盘的当前条 */
  function applySessionFooterUsage(pending?: { usage?: {
    input?: number; output?: number; reasoning?: number;
    cacheRead?: number; cacheWrite?: number; cost?: { total?: number };
  } }): void {
    const card = streaming?.activeSession;
    const sm = ctxRef?.sessionManager;
    if (!card || !sm) return;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let cacheHitPercent: number | undefined;
    const apply = (usage: {
      input?: number; output?: number; reasoning?: number;
      cacheRead?: number; cacheWrite?: number; cost?: { total?: number };
    } | undefined) => {
      if (!usage) return;
      const input = usage.input ?? 0;
      const cr = usage.cacheRead ?? 0;
      const cw = usage.cacheWrite ?? 0;
      inputTokens += input;
      outputTokens += usage.output ?? 0;
      if (typeof usage.reasoning === "number") reasoningTokens += usage.reasoning;
      cacheRead += cr;
      cacheWrite += cw;
      cost += usage.cost?.total ?? 0;
      const promptTokens = input + cr + cw;
      if (promptTokens > 0 && (cr > 0 || cw > 0)) {
        cacheHitPercent = (cr / promptTokens) * 100;
      }
    };
    for (const entry of sm.getEntries()) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: string; usage?: Parameters<typeof apply>[0] };
      if (message.role === "assistant") apply(message.usage);
    }
    apply(pending?.usage);
    card.footer.inputTokens = inputTokens;
    card.footer.outputTokens = outputTokens;
    card.footer.reasoningTokens = reasoningTokens > 0 ? reasoningTokens : undefined;
    card.footer.cacheRead = cacheRead;
    card.footer.cacheWrite = cacheWrite;
    card.footer.cost = cost;
    card.footer.cacheHitPercent = cacheHitPercent;
  }

  pi.on("before_agent_start", () => {
    const session = streaming?.activeSession;
    if (!session) return;
    session.footer.apiCalls = 0;
    // 本轮开始先刷 session 累计（与终端同口径），apiCalls 仅统计本轮
    applySessionFooterUsage();
  });
  pi.on("after_provider_response", () => {
    const session = streaming?.activeSession; if (session) session.footer.apiCalls++;
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const session = streaming?.activeSession; if (!session) return;
    const message = event.message;
    session.footer.model = message.responseModel ?? message.model;
    session.footer.stopReason = message.stopReason;
    // message_end 时尚未写入 session 文件，把当前条作为 pending 并入累计
    applySessionFooterUsage({ usage: message.usage });
  });

  pi.on("tool_execution_start", (event) => {
    streaming?.onToolStart(event.toolCallId, event.toolName, event.args);
    flashStatus(`飞书: 🔧 ${toolDisplayName(event.toolName)}...`);
  });

  pi.on("tool_execution_update", (event) => {
    streaming?.onToolUpdate(event.toolCallId, event.partialResult);
  });

  pi.on("tool_execution_end", (event) => {
    streaming?.onToolEnd(event.toolCallId, event.result, event.isError);
  });

  pi.on("agent_end", () => { streaming?.onAgentEnd(); });

  pi.on("agent_settled", async () => {
    const usage = ctxRef?.getContextUsage(); const active = streaming?.activeSession;
    // 落盘后按 session 全量再刷一次，避免 pending 与 getEntries 边界误差
    applySessionFooterUsage();
    if (active && usage) { active.footer.contextTokens = usage.tokens; active.footer.contextWindow = usage.contextWindow; active.footer.contextPercent = usage.percent; }
    const session = await streaming?.settle();
    if (!session) { await configReload.afterSettled(async () => { config = loadConfig(); await startFeishuClient(); }); return; }
    await client?.stopTyping(session.chatId, session.phase === "completed");
    const queue = chatQueues.get(session.chatId);
    if (queue) queue.processing = false;
    streaming?.release();
    flushAllQueues();
    flashStatus("飞书: ✅ 完成");
    await configReload.afterSettled(async () => { config = loadConfig(); await startFeishuClient(); });
  });

  function flushAllQueues(): void {
    if (!client || client.getStatus() !== "connected") return;
    if (ctxRef && !ctxRef.isIdle()) return;
    for (const [chatId, queue] of chatQueues) {
      if (!queue.processing && queue.queue.length > 0) {
        void dequeueAndProcess(chatId).catch(() => { queue.processing = false; });
        break;
      }
    }
  }

  pi.on("session_compact", () => { setTimeout(() => flushAllQueues(), 500); });

  // ─── 会话控制命令（供飞书 /new /reload 经 sendUserMessage 触发）──

  pi.registerCommand(CMD_FEISHU_SESSION_NEW, {
    description: "[内部] 飞书远程新建会话",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        if (!ctx.isIdle()) {
          ctx.abort();
          await ctx.waitForIdle();
        }
        const result = await ctx.newSession();
        if (result.cancelled) {
          // 新会话未建立，旧实例仍存活，直接回执
          const pending = takePendingFeishuNotify();
          if (pending && client) {
            await client.sendMessage(pending.chatId, "新建会话已取消（被扩展拦截）。");
          }
          ctx.ui.notify("飞书远程 /new 已取消", "warning");
          return;
        }
        // 成功后旧运行时已拆掉；成功文案由新实例 session_start 投递 pending notify
      } catch (error) {
        const pending = takePendingFeishuNotify();
        const detail = error instanceof Error ? error.message : String(error);
        if (pending && client) {
          await client.sendMessage(pending.chatId, `新建会话失败：${detail}`);
        }
        ctx.ui.notify(`飞书远程 /new 失败: ${detail}`, "error");
      }
    },
  });

  pi.registerCommand(CMD_FEISHU_RUNTIME_RELOAD, {
    description: "[内部] 飞书远程热重载（等同 /reload）",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        if (!ctx.isIdle()) {
          ctx.abort();
          await ctx.waitForIdle();
        }
        // reload 后旧内存状态失效，成功回执交给新实例 session_start
        await ctx.reload();
        return;
      } catch (error) {
        const pending = takePendingFeishuNotify();
        const detail = error instanceof Error ? error.message : String(error);
        if (pending && client) {
          await client.sendMessage(pending.chatId, `热重载失败：${detail}`);
        }
        ctx.ui.notify(`飞书远程 /reload 失败: ${detail}`, "error");
      }
    },
  });

  // ─── 注册 /feishu 命令 ────────────────────────────────

  pi.registerCommand("feishu", {
    description: "管理飞书 Bot 连接 (start/stop/status/config/help)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase() || "status";

      switch (action) {
        case "start":
          await startFeishuClient();
          ctx.ui.notify("飞书客户端已启动", "info");
          break;

        case "stop":
          await clarify?.abort();
          await streaming?.abort("飞书客户端已停止");
          streaming?.release();
          if (client) {
            client.disconnect();
            client = null;
          }
          ctx.ui.notify("飞书客户端已停止", "info");
          break;

        case "status": {
          const status = client?.getStatus() ?? "未启动";
          ctx.ui.notify(
            `${PRODUCT_NAME} ${PRODUCT_VERSION} (${PRODUCT_ID})\n` +
              `飞书 Bot 状态: ${status}\n` +
              `App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}\n` +
              `Domain: ${config.domain || "feishu"}${accessRiskWarning(config) ? `\n${accessRiskWarning(config)}` : ""}`,
            "info",
          );
          break;
        }

        case "monitor":
          ctx.ui.notify(formatMetrics(metrics.snapshot()), "info");
          break;
        case "monitor reset":
          metrics.reset(); ctx.ui.notify("Pi-Feishu 监控指标已清零", "info");
          break;
        case "doctor":
          { const connected = client?.getStatus() === "connected"; const cardkit = connected ? await client!.checkCardKitAvailability() : null; ctx.ui.notify(formatDoctor(runDoctor(config, connected, cardkit)), "info"); }
          break;
        case "config reload":
          if ((await configReload.request(ctxRef?.isIdle() ?? true, async () => { config = loadConfig(); await startFeishuClient(); })) === "deferred") ctx.ui.notify("Agent 正在运行，配置将在 agent_settled 后重载", "info");
          else ctx.ui.notify("飞书配置已重载", "info");
          break;

        case "config":
          ctx.ui.notify(
            `当前配置:\n` +
              `App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}\n` +
              `App Secret: ${config.appSecret ? "****" : "未设置"}\n` +
              `Domain: ${config.domain || "feishu"}\n` +
              `Streaming Transport: ${config.streamingTransport ?? "auto"}\n` +
              `Show Thinking: ${config.showThinking ?? false}\n` +
              `Encrypt Key: ${config.encryptKey ? "已设置" : "未设置"}\n` +
              `Verification Token: ${config.verificationToken ? "已设置" : "未设置"}`,
            "info",
          );
          break;

        case "help":
          ctx.ui.notify(
            `/feishu 命令用法:\n` +
              `  /feishu start   - 启动飞书 Bot 连接\n` +
              `  /feishu stop    - 断开飞书 Bot 连接\n` +
              `  /feishu status  - 查看连接状态\n` +
              `  /feishu config  - 查看当前配置\n` +
              `  /feishu config reload - 重载配置\n` +
              `  /feishu monitor [reset] - 查看或清零指标\n` +
              `  /feishu doctor  - 运行配置诊断\n` +
              `  /feishu help    - 显示帮助\n\n` +
              `配置优先级（从高到低）:\n` +
              `  1. CLI 标志: --feishu-app-id, --feishu-app-secret\n` +
              `  2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET\n` +
              `  3. settings.json 中的 feishu 字段`,
            "info",
          );
          break;

        default:
          ctx.ui.notify(`未知命令: ${action}，使用 /feishu help 查看帮助`, "warning");
      }
    },
  });

  // ─── 注册自定义工具 ──────────────────────────────────

  const AskFeishuParams = {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "需要用户澄清的问题" },
      choices: { type: "array" as const, items: { type: "string" as const }, minItems: 1, maxItems: 10 },
      chat_id: { type: "string" as const, description: "目标聊天 ID；留空使用当前聊天" },
      timeout_seconds: { type: "number" as const, description: "等待秒数，默认使用配置值" },
    },
    required: ["question", "choices"],
  };

  pi.registerTool({
    name: "ask_feishu",
    label: "向飞书用户提问",
    description: "通过飞书交互式选择卡片向授权用户澄清问题，并等待其选择。",
    parameters: AskFeishuParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof AskFeishuParams>, signal) {
      const chatId = params.chat_id || streaming?.activeSession?.chatId || latestChatId;
      if (!client || !clarify || !chatId || !params.question || !params.choices?.length) return { content: [{ type: "text" as const, text: "错误: 飞书未连接、没有目标聊天或参数不完整。" }], details: {} as Record<string, unknown> };
      if (config.allowedChatIds?.length && !config.allowedChatIds.includes(chatId)) return { content: [{ type: "text" as const, text: "错误: 目标聊天不在 allowlist 中。" }], details: { chatId } as Record<string, unknown> };
      const timeout = Math.min(3600, Math.max(5, Number(params.timeout_seconds ?? config.clarifyTimeoutSec ?? 300))) * 1000;
      try {
        const choice = await clarify.ask(chatId, params.question, params.choices, config.allowedOpenIds ?? [], timeout, signal);
        return { content: [{ type: "text" as const, text: `用户选择：${choice}` }], details: { choice, chatId } as Record<string, unknown> };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `澄清失败：${error instanceof Error ? error.message : String(error)}` }], details: { chatId } as Record<string, unknown> };
      }
    },
  });

  // 发送文本消息
  const SendToFeishuParams = {
    type: "object" as const,
    properties: {
      message: { type: "string" as const, description: "要发送的消息内容" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID（飞书 chat_id），留空则发送到最近活跃的聊天",
      },
    },
    required: ["message"],
  };

  pi.registerTool({
    name: "send_to_feishu",
    label: "发送到飞书",
    description: "发送消息到飞书聊天界面。当用户要求通过飞书发送消息时使用。",
    parameters: SendToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const message = params.message as string;
      const chatId = (params.chat_id as string) || streaming?.activeSession?.chatId || latestChatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [
            { type: "text" as const, text: "错误: 飞书 Bot 未连接。请先运行 /feishu start 启动连接。" },
          ],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [
            { type: "text" as const, text: "错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。" },
          ],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendMessage(chatId, downgradeHeadings(message));
      return {
        content: [{ type: "text" as const, text: `已发送到飞书 [${chatId}]: ${message}` }],
        details: { sent: true, chatId, message } as Record<string, unknown>,
      };
    },
  });

  // 发送图片
  const SendImageToFeishuParams = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const, description: "本地图片文件路径" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID，留空则发送到最近活跃的聊天",
      },
    },
    required: ["file_path"],
  };

  pi.registerTool({
    name: "send_image_to_feishu",
    label: "发送图片到飞书",
    description: "将本地图片文件上传到飞书并发送。当需要发送图片到飞书聊天时使用。",
    parameters: SendImageToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendImageToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const filePath = params.file_path as string;
      const chatId = (params.chat_id as string) || streaming?.activeSession?.chatId || latestChatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [{ type: "text" as const, text: "错误: 飞书 Bot 未连接。" }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [{ type: "text" as const, text: "错误: 没有活跃的飞书聊天。" }],
          details: {} as Record<string, unknown>,
        };
      }

      const imageKey = await client.uploadImage(filePath);
      if (!imageKey) {
        return {
          content: [{ type: "text" as const, text: "错误: 图片上传失败。" }],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendImage(chatId, imageKey);
      return {
        content: [{ type: "text" as const, text: `图片已发送到飞书 [${chatId}]: ${filePath}` }],
        details: { sent: true, chatId, filePath, imageKey } as Record<string, unknown>,
      };
    },
  });

  // 发送文件
  const SendFileToFeishuParams = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const, description: "本地文件路径" },
      file_name: { type: "string" as const, description: "文件名" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID，留空则发送到最近活跃的聊天",
      },
    },
    required: ["file_path", "file_name"],
  };

  pi.registerTool({
    name: "send_file_to_feishu",
    label: "发送文件到飞书",
    description: "将本地文件上传到飞书并发送。当需要发送文件到飞书聊天时使用。",
    parameters: SendFileToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendFileToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const filePath = params.file_path as string;
      const fileName = params.file_name as string;
      const chatId = (params.chat_id as string) || streaming?.activeSession?.chatId || latestChatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [{ type: "text" as const, text: "错误: 飞书 Bot 未连接。" }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [{ type: "text" as const, text: "错误: 没有活跃的飞书聊天。" }],
          details: {} as Record<string, unknown>,
        };
      }

      const fileKey = await client.uploadFile(filePath, fileName);
      if (!fileKey) {
        return {
          content: [{ type: "text" as const, text: "错误: 文件上传失败。" }],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendFile(chatId, fileKey);
      return {
        content: [{ type: "text" as const, text: `文件已发送到飞书 [${chatId}]: ${fileName}` }],
        details: { sent: true, chatId, filePath, fileName, fileKey } as Record<string, unknown>,
      };
    },
  });

  // ─── 会话生命周期 ─────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    updateStatus(ctx, "disconnected");

    try {
      await startFeishuClient();
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(`飞书连接失败: ${err}`, "error");
      }
    }

    // newSession/reload 后新实例在此投递跨实例回执
    const pending = takePendingFeishuNotify();
    if (pending && client && client.getStatus() === "connected") {
      // 丢弃过旧请求（例如上次未完成的残留）
      if (Date.now() - pending.at < 120_000) {
        latestChatId = pending.chatId;
        try {
          await client.sendMessage(pending.chatId, pending.text);
        } catch (err) {
          console.warn(`[pi-feishu] pending notify failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 启动后刷新积压的队列
    flushAllQueues();
  });

  pi.on("session_shutdown", async () => {
    await clarify?.abort();
    await streaming?.terminate("Pi 会话已关闭");
    if (client) {
      client.disconnect();
      client = null;
    }
    streaming?.release();
    streaming = null;
  });

  // ─── 工具函数 ────────────────────────────────────────

  /**
   * Markdown 标题降级：所有出站文本的标题层级 +2，最小 H6。
   * 规则：只处理行首 # 开头、不在代码块内的标题行。
   *   H1 → H3, H2 → H4, H3 → H5, H4 → H6, H5/H6 → H6
   */
  function downgradeHeadings(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      // 追踪代码块状态
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        result.push(line);
        continue;
      }

      if (inCodeBlock) {
        result.push(line);
        continue;
      }

      // 匹配行首标题：1-6 个 # 后跟空格或行尾
      const match = line.match(/^(#{1,6})\s/);
      if (match) {
        const level = match[1].length;
        const newLevel = Math.min(level + 2, 6);
        result.push("#".repeat(newLevel) + line.slice(level));
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /** 状态栏瞬态消息定时器 */
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStatusText: string = "";

  function updateStatus(ctx: ExtensionContext | null, status: string): void {
    if (!ctx?.hasUI) return;

    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }

    const statusMap: Record<string, string> = {
      connecting: "飞书: 连接中",
      connected: "飞书: 已连接",
      disconnected: "飞书: 未连接",
      error: "飞书: 错误",
    };

    const text = statusMap[status] ?? `飞书: ${status}`;
    if (currentStatusText === text) return;
    currentStatusText = text;
    ctx.ui.setStatus("feishu", text);
  }

  function flashStatus(message: string): void {
    if (!ctxRef?.hasUI) return;
    if (statusTimer) clearTimeout(statusTimer);

    if (currentStatusText === message) return;
    currentStatusText = message;
    ctxRef.ui.setStatus("feishu", message);

    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (client && client.getStatus() === "connected") {
        const text = "飞书: 已连接";
        if (currentStatusText !== text) {
          currentStatusText = text;
          ctxRef?.ui.setStatus("feishu", text);
        }
      }
    }, 3000);
  }

}
