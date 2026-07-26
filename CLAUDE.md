# pi-feishu-bridge

Pi coding agent 的飞书/Lark 扩展。飞书消息进来 → Pi 跑 → 输出以 CardKit v2 原生流式卡片实时刷回聊天窗。

## 命令

```bash
npm ci
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm pack --dry-run   # 确认 files 字段与目录结构一致
```

真机验收步骤见 `docs/real-environment-smoke-test.md`。

## 架构约束（改代码前必读）

**一个扩展实例只绑一个 Pi session。** 同时只能有一个 chat 处于 processing，跨 chat 消息互相排队。不要试图伪造多会话隔离 —— 真多租户应分别起 Pi 进程。

**`globalThis` 跨实例传状态是必要的，不是偷懒。** `/new` `/reload` `/resume` 会拆掉当前扩展实例，回执和待恢复路径只能靠 `globalThis` 投递给新实例（`index.ts` 的 `PENDING_NOTIFY_KEY` / `PENDING_RESUME_PATH_KEY`）。resume 路径走 `globalThis` 还为了避开 Windows 路径空格被斜杠参数拆开。

**`installInternalCommandPromptPatch()` 是脆弱的 monkey patch。** `pi.sendUserMessage` 硬编码 `expandPromptTemplates:false`，拿不到 `ExtensionCommandContext`（`newSession`/`reload` 只在该上下文可用），只能 patch `AgentSession.prototype`。**升级 Pi 版本后要重点验证这里。**

## 不可破的不变量

- **答案必达** —— 任何降级路径下用户都必须收到内容。`card-manager` 的 `finalize()` 是唯一出口，改它务必跑 `card-manager.test.ts`。
- **`agent_settled` 是唯一的正常封卡点** —— 别在别处调 `settle()`。
- **CardKit sequence 单调递增** —— 走 `session.nextSequence()`，不要自己维护计数。
- **CardKit 更新串行** —— 经 `session.updates.enqueue()`，并发 PATCH 会乱序。

## 降级链路（3.0 起两层）

```
CardKit 原生流式
  ↓ 失败（建卡失败 / 流式中断）
静态卡片（占位一次 + 终态 PATCH 一次，流式期间不更新）
  ↓ 失败
纯文本消息
```

`degraded` 标志与 `phase` **正交** —— 降级不改变会话生命周期阶段。3.0 之前这两个概念混在 `creation_failed` 这个 phase 里，导致需要 `resolveCreationFailure()` 绕过状态机校验；不要退回那种设计。

CardKit 错误码：`300305` 元素超限（裁剪面板重试）· `300309` 流式已关闭 · `300313` 元素不可用 · `230011`/`231003` 原消息已撤回（立即终止，不再投递）· `11310` card_id 无效（重试后重建一次）。

## 模块地图

| 路径 | 职责 |
|---|---|
| `index.ts` | 扩展入口：客户端启停、消息分发、Pi 事件订阅、内部命令注册 |
| `config.ts` | 配置加载/校验/边界钳制。**新增数值配置必须加进 `LIMITS` 表** |
| `queue.ts` | 每 chat 一条队列，`queue`/`interrupt` 双策略 |
| `commands/` | 12 个飞书斜杠命令，表驱动路由 |
| `tools.ts` | LLM 工具（`send_to_feishu` 等） |
| `streaming/card-manager.ts` | 流式卡片生命周期 + 降级决策 |
| `streaming/card-session.ts` | 状态机（phase 转移表在这里） |
| `feishu-client.ts` | WebSocket、消息收发、媒体、去重 |

## 改动风险区

**`streaming/card-manager.ts`** —— 状态机与降级。改之前先确认 `card-manager.test.ts` 是绿的，改完必须仍然绿。这些测试锁的是行为契约（内容必达、终态正确、sequence 单调），不是实现细节。

**`queue.ts`** —— 竞态敏感。「chat 是否忙」要同时看 `processing` 和该 chat 有无活跃流式卡片，只看其一会让消息插队（3.0 修过一次）。

**新增斜杠命令** —— 在 `commands/` 加 handler 并注册进 `commands/index.ts` 的 `HANDLERS`，同时更新 `status.ts` 里 `helpCommand` 的列表。`dispatch.test.ts` 会校验两者一致。

## 约定

- 日志统一走 `src/log.ts`（`warn`/`debug`/`error`），前缀 `[pi-feishu]`，`FEISHU_DEBUG=1` 开 debug
- 配置只认 camelCase（3.0 起不再兼容 snake_case）
- 注释用中文，与既有风格一致
- 测试用 vitest + 手写 fixture，不引 mock 框架；`CardKitOperations` 和 `StaticFallback` 都是接口，直接注入假实现

## 上游致谢

项目起步自 `surenkid/pi-feishu`（渠道侧）与 `hermes-lark-streaming`（CardKit 流式设计），均为 MIT。README 的致谢段**不要删** —— 保留署名既诚实也最安全。代码注释里不必再提上游项目名。
