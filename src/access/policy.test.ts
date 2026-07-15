import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_POLICY,
  evaluateAccess,
  formatAccessDeniedMessage,
  accessRiskWarning,
} from "./policy.js";
import type { InboundMessageContext } from "../types.js";

function ctx(partial: Partial<InboundMessageContext> = {}): InboundMessageContext {
  return {
    chatId: "oc_chat",
    messageId: "om_msg",
    senderOpenId: "ou_user",
    chatType: "p2p",
    mentionedBot: true,
    text: "hi",
    resources: [],
    ...partial,
  };
}

describe("DEFAULT_ACCESS_POLICY", () => {
  it("defaults to allowlist", () => {
    expect(DEFAULT_ACCESS_POLICY).toBe("allowlist");
  });
});

describe("evaluateAccess", () => {
  it("denies when allowlist is empty", () => {
    const decision = evaluateAccess(ctx(), { accessPolicy: "allowlist" });
    expect(decision).toEqual({ allowed: false, reason: "empty_allowlist" });
  });

  it("allows open policy without lists", () => {
    expect(evaluateAccess(ctx(), { accessPolicy: "open" }).allowed).toBe(true);
  });

  it("allows matching openId only", () => {
    const decision = evaluateAccess(ctx(), {
      accessPolicy: "allowlist",
      allowedOpenIds: ["ou_user"],
    });
    expect(decision.allowed).toBe(true);
  });

  it("requires both chat and user when both lists are set", () => {
    const denied = evaluateAccess(ctx(), {
      accessPolicy: "allowlist",
      allowedChatIds: ["oc_other"],
      allowedOpenIds: ["ou_user"],
    });
    expect(denied).toEqual({ allowed: false, reason: "chat_not_allowed" });

    const allowed = evaluateAccess(ctx(), {
      accessPolicy: "allowlist",
      allowedChatIds: ["oc_chat"],
      allowedOpenIds: ["ou_user"],
    });
    expect(allowed.allowed).toBe(true);
  });

  it("requires mention in group when configured", () => {
    const decision = evaluateAccess(
      ctx({ chatType: "group", mentionedBot: false }),
      { accessPolicy: "open", requireMentionInGroup: true },
    );
    expect(decision).toEqual({ allowed: false, reason: "mention_required" });
  });
});

describe("formatAccessDeniedMessage", () => {
  it("includes openId and chatId for admin setup", () => {
    const text = formatAccessDeniedMessage(ctx(), "empty_allowlist");
    expect(text).toContain("ou_user");
    expect(text).toContain("oc_chat");
    expect(text).toContain("allowlist");
  });
});

describe("accessRiskWarning", () => {
  it("warns only for open", () => {
    expect(accessRiskWarning({ accessPolicy: "open" })).toMatch(/open/);
    expect(accessRiskWarning({ accessPolicy: "allowlist" })).toBeNull();
  });
});
