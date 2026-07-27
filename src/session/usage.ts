/**
 * 会话 token / 费用累计。
 *
 * 口径与终端 footer 对齐：遍历 session 内全部 assistant 消息的 usage 累加。
 */

export interface MessageUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** 无推理 token 时为 undefined，避免 footer 显示 0 */
  reasoningTokens: number | undefined;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** 最近一次有缓存的请求的命中率（%） */
  cacheHitPercent: number | undefined;
}

/** session 条目中形如 assistant message 的部分 */
export interface UsageEntry {
  type?: string;
  message?: { role?: string; usage?: MessageUsage };
}

/**
 * 累加 assistant usage。
 *
 * `pending` 用于 message_end 时当前条尚未写入 session 文件的情况；
 * 传入后与已落盘条目一起计入，避免最后一轮 token 短暂缺失。
 */
export function accumulateUsage(
  entries: readonly UsageEntry[],
  pending?: MessageUsage,
): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let cacheHitPercent: number | undefined;

  const apply = (usage: MessageUsage | undefined): void => {
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
    // 命中率取最近一次有缓存的请求，与终端 CH 字段口径一致
    const promptTokens = input + cr + cw;
    if (promptTokens > 0 && (cr > 0 || cw > 0)) {
      cacheHitPercent = (cr / promptTokens) * 100;
    }
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "assistant") apply(entry.message.usage);
  }
  apply(pending);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    cacheRead,
    cacheWrite,
    cost,
    cacheHitPercent,
  };
}
