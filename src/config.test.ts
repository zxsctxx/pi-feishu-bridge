import { describe, expect, it } from "vitest";
import { buildConfig, parseFooter, validateConfig, LIMITS } from "./config.js";

/** 隔离环境变量，避免宿主机 FEISHU_* 影响断言 */
const noEnv: NodeJS.ProcessEnv = {};

describe("默认值", () => {
  it("空配置回落到文档化的默认值", () => {
    const config = buildConfig({}, noEnv);

    expect(config.domain).toBe("feishu");
    expect(config.accessPolicy).toBe("allowlist");
    expect(config.sameChatBusyPolicy).toBe("queue");
    expect(config.showThinking).toBe(false);
    expect(config.flushIntervalMs).toBe(LIMITS.flushIntervalMs.fallback);
    expect(config.taskTimeoutSec).toBe(LIMITS.taskTimeoutSec.fallback);
  });

  it("appId/appSecret 缺省为空串", () => {
    const config = buildConfig({}, noEnv);
    expect(config.appId).toBe("");
    expect(config.appSecret).toBe("");
  });
});

describe("数值钳制", () => {
  it("低于下限时抬到 min", () => {
    const config = buildConfig({ flushIntervalMs: 5, printFrequencyMs: 1 }, noEnv);
    expect(config.flushIntervalMs).toBe(LIMITS.flushIntervalMs.min);
    expect(config.printFrequencyMs).toBe(LIMITS.printFrequencyMs.min);
  });

  it("高于上限时压到 max", () => {
    const config = buildConfig({ flushIntervalMs: 999999, maxAnswerElementChars: 10_000_000 }, noEnv);
    expect(config.flushIntervalMs).toBe(LIMITS.flushIntervalMs.max);
    expect(config.maxAnswerElementChars).toBe(LIMITS.maxAnswerElementChars.max);
  });

  it("非数值回落到默认值", () => {
    const config = buildConfig({ flushIntervalMs: "不是数字", maxToolSteps: null }, noEnv);
    expect(config.flushIntervalMs).toBe(LIMITS.flushIntervalMs.fallback);
    expect(config.maxToolSteps).toBe(LIMITS.maxToolSteps.fallback);
  });

  it("区间内的值原样保留", () => {
    const config = buildConfig({ flushIntervalMs: 500, taskTimeoutSec: 1800 }, noEnv);
    expect(config.flushIntervalMs).toBe(500);
    expect(config.taskTimeoutSec).toBe(1800);
  });

  it("字符串数字可解析（环境变量场景）", () => {
    const config = buildConfig({}, { FEISHU_FLUSH_INTERVAL_MS: "300" });
    expect(config.flushIntervalMs).toBe(300);
  });
});

describe("优先级与解析", () => {
  it("环境变量覆盖 settings", () => {
    const config = buildConfig({ appId: "from_settings" }, { FEISHU_APP_ID: "from_env" });
    expect(config.appId).toBe("from_env");
  });

  it("allowlist 支持数组与逗号分隔字符串", () => {
    expect(buildConfig({ allowedOpenIds: ["ou_a", "ou_b"] }, noEnv).allowedOpenIds).toEqual(["ou_a", "ou_b"]);
    expect(buildConfig({}, { FEISHU_ALLOWED_OPEN_IDS: "ou_a, ou_b" }).allowedOpenIds).toEqual(["ou_a", "ou_b"]);
  });

  it("布尔值接受 true/1 字符串", () => {
    expect(buildConfig({ showThinking: "true" }, noEnv).showThinking).toBe(true);
    expect(buildConfig({ showThinking: "1" }, noEnv).showThinking).toBe(true);
    expect(buildConfig({ showThinking: "false" }, noEnv).showThinking).toBe(false);
  });

  it("sameChatBusyPolicy 接受 interrupt 的别名", () => {
    for (const raw of ["interrupt", "abort", "replace"]) {
      expect(buildConfig({ sameChatBusyPolicy: raw }, noEnv).sameChatBusyPolicy).toBe("interrupt");
    }
    expect(buildConfig({ sameChatBusyPolicy: "什么都不是" }, noEnv).sameChatBusyPolicy).toBe("queue");
  });

  it("不再识别 snake_case 键名", () => {
    const config = buildConfig({ app_id: "legacy", show_thinking: true }, noEnv);
    expect(config.appId).toBe("");
    expect(config.showThinking).toBe(false);
  });
});

describe("parseFooter", () => {
  it("无 footer 段时返回 undefined", () => {
    expect(parseFooter(undefined)).toBeUndefined();
    expect(parseFooter({})).toBeUndefined();
  });

  it("保留合法字段并丢弃未知字段", () => {
    const footer = parseFooter({ lines: [["status", "不存在的字段", "elapsed"]] });
    expect(footer?.lines).toEqual([["status", "elapsed"]]);
  });

  it("整行字段都非法时丢弃该行", () => {
    const footer = parseFooter({ lines: [["status"], ["垃圾", "更多垃圾"]] });
    expect(footer?.lines).toEqual([["status"]]);
  });

  it("showFooter 接受布尔与字符串", () => {
    expect(parseFooter({ showFooter: false })?.showFooter).toBe(false);
    expect(parseFooter({ showFooter: "0" })?.showFooter).toBe(false);
    expect(parseFooter({ showFooter: "true" })?.showFooter).toBe(true);
  });
});

describe("validateConfig", () => {
  it("缺少凭据时报告两个问题", () => {
    const problems = validateConfig(buildConfig({}, noEnv));
    expect(problems.map((p) => p.field)).toContain("appId");
    expect(problems.map((p) => p.field)).toContain("appSecret");
  });

  it("allowlist 为空时给出警告", () => {
    const problems = validateConfig(
      buildConfig({ appId: "cli_x", appSecret: "s", accessPolicy: "allowlist" }, noEnv),
    );
    expect(problems.map((p) => p.field)).toContain("allowedOpenIds");
  });

  it("配置完整时无问题", () => {
    const problems = validateConfig(
      buildConfig({ appId: "cli_x", appSecret: "s", allowedOpenIds: ["ou_a"] }, noEnv),
    );
    expect(problems).toEqual([]);
  });

  it("open 策略不要求白名单", () => {
    const problems = validateConfig(
      buildConfig({ appId: "cli_x", appSecret: "s", accessPolicy: "open" }, noEnv),
    );
    expect(problems).toEqual([]);
  });
});
