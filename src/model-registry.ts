/**
 * `/model` 命令的模型解析与列表渲染。
 *
 * 与 TUI 的 `/model pattern:level` 写法对齐，支持 provider/id、裸 id、
 * 模糊匹配以及 `:thinking` 后缀。
 */

import { readFileSync, existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalSettingsPath, projectSettingsPath } from "./config.js";

/** 与 TUI `/model pattern:level` 对齐的 thinking 后缀 */
export const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevelName =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export function parseModelArg(raw: string): { pattern: string; thinking?: ThinkingLevelName } {
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

export function formatModelRef(model: { provider: string; id: string; name?: string }): string {
  const base = `${model.provider}/${model.id}`;
  return model.name && model.name !== model.id ? `${base} (${model.name})` : base;
}

export type ListedModel = { provider: string; id: string; name?: string };

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
  const global = readSettingsObject(globalSettingsPath());
  const project = readSettingsObject(projectSettingsPath());
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
export function buildModelListLines(
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
export function resolveModelFromArg(
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
