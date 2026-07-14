export interface ToolStep { toolCallId: string; name: string; status: "running" | "success" | "error"; detail: string; output: string; startedAt: number; elapsedMs: number; orphan: boolean; }
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|cookie|credential|bearer/i;
const SECRET_VALUE = /(authorization\s*[:=]\s*|bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/ig;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) result[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    return result;
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE, "$1[redacted]").slice(0, 500);
  return value;
}
function summarize(value: unknown): string { try { const text = typeof value === "string" ? String(sanitize(value)) : JSON.stringify(sanitize(value)); return text.length > 800 ? `${text.slice(0, 800)}…` : text; } catch { return String(value).slice(0, 800); } }

export class ToolTracker {
  private readonly steps = new Map<string, ToolStep>(); private readonly order: string[] = [];
  private ensure(id: string): ToolStep { let step = this.steps.get(id); if (!step) { step = { toolCallId: id, name: "未知工具", status: "running", detail: "", output: "", startedAt: Date.now(), elapsedMs: 0, orphan: true }; this.steps.set(id, step); this.order.push(id); } return step; }
  start(id: string, name: string, args: unknown): void { const step = this.ensure(id); step.name = name; step.detail = summarize(args); step.orphan = false; if (step.startedAt === 0) step.startedAt = Date.now(); }
  update(id: string, result: unknown): boolean { const created = !this.steps.has(id); this.ensure(id).output = summarize(result); return created; }
  end(id: string, result: unknown, isError: boolean): boolean { const created = !this.steps.has(id); const step = this.ensure(id); step.status = isError ? "error" : "success"; step.output = summarize(result); step.elapsedMs = Math.max(0, Date.now() - step.startedAt); return created; }
  get(id: string): ToolStep | undefined { return this.steps.get(id); }
  list(max: number): { hidden: number; steps: ToolStep[] } { const all = this.order.map((id) => this.steps.get(id)!).filter(Boolean); return { hidden: Math.max(0, all.length - max), steps: all.slice(-max) }; }
}
