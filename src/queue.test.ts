import { describe, expect, it } from "vitest";
import { MessageQueueManager, type QueuedMessage } from "./queue.js";

function msg(msgId: string, text = "hi"): QueuedMessage {
  return { msgId, text, resources: [], chatType: "p2p" };
}

/** idle 可变，模拟 Pi 侧忙闲切换 */
function manager(idle = true) {
  const state = { idle };
  const queues = new MessageQueueManager({ isAgentIdle: () => state.idle });
  return { queues, state };
}

describe("空闲时入队", () => {
  it("首条消息直接处理", () => {
    const { queues } = manager();
    expect(queues.enqueue("oc_a", msg("m1"), "queue", false)).toEqual({ action: "process" });
  });

  it("dequeue 返回消息并标记处理中", () => {
    const { queues } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);

    const item = queues.dequeue("oc_a");
    expect(item?.msgId).toBe("m1");
    expect(queues.isProcessing("oc_a")).toBe(true);
  });

  it("队列空时 dequeue 返回 null 并释放 processing", () => {
    const { queues } = manager();
    queues.setProcessing("oc_a", true);

    expect(queues.dequeue("oc_a")).toBeNull();
    expect(queues.isProcessing("oc_a")).toBe(false);
  });
});

describe("queue 策略", () => {
  it("同 chat 忙时排队并报告全局待处理数", () => {
    const { queues } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.dequeue("oc_a");

    const outcome = queues.enqueue("oc_a", msg("m2"), "queue", false);
    expect(outcome).toEqual({ action: "queued", pending: 1 });
  });

  it("流式仍在收尾时也算忙", () => {
    const { queues } = manager();
    // 队列已空闲，但该 chat 的卡片还在流式中
    const outcome = queues.enqueue("oc_a", msg("m1"), "queue", true);
    expect(outcome.action).toBe("queued");
  });

  it("Pi 忙时即使队列空闲也排队", () => {
    const { queues, state } = manager();
    state.idle = false;

    expect(queues.enqueue("oc_a", msg("m1"), "queue", false).action).toBe("queued");
  });

  it("按 FIFO 出队", () => {
    const { queues } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.enqueue("oc_a", msg("m2"), "queue", false);
    queues.enqueue("oc_a", msg("m3"), "queue", false);

    expect(queues.dequeue("oc_a")?.msgId).toBe("m1");
    queues.setProcessing("oc_a", false);
    expect(queues.dequeue("oc_a")?.msgId).toBe("m2");
  });
});

describe("interrupt 策略", () => {
  it("忙时连续到达的消息逐条打断，只保留最新一条", () => {
    const { queues, state } = manager();
    queues.enqueue("oc_a", msg("m1"), "interrupt", false);
    queues.dequeue("oc_a");
    state.idle = false;

    // 每条新消息都打断前一条，队列始终只留最新
    for (const id of ["m2", "m3", "m4"]) {
      const outcome = queues.enqueue("oc_a", msg(id), "interrupt", false);
      expect(outcome).toMatchObject({ action: "interrupted", agentBusy: true });
      expect(queues.pendingFor("oc_a")).toBe(1);
    }

    // agent settled 后放行，跑的是最后一条
    state.idle = true;
    queues.setProcessing("oc_a", false);
    expect(queues.dequeue("oc_a")?.msgId).toBe("m4");
    expect(queues.pendingFor("oc_a")).toBe(0);
  });

  it("dropped 反映被丢弃的排队条数", () => {
    const { queues, state } = manager();
    // 先用 queue 策略堆积，再切到 interrupt（对应运行中改配置）
    state.idle = false;
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.enqueue("oc_a", msg("m2"), "queue", false);
    queues.setProcessing("oc_a", true);

    const outcome = queues.enqueue("oc_a", msg("m3"), "interrupt", false);
    expect(outcome).toEqual({ action: "interrupted", dropped: 2, agentBusy: true });
    expect(queues.pendingFor("oc_a")).toBe(1);
  });

  it("agent 忙时保持 processing 等 settled", () => {
    const { queues, state } = manager();
    queues.enqueue("oc_a", msg("m1"), "interrupt", false);
    queues.dequeue("oc_a");
    state.idle = false;

    const outcome = queues.enqueue("oc_a", msg("m2"), "interrupt", false);
    expect(outcome).toMatchObject({ action: "interrupted", agentBusy: true });
    // 等 agent_settled 清 processing，避免与正在收尾的任务抢跑
    expect(queues.isProcessing("oc_a")).toBe(true);
  });

  it("空闲时按普通流程处理，不触发打断", () => {
    const { queues } = manager();
    expect(queues.enqueue("oc_a", msg("m1"), "interrupt", false)).toEqual({ action: "process" });
  });
});

describe("跨 chat 互斥", () => {
  it("另一个 chat 处理中时排队", () => {
    const { queues } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.dequeue("oc_a");

    expect(queues.enqueue("oc_b", msg("m2"), "queue", false).action).toBe("queued");
  });

  it("另一个 chat 处理中时 dequeue 拒绝出队", () => {
    const { queues } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.dequeue("oc_a");
    queues.enqueue("oc_b", msg("m2"), "queue", false);

    expect(queues.dequeue("oc_b")).toBeNull();
    expect(queues.isProcessing("oc_b")).toBe(false);
    // 消息仍在队列里，等 flush 重试
    expect(queues.pendingFor("oc_b")).toBe(1);
  });

  it("前一个 chat 释放后可以接着处理", () => {
    const { queues } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.dequeue("oc_a");
    queues.enqueue("oc_b", msg("m2"), "queue", false);

    queues.setProcessing("oc_a", false);
    expect(queues.dequeue("oc_b")?.msgId).toBe("m2");
  });

  it("pendingCount 汇总全部 chat", () => {
    const { queues, state } = manager();
    state.idle = false;
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.enqueue("oc_b", msg("m2"), "queue", false);
    queues.enqueue("oc_b", msg("m3"), "queue", false);

    expect(queues.pendingCount()).toBe(3);
    expect(queues.pendingFor("oc_b")).toBe(2);
  });
});

describe("reset 与 flush 调度", () => {
  it("reset 清空队列并释放处理标记", () => {
    const { queues, state } = manager();
    state.idle = false;
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.enqueue("oc_a", msg("m2"), "queue", false);
    queues.setProcessing("oc_a", true);

    queues.reset("oc_a");

    expect(queues.pendingFor("oc_a")).toBe(0);
    expect(queues.isProcessing("oc_a")).toBe(false);
  });

  it("chatsAwaitingFlush 只列出有待处理且空闲的 chat", () => {
    const { queues, state } = manager();
    state.idle = false;
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.enqueue("oc_b", msg("m2"), "queue", false);
    queues.setProcessing("oc_a", true);

    expect(queues.chatsAwaitingFlush()).toEqual(["oc_b"]);
  });

  it("超时释放 processing 后该 chat 重新可被 flush", () => {
    const { queues, state } = manager();
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.dequeue("oc_a");
    state.idle = false;
    queues.enqueue("oc_a", msg("m2"), "queue", false);

    expect(queues.chatsAwaitingFlush()).toEqual([]);

    // 模拟任务超时处理：放开队列
    state.idle = true;
    queues.setProcessing("oc_a", false);

    expect(queues.chatsAwaitingFlush()).toEqual(["oc_a"]);
    expect(queues.dequeue("oc_a")?.msgId).toBe("m2");
  });

  it("summary 报告队列概况", () => {
    const { queues, state } = manager();
    state.idle = false;
    queues.enqueue("oc_a", msg("m1"), "queue", false);
    queues.enqueue("oc_b", msg("m2"), "queue", false);
    queues.setProcessing("oc_a", true);

    expect(queues.summary()).toEqual({ chats: 2, pending: 2, processing: ["oc_a"] });
  });
});
