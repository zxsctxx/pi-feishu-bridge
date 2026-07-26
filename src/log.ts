/**
 * 统一日志。
 *
 * 全项目使用同一前缀，便于在 Pi 终端输出中筛选。
 * debug 档默认关闭，设 FEISHU_DEBUG=1 开启。
 */

const PREFIX = "[pi-feishu]";

const debugEnabled = (() => {
  const raw = process.env.FEISHU_DEBUG;
  return raw === "1" || raw === "true";
})();

export function debug(...args: unknown[]): void {
  if (debugEnabled) console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}

/** 把任意抛出物转成可读文本，避免各处重复写三元表达式 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
