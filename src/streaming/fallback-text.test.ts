import { describe, expect, it } from "vitest";
import { CardSession } from "./card-session.js";
import { buildFallbackText } from "./card-renderer.js";

const options = {
  showThinking: false,
  panelExpanded: false,
  maxToolSteps: 20,
  maxThinkingRounds: 20,
  printStrategy: "delay" as const,
  printStep: 4,
};

describe("buildFallbackText empty-answer fallback", () => {
  it("returns readable text when answer and error are empty", () => {
    const s = new CardSession("r1", "oc_x", "om_x", 200);
    s.footer.stopReason = "end_turn";
    const text = buildFallbackText(s, options);
    expect(text).toContain("未生成文本回复");
    expect(text).toContain("stop_reason=end_turn");
  });

  it("keeps real answer when present", () => {
    const s = new CardSession("r2", "oc_x", "om_x", 200);
    s.answer = "你好";
    const text = buildFallbackText(s, options);
    expect(text).toContain("你好");
    expect(text).not.toContain("未生成文本回复");
  });
});
