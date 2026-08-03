import { describe, expect, it } from "vitest";
import { ClarifyManager, type ClarifyTransport } from "./manager.js";

interface Pending {
  cardId: string;
  messageId: string;
  createCardCalls: Array<{ card: Record<string, unknown> }>;
  sendReferenceCalls: Array<{ chatId: string; cardId: string }>;
  batchUpdateCalls: Array<{ cardId: string; actions: Array<Record<string, unknown>>; sequence: number }>;
}

function makeTransport(): ClarifyTransport & { pending: Pending } {
  const pending: Pending = {
    cardId: "card-1",
    messageId: "msg-1",
    createCardCalls: [],
    sendReferenceCalls: [],
    batchUpdateCalls: [],
  };
  return {
    pending,
    async createCard(card) {
      pending.createCardCalls.push({ card });
      return pending.cardId;
    },
    async sendCardReference(chatId, cardId) {
      pending.sendReferenceCalls.push({ chatId, cardId });
      return pending.messageId;
    },
    async batchUpdate(cardId, actions, sequence) {
      pending.batchUpdateCalls.push({ cardId, actions: actions as Array<Record<string, unknown>>, sequence });
    },
  };
}

/** 等待 createCard/sendCardReference 的微任务落盘，随后 calls 可用 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function bodyElements(card: Record<string, unknown>): Array<Record<string, any>> {
  return (card.body as Record<string, any>).elements as Array<Record<string, any>>;
}

describe("ClarifyManager 卡片（schema 2.0 + 下拉框选择器）", () => {
  const options = [
    { value: "A", label: "选项A", description: "这是选项A的描述" },
    { value: "B", label: "选项B" },
  ];

  it("澄清卡片走 CardKit 链路：createCard → sendCardReference", async () => {
    const transport = makeTransport();
    const manager = new ClarifyManager(transport);
    const promise = manager.ask("chat-1", "请选择一个选项", options, [], 5000);
    await tick();
    expect(transport.pending.createCardCalls).toHaveLength(1);
    expect(transport.pending.sendReferenceCalls).toEqual([{ chatId: "chat-1", cardId: "card-1" }]);
    await manager.abort();
    await promise.catch(() => {});
  });

  it("卡片结构：标题 + A/B/C 选项列表 markdown + 底部 select_static 下拉框", async () => {
    const transport = makeTransport();
    const manager = new ClarifyManager(transport);
    const promise = manager.ask("chat-1", "请选择", options, [], 5000);
    await tick();
    const { card } = transport.pending.createCardCalls[0];
    expect(card.schema).toBe("2.0");
    const elements = bodyElements(card);
    expect(elements[0]).toMatchObject({ tag: "markdown", element_id: "question", content: "请选择", text_size: "title_2" });
    // 标题与选项之间的分隔线
    expect(elements[1]).toEqual({ tag: "hr" });
    // 选项列表：带描述的 A 行（加粗 + 描述），无描述的 B 行
    expect(elements[2]).toMatchObject({ tag: "markdown", content: "**A. 选项A** — 这是选项A的描述" });
    expect(elements[3]).toMatchObject({ tag: "markdown", content: "**B. 选项B**" });
    // 底部下拉框（选项与下拉框之间无分隔线）
    const select = elements[4];
    expect(select.tag).toBe("select_static");
    expect(select.element_id).toBe("select");
    expect(select.placeholder).toEqual({ tag: "plain_text", content: "请选择…" });
    expect(select.value).toMatchObject({ clarify_id: expect.any(String) });
    expect(select.options).toEqual([
      { value: "A", text: { tag: "plain_text", content: "A. 选项A" } },
      { value: "B", text: { tag: "plain_text", content: "B. 选项B" } },
    ]);
    await manager.abort();
    await promise.catch(() => {});
  });

  it("finish 后 batchUpdate 更新问题元素并删除下拉框", async () => {
    const transport = makeTransport();
    const manager = new ClarifyManager(transport);
    const promise = manager.ask("chat-1", "请选择", options, [], 5000);
    await tick();
    const select = bodyElements(transport.pending.createCardCalls[0].card).find((e) => e.tag === "select_static");
    const clarifyId = select.value.clarify_id as string;
    await manager.handleAction({ clarifyId, choice: "A", senderOpenId: "" });
    await promise;
    expect(transport.pending.batchUpdateCalls).toHaveLength(1);
    const { cardId, actions, sequence } = transport.pending.batchUpdateCalls[0];
    expect(cardId).toBe("card-1");
    expect(sequence).toBe(1);
    expect(actions).toEqual([
      {
        action: "partial_update_element",
        params: { element_id: "question", partial_element: { content: "✅ 已选择：**选项A**" } },
      },
      {
        action: "delete_elements",
        params: { element_ids: ["select"] },
      },
    ]);
  });

  it("发送前 signal 已 aborted：ask 拒绝、不建卡、不占用 busy", async () => {
    const transport = makeTransport();
    const manager = new ClarifyManager(transport);
    const controller = new AbortController();
    controller.abort();
    await expect(manager.ask("chat-1", "请选择", options, [], 5000, controller.signal))
      .rejects.toThrow("飞书澄清请求已取消");
    expect(manager.hasPending).toBe(false);
    expect(transport.pending.createCardCalls).toHaveLength(0);
  });

  it("发送阶段被 abort：发送完成后立即按取消收尾并释放 busy", async () => {
    const controller = new AbortController();
    const transport = makeTransport();
    const realCreate = transport.createCard;
    transport.createCard = async (card) => {
      controller.abort();
      return realCreate(card);
    };
    const manager = new ClarifyManager(transport);
    const promise = manager.ask("chat-1", "请选择", options, [], 5000, controller.signal);
    await expect(promise).rejects.toThrow("飞书澄清请求已取消");
    expect(manager.hasPending).toBe(false);
    // 卡片已发出，收尾应更新其摘要（batchUpdate 被调用一次）
    expect(transport.pending.batchUpdateCalls).toHaveLength(1);
  });
});
