export interface ToolStep {
  toolCallId: string;
  name: string;
  status: "running" | "success" | "error";
  detail: string;
  output: string;
  startedAt: number;
  elapsedMs: number;
  orphan: boolean;
}

const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|cookie|credential|bearer/i;
const SECRET_VALUE =
  /(authorization\s*[:=]\s*|bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi;

const DETAIL_LIMIT = 500;
const OUTPUT_LIMIT = 800;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      result[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE, "$1[redacted]").slice(0, 500);
  return value;
}

function clip(text: string, limit: number): string {
  const oneLine = text.replace(/\r\n/g, "\n").replace(/[\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function shortenPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function pathOf(args: Record<string, unknown>): string {
  const raw = args.path ?? args.file_path ?? args.filePath ?? "";
  return shortenPath(String(raw || ""));
}

/** 工具参数 → 人类可读一行（对齐 pi 终端 formatToolCall 思路） */
export function formatToolDetail(name: string, args: unknown): string {
  try {
    const clean = sanitize(args);
    if (typeof clean === "string") return clip(clean, DETAIL_LIMIT);
    const obj = asRecord(clean);
    if (!obj) {
      return clip(JSON.stringify(clean), DETAIL_LIMIT);
    }

    const tool = name.toLowerCase();
    switch (tool) {
      case "bash":
      case "shell":
      case "run": {
        const cmd = String(obj.command ?? obj.cmd ?? "").trim();
        return clip(cmd || JSON.stringify(obj), DETAIL_LIMIT);
      }
      case "read": {
        const path = pathOf(obj);
        const offset = obj.offset;
        const limit = obj.limit;
        if (offset !== undefined || limit !== undefined) {
          const start = offset ?? 1;
          const end = limit !== undefined ? Number(start) + Number(limit) - 1 : "";
          return clip(`${path}:${start}${end !== "" ? `-${end}` : ""}`, DETAIL_LIMIT);
        }
        return clip(path || JSON.stringify(obj), DETAIL_LIMIT);
      }
      case "write":
      case "edit": {
        const path = pathOf(obj);
        return clip(path || JSON.stringify(obj), DETAIL_LIMIT);
      }
      case "grep":
      case "rg": {
        const pattern = String(obj.pattern ?? obj.query ?? "");
        const path = pathOf(obj) || String(obj.path ?? ".");
        const parts = [pattern ? `/${pattern}/` : "", path].filter(Boolean);
        return clip(parts.join(" ") || JSON.stringify(obj), DETAIL_LIMIT);
      }
      case "find":
      case "ls": {
        const path = pathOf(obj) || String(obj.path ?? ".");
        const pattern = obj.pattern != null ? String(obj.pattern) : "";
        return clip(pattern ? `${path} ${pattern}` : path, DETAIL_LIMIT);
      }
      default: {
        // 通用：优先 command / path / 短 key=value，避免整包 JSON
        if (typeof obj.command === "string" && obj.command.trim()) {
          return clip(String(obj.command), DETAIL_LIMIT);
        }
        if (pathOf(obj)) {
          return clip(pathOf(obj), DETAIL_LIMIT);
        }
        const pairs: string[] = [];
        for (const [key, item] of Object.entries(obj).slice(0, 6)) {
          if (item == null) continue;
          if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
            pairs.push(`${key}=${item}`);
          } else {
            pairs.push(`${key}=…`);
          }
        }
        return clip(pairs.join(" ") || JSON.stringify(obj), DETAIL_LIMIT);
      }
    }
  } catch {
    return clip(String(args), DETAIL_LIMIT);
  }
}

/** 抽取 tool result 中最有用的文本，一行展示 */
export function formatToolOutput(result: unknown): string {
  try {
    const clean = sanitize(result);
    if (typeof clean === "string") return clip(clean, OUTPUT_LIMIT);
    if (clean == null) return "";

    // Pi tool result 常见：{ content: [{ type: "text", text: "..." }, ...] }
    const obj = asRecord(clean);
    if (obj) {
      if (typeof obj.text === "string") return clip(obj.text, OUTPUT_LIMIT);
      if (typeof obj.output === "string") return clip(obj.output, OUTPUT_LIMIT);
      if (typeof obj.message === "string") return clip(obj.message, OUTPUT_LIMIT);
      if (typeof obj.error === "string") return clip(obj.error, OUTPUT_LIMIT);

      const content = obj.content;
      if (typeof content === "string") return clip(content, OUTPUT_LIMIT);
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const item of content) {
          if (typeof item === "string") {
            texts.push(item);
            continue;
          }
          const block = asRecord(item);
          if (!block) continue;
          if (typeof block.text === "string") texts.push(block.text);
          else if (block.type === "image") texts.push("[image]");
        }
        if (texts.length) return clip(texts.join("\n"), OUTPUT_LIMIT);
      }

      // details 类噪声字段跳过，只留主字段摘要
      const skip = new Set(["details", "truncation", "meta", "usage"]);
      const pairs: string[] = [];
      for (const [key, item] of Object.entries(obj).slice(0, 8)) {
        if (skip.has(key)) continue;
        if (item == null) continue;
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          pairs.push(`${key}=${item}`);
        }
      }
      if (pairs.length) return clip(pairs.join(" "), OUTPUT_LIMIT);
    }

    if (Array.isArray(clean)) {
      return clip(JSON.stringify(clean), OUTPUT_LIMIT);
    }

    return clip(JSON.stringify(clean), OUTPUT_LIMIT);
  } catch {
    return clip(String(result), OUTPUT_LIMIT);
  }
}

export class ToolTracker {
  private readonly steps = new Map<string, ToolStep>();
  private readonly order: string[] = [];

  private ensure(id: string): ToolStep {
    let step = this.steps.get(id);
    if (!step) {
      step = {
        toolCallId: id,
        name: "未知工具",
        status: "running",
        detail: "",
        output: "",
        startedAt: Date.now(),
        elapsedMs: 0,
        orphan: true,
      };
      this.steps.set(id, step);
      this.order.push(id);
    }
    return step;
  }

  start(id: string, name: string, args: unknown): void {
    const step = this.ensure(id);
    step.name = name;
    step.detail = formatToolDetail(name, args);
    step.orphan = false;
    if (step.startedAt === 0) step.startedAt = Date.now();
  }

  update(id: string, result: unknown): boolean {
    const created = !this.steps.has(id);
    this.ensure(id).output = formatToolOutput(result);
    return created;
  }

  end(id: string, result: unknown, isError: boolean): boolean {
    const created = !this.steps.has(id);
    const step = this.ensure(id);
    step.status = isError ? "error" : "success";
    step.output = formatToolOutput(result);
    step.elapsedMs = Math.max(0, Date.now() - step.startedAt);
    return created;
  }

  get(id: string): ToolStep | undefined {
    return this.steps.get(id);
  }

  list(max: number): { hidden: number; steps: ToolStep[] } {
    const all = this.order.map((id) => this.steps.get(id)!).filter(Boolean);
    return { hidden: Math.max(0, all.length - max), steps: all.slice(-max) };
  }
}
