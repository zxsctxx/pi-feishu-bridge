# Pi-Feishu Bridge 2.0

通过飞书/Lark 官方 Bot API WebSocket 长连接，将飞书作为 Pi（`>=0.80.6 <0.82.0`）的受控聊天入口。2.0 使用 CardKit v2 原生元素流式 API，不再用整卡 PATCH 模拟流式输出。

## 主要能力

- CardKit `card.create` + `card_id` 引用消息 + `cardElement.content` 原生流式输出
- thinking 与工具调用统一时间线，工具严格按 `toolCallId` 关联
- 合法状态机、单调 sequence、幂等 UUID、串行 flush 和 `agent_settled` 唯一正常封卡
- 300305/300309/300313、429/5xx、消息撤回、静态尾部 fallback 和长回答 rollover
- 页脚展示模型、token、费用、缓存、上下文、API 调用与停止原因
- allowlist、群聊 mention、monitor、doctor、配置重载和 `ask_feishu` 澄清卡片
- 保留 WebSocket、文本/富文本/图片/文件/音频/视频收发、Reaction 与主动发送工具

## 安装

```bash
pi install ./pi-feishu-bridge-2.0.18.tgz
```

兼容范围：`@earendil-works/pi-coding-agent >=0.80.6 <0.82.0`（已覆盖 Pi 0.81.x，含当前 0.81.1）。

## 安全边界

一个 Pi 扩展实例只绑定当前一个 Pi session。多个飞书 chat 进入同一进程时会共享同一 Pi 上下文，项目不伪造多会话隔离。生产环境应让一个 Pi 进程只服务一个受信任用户或聊天边界；真正多租户应分别启动 Pi 进程。

**默认 `accessPolicy` 为 `allowlist`**（空名单 = 拒绝所有人）。`open` 仅建议本机开发，启动 / status / doctor 会显示高风险告警。

### 如何配置 allowlist 才能对话

1. 先启动 Bot，用你的账号给 Bot 发任意消息。
2. 若未授权，Bot 会回复你的 **open_id**（`ou_…`）和当前 **chat_id**（`oc_…`）。
3. 写入 `~/.pi/agent/settings.json`（或项目 `.pi/settings.json`）后 `/feishu config reload`：

```json
{
  "feishu": {
    "accessPolicy": "allowlist",
    "allowedOpenIds": ["ou_你的open_id"],
    "allowedChatIds": ["oc_你的chat_id"],
    "requireMentionInGroup": true
  }
}
```

匹配规则：

| 配置 | 效果 |
|------|------|
| 只配 `allowedOpenIds` | 该用户在任意会话可聊 |
| 只配 `allowedChatIds` | 该会话内任意用户可聊 |
| **两者都配** | 必须 **同时** 匹配（更严） |
| 都为空 | 全部拒绝 |

私聊一般只写 `allowedOpenIds` 即可；群聊建议两者都写，并开启 `requireMentionInGroup`。

未授权消息在命令路由、媒体下载、消息队列和 Pi 上下文之前被拒绝。

## 配置

配置来源优先级为 CLI、`FEISHU_*` 环境变量、项目 `.pi/settings.json`、全局 `~/.pi/agent/settings.json`。字段兼容 camelCase 与 snake_case。完整示例见 [examples/settings.example.json](examples/settings.example.json)。

关键字段：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `appId` / `appSecret` | 无 | 飞书应用凭据 |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `flushIntervalMs` | 200 | 80–2000ms 建议范围 |
| `streamingTransport` | `auto` | `auto` 探测 CardKit；`cardkit` 强制原生；`im_patch` 使用 1.x 兼容流式 |
| `showThinking` | false | 默认不展示推理正文；兼容 `show_thinking`、`showReasoning`、`show_reasoning` |
| `maxAnswerElementChars` | 30000 | 超过后创建“续”卡 |
| `maxReasoningChars` | 3500 | 单轮推理正文展示上限 |
| `maxToolDetailChars` | 500 | 工具参数/detail 展示与存储上限 |
| `maxToolOutputChars` | 800 | 工具输出展示与存储上限 |
| `printFrequencyMs` | 70 | CardKit `print_frequency_ms`（20–1000） |
| `accessPolicy` | `allowlist` | 默认白名单；开发可显式设 `open` |
| `allowedChatIds` / `allowedOpenIds` | `[]` | 见上方匹配规则 |
| `requireMentionInGroup` | false | 生产群聊建议 true |
| `clarifyTimeoutSec` | 300 | `ask_feishu` 默认等待时间 |
| `taskTimeoutSec` | 900 | 单轮 Agent 硬超时（秒），超时 abort 并终态封卡；可用 `FEISHU_TASK_TIMEOUT_SEC` |
| `sameChatBusyPolicy` | `queue` | 同 chat 忙时：`queue` 排队；`interrupt` 打断当前并只跑最新消息。环境变量 `FEISHU_SAME_CHAT_BUSY_POLICY` |
| `footer.showFooter` | true | 是否在终态卡片显示页脚 |
| `footer.lines` | 见下 | 二维数组：外层=行，内层=同行字段 |

### 页脚布局（`footer.lines`）

二维数组，无需魔法换行符：
- 外层每一项 = 一行
- 内层字段用 ` · ` 连接

可用字段：`status`、`elapsed`、`model`、`api_calls`、`tokens`、`context`、`cache`、`error`、`cost`、`stop_reason`（`duration`/`api-calls` 等别名可用）。

默认两行：

```json
{
  "feishu": {
    "footer": {
      "showFooter": true,
      "lines": [
        ["status", "elapsed", "model", "api_calls"],
        ["tokens", "context", "cache", "error"]
      ]
    }
  }
}
```

精简示例：

```json
"lines": [
  ["status", "elapsed"],
  ["tokens", "context"]
]
```

## 命令

飞书和 Pi 终端支持 `/feishu status`、`monitor`、`monitor reset`、`config`、`config reload`、`doctor`、`help`。

飞书还支持：

| 命令 | 作用 |
|------|------|
| `/new` | 真正新建 Pi 会话（清空上下文；经内部命令调用 `ctx.newSession`） |
| `/resume` | 列出/恢复历史会话（`/resume` 列表；`/resume 3` 按编号；`/resume <id前缀|名称>` 匹配；`/resume all` 全部工作目录） |
| `/name` | 查看/设置会话显示名（`/name` · `/name 任务A` · `/name clear`） |
| `/session` | 查看会话元信息（名称、ID、文件、消息数、token、费用、上下文） |
| `/reload` | 等同终端 `/reload`（热重载扩展/技能/主题等；`/feishu config reload` 仅重载飞书配置） |
| `/compact` | 压缩上下文 |
| `/model` | 查看/切换模型；列表优先显示 `settings.enabledModels`；支持 `/model cpa/grok45`、`/model cpa/grok45:high` |
| `/stop` / `/queue` / `/status` / `/help` | 中断、排队、状态、帮助 |

## LLM 工具

- `send_to_feishu`
- `send_image_to_feishu`
- `send_file_to_feishu`
- `ask_feishu`：发送选择卡，只接受访问策略授权用户的 action；支持超时、abort 和重复点击幂等处理。

## 飞书权限与事件

所需权限、事件订阅及 CardKit 开通项见 [docs/permissions.md](docs/permissions.md)。真实安装和 12 项验收步骤见 [docs/real-environment-smoke-test.md](docs/real-environment-smoke-test.md)。从早期 Pi-Feishu 渠道方案 / 1.x 升级见 [docs/migration-2.0.md](docs/migration-2.0.md)。

## 开发验证

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## 来源致谢

本项目起步于将 [Aowen-Nowor/hermes-lark-streaming](https://github.com/Aowen-Nowor/hermes-lark-streaming) 的 CardKit 流式能力，接到 [surenkid/pi-feishu](https://github.com/surenkid/pi-feishu) 一类的 Pi ↔ 飞书渠道方案上。

- **渠道与 Bot 侧**（WebSocket、消息收发、扩展入口等）：早期参考 / 演进自 [surenkid/pi-feishu](https://github.com/surenkid/pi-feishu)（以对方仓库 LICENSE 为准）。
- **CardKit 流式状态机、统一时间线、降级与元素安全网**：设计参考 Hermes Lark Streaming v1.5.0（MIT）。本项目以 TypeScript 与 Pi 公开扩展事件重新实现，未移植其 Python Monkey Patch、Gateway wrapper 或内部 session manager。

自 2.0 起实现与产品边界已大幅重写；本仓库为独立维护的 `pi-feishu-bridge`，与上述上游无自动同步关系。感谢原作者的工作。

## License

MIT
