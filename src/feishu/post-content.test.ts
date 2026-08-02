import { describe, expect, it } from "vitest";
import { parsePostContent } from "../feishu-client.js";
import type { InboundResource } from "../types.js";

/** 构造飞书 post 消息的 content 结构 */
function post(content: unknown[][], title?: string) {
  return { zh_cn: { ...(title ? { title } : {}), content } };
}

function parse(parsed: unknown) {
  const resources: InboundResource[] = [];
  const text = parsePostContent(parsed, resources);
  return { text, resources };
}

describe("行与行之间保留换行", () => {
  it("有序列表不被压成一行", () => {
    const { text } = parse(
      post([
        [{ tag: "text", text: "1. 第一项" }],
        [{ tag: "text", text: "2. 第二项" }],
        [{ tag: "text", text: "3. 第三项" }],
      ]),
    );
    expect(text).toBe("1. 第一项\n2. 第二项\n3. 第三项");
  });

  it("同一行内的多个片段直接相接", () => {
    const { text } = parse(
      post([[{ tag: "text", text: "前半" }, { tag: "text", text: "后半" }]]),
    );
    expect(text).toBe("前半后半");
  });

  it("多行段落保留结构", () => {
    const { text } = parse(
      post([
        [{ tag: "text", text: "第一段" }],
        [{ tag: "text", text: "" }],
        [{ tag: "text", text: "第二段" }],
      ]),
    );
    expect(text).toBe("第一段\n\n第二段");
  });

  it("标题作为首行", () => {
    const { text } = parse(post([[{ tag: "text", text: "正文" }]], "标题"));
    expect(text).toBe("标题\n正文");
  });
});

describe("片段类型", () => {
  it("链接保留 URL", () => {
    const { text } = parse(
      post([[{ tag: "a", text: "点这里", href: "https://example.com" }]]),
    );
    expect(text).toBe("[点这里](https://example.com)");
  });

  it("无锚文本的链接直接用 URL", () => {
    const { text } = parse(post([[{ tag: "a", href: "https://example.com" }]]));
    expect(text).toBe("https://example.com");
  });

  it("@提及优先用显示名", () => {
    const { text } = parse(
      post([[{ tag: "at", user_id: "ou_abc", user_name: "张三" }]]),
    );
    expect(text).toBe("@张三");
  });

  it("无显示名时回退 user_id", () => {
    const { text } = parse(post([[{ tag: "at", user_id: "ou_abc" }]]));
    expect(text).toBe("@ou_abc");
  });

  it("md 片段按原文保留", () => {
    const { text } = parse(post([[{ tag: "md", text: "**加粗**" }]]));
    expect(text).toBe("**加粗**");
  });

  it("图片记入 resources 并留占位符", () => {
    const { text, resources } = parse(
      post([[{ tag: "img", image_key: "img_key_1" }]]),
    );
    expect(text).toBe("[图片]");
    expect(resources).toEqual([{ type: "image", fileKey: "img_key_1" }]);
  });

  it("混合片段按顺序拼接", () => {
    const { text, resources } = parse(
      post([
        [{ tag: "text", text: "看这个 " }, { tag: "a", text: "链接", href: "https://x.com" }],
        [{ tag: "img", image_key: "k1" }, { tag: "text", text: " 说明" }],
      ]),
    );
    expect(text).toBe("看这个 [链接](https://x.com)\n[图片] 说明");
    expect(resources).toHaveLength(1);
  });

  it("行内代码片段保留内容", () => {
    const { text } = parse(post([[{ tag: "code", text: "console.log(1)" }]]));
    expect(text).toBe("console.log(1)");
  });

  it("代码与文本混合按顺序拼接", () => {
    const { text } = parse(
      post([
        [
          { tag: "text", text: "运行 " },
          { tag: "code", text: "npm ci" },
          { tag: "text", text: " 安装依赖" },
        ],
      ]),
    );
    expect(text).toBe("运行 npm ci 安装依赖");
  });

  it("代码块保留语言与内容", () => {
    const { text } = parse(
      post([
        [{ tag: "text", text: "示例：" }],
        [{ tag: "code_block", language: "ts", text: "const a = 1;" }],
      ]),
    );
    expect(text).toBe("示例：\n```ts\nconst a = 1;\n```");
  });

  it("媒体占位并记入 resources", () => {
    const { text, resources } = parse(
      post([[{ tag: "media", file_key: "file_key_1" }]]),
    );
    expect(text).toBe("[媒体]");
    expect(resources).toEqual([{ type: "file", fileKey: "file_key_1" }]);
  });

  it("表情保留占位", () => {
    const { text } = parse(post([[{ tag: "emotion", emoji_type: "SMILE" }]]));
    expect(text).toBe("[表情]");
  });

  it("hr 分割线保留为分隔", () => {
    const { text } = parse(
      post([
        [{ tag: "text", text: "上文" }],
        [{ tag: "hr" }],
        [{ tag: "text", text: "下文" }],
      ]),
    );
    expect(text).toBe("上文\n---\n下文");
  });

  it("未知 tag 兜底保留文本", () => {
    const { text } = parse(
      post([[{ tag: "text", text: "保留" }, { tag: "未知类型", text: "也保留" }]]),
    );
    expect(text).toBe("保留也保留");
  });
});

describe("locale 回退与边界", () => {
  it("无 zh_cn 时回退 en_us", () => {
    const text = parsePostContent(
      { en_us: { content: [[{ tag: "text", text: "hello" }]] } },
      [],
    );
    expect(text).toBe("hello");
  });

  it("新版无 locale 结构的 post（有序列表真实结构）", () => {
    // 飞书新版富文本编辑器（Ctrl+Shift+7 有序列表）发送的结构：顶层直接 {title, content, content_v2}，无 zh_cn/en_us 包装
    const { text } = parse({
      title: "",
      content: [[
        { tag: "text", text: "1. ", style: [] },
        { tag: "text", text: "测试", style: [] },
      ]],
      content_v2: [[
        { tag: "text", text: "1. ", style: [] },
        { tag: "text", text: "测试", style: [] },
      ]],
    });
    expect(text).toBe("1. 测试");
  });

  it("新版结构多行有序列表保留换行", () => {
    const { text } = parse({
      content: [[
        { tag: "text", text: "1. 第一项" },
      ], [
        { tag: "text", text: "2. 第二项" },
      ]],
    });
    expect(text).toBe("1. 第一项\n2. 第二项");
  });

  it("content 为空时回退到 content_v2", () => {
    const { text } = parse({
      content: [],
      content_v2: [[{ tag: "text", text: "v2 内容" }]],
    });
    expect(text).toBe("v2 内容");
  });

  it("空内容返回空串", () => {
    expect(parsePostContent(post([]), [])).toBe("");
    expect(parsePostContent({}, [])).toBe("");
    expect(parsePostContent(null, [])).toBe("");
  });

  it("首尾空行被去掉但中间保留", () => {
    const { text } = parse(
      post([
        [{ tag: "text", text: "" }],
        [{ tag: "text", text: "中间" }],
        [{ tag: "text", text: "" }],
      ]),
    );
    expect(text).toBe("中间");
  });

  it("非数组 row 被跳过而不崩溃", () => {
    const { text } = parse({
      zh_cn: { content: [[{ tag: "text", text: "正常" }], "不是数组"] },
    });
    expect(text).toBe("正常");
  });
});
