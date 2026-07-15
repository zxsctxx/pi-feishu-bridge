/**
 * 飞书 /session 展示与 /name 相关的纯逻辑。
 */

export interface SessionMetaInput {
  name?: string;
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  context?: {
    tokens: number | null;
    contextWindow: number;
    percent?: number | null;
  };
  modelLine?: string;
}

export interface MessageLikeEntry {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
  };
}

/** 与 Pi AgentSession.getSessionStats 对齐的 entries 聚合 */
export function aggregateSessionStats(entries: MessageLikeEntry[]): {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: SessionMetaInput["tokens"];
  cost: number;
} {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let totalMessages = 0;
  let toolCalls = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    totalMessages++;
    const message = entry.message;
    if (message.role === "user") {
      userMessages++;
      continue;
    }
    if (message.role === "toolResult") {
      toolResults++;
      continue;
    }
    if (message.role !== "assistant") continue;

    assistantMessages++;
    if (Array.isArray(message.content)) {
      toolCalls += message.content.filter(
        (c: { type?: string }) => c?.type === "toolCall",
      ).length;
    }
    const usage = message.usage;
    if (!usage) continue;
    totalInput += usage.input ?? 0;
    totalOutput += usage.output ?? 0;
    totalCacheRead += usage.cacheRead ?? 0;
    totalCacheWrite += usage.cacheWrite ?? 0;
    totalCost += usage.cost?.total ?? 0;
  }

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    },
    cost: totalCost,
  };
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatSessionMeta(info: SessionMetaInput): string {
  const lines: string[] = ["会话信息"];
  if (info.name) lines.push(`名称: ${info.name}`);
  lines.push(`ID: ${info.sessionId}`);
  lines.push(`文件: ${info.sessionFile ?? "（内存/未落盘）"}`);
  if (info.cwd) lines.push(`工作目录: ${info.cwd}`);
  if (info.modelLine) lines.push(`模型: ${info.modelLine}`);

  lines.push("");
  lines.push("消息");
  lines.push(`- 合计: ${info.totalMessages}`);
  lines.push(`- 用户: ${info.userMessages}`);
  lines.push(`- 助手: ${info.assistantMessages}`);
  lines.push(`- 工具: ${info.toolCalls} 次调用, ${info.toolResults} 次结果`);

  const { input, output, cacheRead, cacheWrite, total } = info.tokens;
  const promptTokens = input + cacheRead + cacheWrite;
  lines.push("");
  lines.push("Token");
  lines.push(`- 输入: ${formatCount(promptTokens)}`);
  if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const hit = ((cacheRead / promptTokens) * 100).toFixed(1);
    lines.push(`  · 缓存命中: ${formatCount(cacheRead)} (${hit}%)`);
    const uncached = input + cacheWrite;
    const written =
      cacheWrite > 0 ? `（写入缓存 ${formatCount(cacheWrite)}）` : "";
    lines.push(`  · 未命中: ${formatCount(uncached)}${written}`);
  }
  lines.push(`- 输出: ${formatCount(output)}`);
  lines.push(`- 合计: ${formatCount(total)}`);

  if (info.cost > 0) {
    lines.push("");
    lines.push(`费用: $${info.cost.toFixed(3)}`);
  }

  if (info.context && info.context.tokens !== null && info.context.contextWindow > 0) {
    const pct =
      info.context.percent != null && !Number.isNaN(info.context.percent)
        ? ` (${info.context.percent}%)`
        : "";
    lines.push(
      `上下文: ${formatCount(info.context.tokens)}/${formatCount(info.context.contextWindow)}${pct}`,
    );
  }

  return lines.join("\n");
}

export function formatNameResult(name: string | undefined, mode: "set" | "cleared" | "show"): string {
  if (mode === "set") return `已设置会话名称：${name}`;
  if (mode === "cleared") return "已清除会话名称。";
  if (name) return `当前会话名称：${name}\n用法: /name <名称>  ·  /name clear 清除`;
  return "当前未设置会话名称。\n用法: /name <名称>  ·  /name clear 清除";
}
