import { describe, expect, it } from "vitest";
import { dispatchCommand, type CommandDeps } from "./index.js";
import { MessageQueueManager } from "../queue.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { ConfigReloadCoordinator } from "../monitoring/reload.js";

/** 飞书侧支持的全部命令，与文档和 /help 保持同步 */
const SUPPORTED = [
  "/feishu", "/new", "/resume", "/reload", "/stop", "/queue",
  "/compact", "/model", "/status", "/name", "/session", "/help",
];

interface Sent {
  chatId: string;
  text: string;
  replyTo?: string;
}

function deps(overrides: Partial<CommandDeps> = {}) {
  const sent: Sent[] = [];
  const client = {
    sendMessage: async (chatId: string, text: string, replyTo?: string) => {
      sent.push({ chatId, text, replyTo });
    },
    sendStatusCard: async (chatId: string, text: string, replyTo?: string) => {
      sent.push({ chatId, text, replyTo });
      return "status-card-1";
    },
    updateTextCard: async (_messageId: string, text: string) => {
      sent.push({ chatId: "updated", text });
    },
    getStatus: () => "connected" as const,
    stopTyping: async () => {},
    checkCardKitAvailability: async () => true as const,
  };

  const base: CommandDeps = {
    pi: {
      getSessionName: () => "测试会话",
      setSessionName: () => {},
      getThinkingLevel: () => "medium",
      setModel: async () => true,
      setThinkingLevel: () => {},
      sendUserMessage: () => {},
    } as unknown as CommandDeps["pi"],
    client: client as unknown as CommandDeps["client"],
    ctx: null,
    config: { appId: "cli_test", appSecret: "s", accessPolicy: "open" } as CommandDeps["config"],
    streaming: null,
    clarify: null,
    metrics: new MetricsCollector(),
    configReload: new ConfigReloadCoordinator(),
    queues: new MessageQueueManager({ isAgentIdle: () => true }),
    prepareSessionControl: async () => {},
    reloadConfig: async () => {},
    flashStatus: () => {},
    setPendingNotify: () => {},
    setPendingResumePath: () => {},
    clearTaskTimeout: () => {},
    ...overrides,
  };
  return { deps: base, sent };
}

describe("命令覆盖", () => {
  it("所有受支持的命令都被路由识别", async () => {
    for (const name of SUPPORTED) {
      const { deps: d, sent } = deps();
      await dispatchCommand(d, "oc_a", "om_1", name);
      expect(sent.length, `${name} 应有回复`).toBeGreaterThan(0);
      expect(sent[0].text, `${name} 不应报未支持`).not.toContain("不支持通过飞书执行");
    }
  });

  it("未知命令提示去终端执行", async () => {
    const { deps: d, sent } = deps();
    await dispatchCommand(d, "oc_a", "om_1", "/tools");
    expect(sent[0].text).toContain("不支持通过飞书执行");
  });

  it("/help 列出的命令都真实存在", async () => {
    const { deps: d, sent } = deps();
    await dispatchCommand(d, "oc_a", "om_1", "/help");
    const mentioned = sent[0].text.match(/^ {2}(\/[a-z]+)/gm)?.map((s) => s.trim()) ?? [];
    for (const name of mentioned) {
      // /tools 在帮助里被显式标注为「请在终端执行」
      if (name === "/tools") continue;
      expect(SUPPORTED, `/help 提到了未注册的 ${name}`).toContain(name);
    }
  });
});

describe("回复与参数", () => {
  it("回复回带原消息 id", async () => {
    const { deps: d, sent } = deps();
    await dispatchCommand(d, "oc_a", "om_42", "/queue");
    expect(sent[0]).toMatchObject({ chatId: "oc_a", replyTo: "om_42" });
  });

  it("命令名大小写不敏感", async () => {
    const { deps: d, sent } = deps();
    await dispatchCommand(d, "oc_a", "om_1", "/QUEUE");
    expect(sent[0].text).not.toContain("不支持");
  });

  it("参数原样传给 handler", async () => {
    const { deps: d, sent } = deps();
    await dispatchCommand(d, "oc_a", "om_1", "/feishu status");
    expect(sent[0].text).toContain("飞书连接");
  });

  it("带空格的子命令可路由", async () => {
    let reloaded = false;
    const { deps: d, sent } = deps({ reloadConfig: async () => { reloaded = true; } });
    await dispatchCommand(d, "oc_a", "om_1", "/feishu config reload");
    expect(reloaded).toBe(true);
    expect(sent[0].text).toContain("配置已重载");
  });

  it("缺少会话上下文时给出可读提示而非崩溃", async () => {
    const { deps: d, sent } = deps({ ctx: null });
    await dispatchCommand(d, "oc_a", "om_1", "/session");
    expect(sent[0].text).toContain("会话上下文不可用");
  });
});

describe("状态卡片", () => {
  it("/compact 在同一张卡片上更新完成状态", async () => {
    let onComplete: (() => void) | undefined;
    const { deps: d, sent } = deps({
      ctx: {
        compact: (callbacks: { onComplete: () => void }) => { onComplete = callbacks.onComplete; },
      } as unknown as CommandDeps["ctx"],
    });

    await dispatchCommand(d, "oc_a", "om_1", "/compact");
    expect(sent[0].text).toBe("正在压缩上下文…");
    onComplete?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sent.at(-1)?.text).toBe("上下文压缩已完成。");
    expect(sent).toHaveLength(2);
  });
});

describe("异常隔离", () => {
  it("handler 抛错时回复失败原因而非静默", async () => {
    const { deps: d, sent } = deps({
      prepareSessionControl: async () => { throw new Error("清理失败"); },
    });
    await dispatchCommand(d, "oc_a", "om_1", "/new");
    expect(sent.at(-1)?.text).toContain("命令执行失败");
    expect(sent.at(-1)?.text).toContain("清理失败");
  });
});
