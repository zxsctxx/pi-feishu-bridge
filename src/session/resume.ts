/**
 * 飞书 /resume 列表与解析（纯逻辑，便于单测）。
 * 交互式 TUI 选择器在飞书不可用，改为编号列表 + 参数切换。
 */

export interface ResumeSessionInfo {
  path: string;
  id: string;
  name?: string;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  cwd?: string;
}

export const RESUME_LIST_LIMIT = 15;
const PREVIEW_MAX = 48;

export function clipPreview(text: string, max = PREVIEW_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function formatRelativeTime(date: Date, nowMs = Date.now()): string {
  const t = date.getTime();
  if (Number.isNaN(t)) return "?";
  const delta = Math.max(0, nowMs - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const now = new Date(nowMs);
  if (y === now.getFullYear()) return `${m}-${d} ${hh}:${mm}`;
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function sessionDisplayTitle(session: ResumeSessionInfo): string {
  if (session.name?.trim()) return session.name.trim();
  return clipPreview(session.firstMessage || "(无消息)");
}

export function formatSessionListLine(
  index: number,
  session: ResumeSessionInfo,
  currentId?: string | null,
): string {
  const mark = currentId && session.id === currentId ? " ← 当前" : "";
  const title = sessionDisplayTitle(session);
  const age = formatRelativeTime(session.modified);
  const shortId = session.id.length > 12 ? `${session.id.slice(0, 8)}…` : session.id;
  return `${index}. ${title}${mark}\n   ${age} · ${session.messageCount} 条 · ${shortId}`;
}

export function formatResumeList(
  sessions: ResumeSessionInfo[],
  options?: { currentId?: string | null; limit?: number; scopeNote?: string },
): string {
  const limit = options?.limit ?? RESUME_LIST_LIMIT;
  const shown = sessions.slice(0, limit);
  if (shown.length === 0) {
    return [
      "没有可恢复的会话。",
      "用法: /resume              列出本工作目录最近会话",
      "      /resume <编号>       切换到列表中的会话",
      "      /resume <id/名称>    按 id 前缀或名称匹配",
      "      /resume all          列出全部工作目录的会话",
    ].join("\n");
  }

  const lines = shown.map((s, i) => formatSessionListLine(i + 1, s, options?.currentId));
  const more =
    sessions.length > shown.length
      ? `\n…另有 ${sessions.length - shown.length} 个未显示，可用 id 前缀精确切换`
      : "";
  const scope = options?.scopeNote ? `\n${options.scopeNote}` : "";

  return [
    `可恢复会话 (最近 ${shown.length}/${sessions.length}):${scope}`,
    "",
    ...lines,
    more,
    "",
    "用法: /resume <编号|id前缀|名称>",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i + 1] === ""))
    .join("\n");
}

export type ResolveSessionResult =
  | { ok: true; session: ResumeSessionInfo }
  | { ok: false; error: string };

/**
 * 在已排序的会话列表中解析用户参数。
 * - 纯数字：1-based 索引（仅对 limit 窗口内有效）
 * - 其他：id 精确/前缀、path 包含、name 包含（不区分大小写）
 */
export function resolveSessionFromArg(
  sessions: ResumeSessionInfo[],
  rawArg: string,
  options?: { listLimit?: number },
): ResolveSessionResult {
  const arg = rawArg.trim();
  if (!arg) {
    return { ok: false, error: "缺少参数。先发 /resume 查看列表。" };
  }

  const listLimit = options?.listLimit ?? RESUME_LIST_LIMIT;
  if (/^\d+$/.test(arg)) {
    const n = Number.parseInt(arg, 10);
    if (n < 1 || n > listLimit) {
      return {
        ok: false,
        error: `编号须在 1–${Math.min(listLimit, Math.max(sessions.length, 1))} 之间。先发 /resume 查看列表。`,
      };
    }
    const window = sessions.slice(0, listLimit);
    const hit = window[n - 1];
    if (!hit) {
      return {
        ok: false,
        error: `编号 ${n} 超出当前列表（共 ${window.length} 项）。先发 /resume 查看。`,
      };
    }
    return { ok: true, session: hit };
  }

  const lower = arg.toLowerCase();
  const byExactId = sessions.find((s) => s.id === arg);
  if (byExactId) return { ok: true, session: byExactId };

  const byIdPrefix = sessions.filter((s) => s.id.toLowerCase().startsWith(lower));
  if (byIdPrefix.length === 1) return { ok: true, session: byIdPrefix[0] };
  if (byIdPrefix.length > 1) {
    return {
      ok: false,
      error: formatAmbiguous("id 前缀", byIdPrefix),
    };
  }

  const byPath = sessions.filter((s) => s.path.toLowerCase().includes(lower));
  if (byPath.length === 1) return { ok: true, session: byPath[0] };
  if (byPath.length > 1) {
    return { ok: false, error: formatAmbiguous("路径", byPath) };
  }

  const byName = sessions.filter((s) => {
    const name = s.name?.toLowerCase() ?? "";
    const first = (s.firstMessage ?? "").toLowerCase();
    return name.includes(lower) || first.includes(lower);
  });
  if (byName.length === 1) return { ok: true, session: byName[0] };
  if (byName.length > 1) {
    return { ok: false, error: formatAmbiguous("名称/摘要", byName) };
  }

  return {
    ok: false,
    error: `未找到会话：${arg}\n先发 /resume 查看列表，或用更长的 id 前缀。`,
  };
}

function formatAmbiguous(kind: string, matches: ResumeSessionInfo[]): string {
  const lines = matches
    .slice(0, 8)
    .map((s, i) => `  ${i + 1}. ${sessionDisplayTitle(s)} · ${s.id.slice(0, 12)}`);
  const more = matches.length > 8 ? `\n  …共 ${matches.length} 个` : "";
  return `匹配到多个会话（按${kind}），请写更精确的编号或 id：\n${lines.join("\n")}${more}`;
}
