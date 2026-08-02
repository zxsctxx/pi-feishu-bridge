# pi-feishu-bridge

Pi coding agent 的飞书/Lark 扩展。飞书消息进来 → Pi 跑 → 输出以 CardKit v2 原生流式卡片实时刷回聊天窗。

**当前版本：** 3.0.1（master 主干）。3.0 重构已在 `refactor/3.0` 分支完成并通过 PR #1 合并进 master；3.0.1 相对 3.0.0 仅含版本号变更（`package.json` 与 `src/version.ts`），无功能差异。
**总代码量：** ~5465 行源码（33 模块） + ~1572 行测试（11 文件）。

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
| `index.ts` (~887 行) | 扩展入口：客户端启停、消息分发、Pi 事件订阅、内部命令注册 |
| `config.ts` | 配置加载/校验/边界钳制。**新增数值配置必须加进 `LIMITS` 表** |
| `queue.ts` | 每 chat 一条队列，`queue`/`interrupt` 双策略 |
| `commands/` (5 文件：`index`/`control`/`session`/`status`/`types`) | 12 个飞书斜杠命令，表驱动路由 |
| `tools.ts` | LLM 工具（`ask_feishu`/`send_to_feishu`/`send_image_to_feishu`/`send_file_to_feishu`） |
| `access/policy.ts` | **访问控制**：allowlist/open 决策、群聊 @ 校验、拒绝提示。默认 `allowlist`（空名单拒全部） |
| `streaming/card-manager.ts` (~356 行) | 流式卡片生命周期 + 降级决策 |
| `streaming/card-session.ts` (~150 行) | 状态机（phase 转移表在这里） |
| `streaming/card-renderer.ts` (~511 行) | CardKit 卡片 JSON 构建 |
| `streaming/tool-tracker.ts` | 工具调用追踪、展示与敏感字段脱敏 |
| `streaming/flush-scheduler.ts` | 流式刷新节流调度 |
| `streaming/update-queue.ts` | CardKit 更新串行队列（即「更新串行」不变量的实现） |
| `feishu-client.ts` (~861 行) | WebSocket、消息收发、媒体、去重 |
| `feishu/cardkit-client.ts` | CardKit API 调用与重试 |
| `feishu/errors.ts` | CardKit 错误分类 |
| `feishu/unavailable-guard.ts` | 已撤回消息 TTL 守卫，避免重复投递 |
| `session/meta.ts` | 会话统计与 `/session` 格式化 |
| `session/resume.ts` | 会话列表与恢复 |
| `session/usage.ts` | token / 费用累计 |
| `model-registry.ts` | `/model` 解析与列表 |
| `monitoring/` | 指标收集、doctor、配置重载 |
| `cardkit/` | Markdown 切分与元素 limits |
| `clarify/manager.ts` | `ask_feishu` 交互式澄清卡片 |
| `types.ts` | 核心类型定义（`FeishuConfig`/`InboundMessageContext`/`FooterConfig` 等），被大量模块 import |
| `log.ts` | 统一日志（`debug`/`warn`/`error`，前缀 `[pi-feishu]`） |
| `version.ts` | 版本常量（`PRODUCT_NAME`/`PRODUCT_VERSION`/`PRODUCT_ID`） |

## 改动风险区

**`streaming/card-manager.ts`** —— 状态机与降级。改之前先确认 `card-manager.test.ts` 是绿的，改完必须仍然绿。这些测试锁的是行为契约（内容必达、终态正确、sequence 单调），不是实现细节。

**`queue.ts`** —— 竞态敏感。「chat 是否忙」要同时看 `processing` 和该 chat 有无活跃流式卡片，只看其一会让消息插队（3.0 修过一次）。

**新增斜杠命令** —— 在 `commands/` 加 handler 并注册进 `commands/index.ts` 的 `HANDLERS`，同时更新 `status.ts` 里 `helpCommand` 的列表。`dispatch.test.ts` 会校验两者一致。

**`access/policy.ts`** —— 访问控制是安全门。改 `evaluateAccess()`/默认策略前，确认 `access/policy.test.ts` 仍绿，且与 `doctor`/`status` 的 import 保持同步。默认 `allowlist` 空名单拒绝所有人，勿放开成 `open` 当默认。

## 约定

- 日志统一走 `src/log.ts`（`warn`/`debug`/`error`），前缀 `[pi-feishu]`，`FEISHU_DEBUG=1` 开 debug
- 配置只认 camelCase（3.0 起不再兼容 snake_case）
- 注释用中文，与既有风格一致
- 测试用 vitest + 手写 fixture，不引 mock 框架；`CardKitOperations` 和 `StaticFallback` 都是接口，直接注入假实现

## 部署

Pi 不支持 `.tgz` 安装，只装目录或 git 源：

```bash
# 装本地目录
pi install ./path/to/pi-feishu-bridge

# 或从 GitHub 装（master 即 3.0 主干）
pi install https://github.com/zxsctxx/pi-feishu-bridge
pi install git:github.com/zxsctxx/pi-feishu-bridge@master
# 注意：pi 的 git ref 分隔符是 `@`（如 @master），不是 `#`；`#master` 会被拼进 clone URL 导致安装失败
```

安装后重启 Pi。`/feishu status` 确认版本。settings.json 中的 `feishu` 配置段不会被 `uninstall` 影响，但建议先备份。

## 已有知识

### 飞书富文本（post）解析

`feishu-client.ts` 的 `parsePostContent()` 负责解析飞书富文本消息。`content` 是二维数组（外层行、内层行内片段），**行之间必须补换行**，否则多行内容（如有序列表）会被压成一行。16 个测试覆盖有序列表、多行段落、链接/ @ 提及/图片、locale 回退、畸形数据。

### 长内容截断与标注

工具 detail / output 与推理正文按配置上限截断，截断后追加 `…（已截断，共 N 字）`（N = 传入渲染层的实际长度）。改动点在 `streaming/card-renderer.ts` 的 `truncate()`（第三参数 `annotate`，默认 `false`）：

- **工具 detail / output**：存储层 `tool-tracker.ts` 的 `clip()` 在 `record` 时已按 500/800 截成一行（`formatToolDetail`/`formatToolOutput`），渲染层 `truncate` 是兑底二次截断，N 为裁剪后长度、流式期间固定。
- **推理 thinking**：`card-session.ts` 存**全文原文**（`thinkingRounds`/`currentThinking` 不截断），渲染时 `truncate` 才裁，N 为真实原文字数，**流式期间随每次 flush 实时增长**；`maxThinkingRounds`/`maxToolSteps` 超限则折叠早期轮次/步骤（提示一行，不丢新内容）。
- **答案正文**：不走截断，`card-manager.ts` 的 `flushAnswer()` 超 `maxAnswerElementChars` 时滚动分卡（`splitMarkdown` 拆卡 + 关流式 + 新建卡）。
- 截断仅展示层：thinking 原文始终存全文，改配置可恢复完整展示。

相关 LIMITS：`maxReasoningChars`（默认 3500，上限 30000）、`maxToolDetailChars`（500/10000）、`maxToolOutputChars`（800/10000）——钳制表硬上限，无法彻底关闭截断。`card-renderer.test.ts` 覆盖三类截断标注与未超限不标注。

### 3.0 重构记录

2026-07-26 完成 3.0 重构（`refactor/3.0` 分支，后以 PR #1 合并进 master），7 个 commit + 基线测试。核心变更：

- **降级链路 5 层 → 2 层**：删除 `im_patch` 传输（`legacyModeReason`、`enterImPatchFallback`、`patchCompatibilityCard`、`sendMissingTail` 全删）。`creation_failed` phase 拆成正交的 `degraded` 标志，`resolveCreationFailure()` 后门删除。
- **清理嫁接痕迹**：删除全部 snake_case 配置别名、死代码（`buildStreamingCard`/`buildFinalCard`/`PANEL_CONTENT_ELEMENT_ID` 等）、`monitoringEnabled`、`FeishuSettingsSection`。统一日志到 `src/log.ts`。
- **拆分 `index.ts`**：1870 → 887 行。拆出 `config.ts`、`queue.ts`、`commands/`、`tools.ts`、`model-registry.ts`、`session/usage.ts`。
- **边界钳制**：`LIMITS` 表统一管理所有数值配置的范围，`null` 配置值不再被误当作 0（`Number(null) === 0` 的 bug）。
- **测试 30 → 118**，新增 `card-manager.test.ts`（16）、`queue.test.ts`（19）、`config.test.ts`（20）、`dispatch.test.ts`（9）、`usage.test.ts`（8）。

修复的 5 个 bug 详见 `docs/releases/RELEASE_NOTES_v3.0.0.md`。

## 上游致谢

项目起步自 `surenkid/pi-feishu`（渠道侧）与 `hermes-lark-streaming`（CardKit 流式设计），均为 MIT。README 的致谢段**不要删** —— 保留署名既诚实也最安全。代码注释里不必再提上游项目名。
