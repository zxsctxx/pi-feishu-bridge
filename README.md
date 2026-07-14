# Pi-Feishu Bridge 2.0

通过飞书/Lark 官方 Bot API WebSocket 长连接，将飞书作为 Pi v0.80.6 的受控聊天入口。2.0 使用 CardKit v2 原生元素流式 API，不再用整卡 PATCH 模拟流式输出。

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
pi install ./pi-feishu-bridge-2.0.12.tgz
```

兼容范围固定为 `@earendil-works/pi-coding-agent >=0.80.6 <0.81.0`，不会自动匹配 Pi 0.81+。

## 安全边界

一个 Pi 扩展实例只绑定当前一个 Pi session。多个飞书 chat 进入同一进程时会共享同一 Pi 上下文，项目不伪造多会话隔离。生产环境应让一个 Pi 进程只服务一个受信任用户或聊天边界；真正多租户应分别启动 Pi 进程。

`accessPolicy: "open"` 只用于兼容和开发，启动、status、doctor 都会显示高风险告警。生产建议：

```json
{
  "feishu": {
    "accessPolicy": "allowlist",
    "allowedChatIds": ["oc_xxx"],
    "allowedOpenIds": ["ou_xxx"],
    "requireMentionInGroup": true
  }
}
```

未授权消息在命令路由、媒体下载、消息队列和 Pi 上下文之前被拒绝，响应不包含模型、App ID 或运行状态。

## 配置

配置来源优先级为 CLI、`FEISHU_*` 环境变量、项目 `.pi/settings.json`、全局 `~/.pi/agent/settings.json`。字段兼容 camelCase 与 snake_case。完整示例见 [examples/settings.json](examples/settings.json)。

关键字段：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `appId` / `appSecret` | 无 | 飞书应用凭据 |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `flushIntervalMs` | 200 | 80–2000ms 建议范围 |
| `streamingTransport` | `auto` | `auto` 探测 CardKit；`cardkit` 强制原生；`im_patch` 使用 1.x 兼容流式 |
| `showThinking` | false | 默认不展示推理正文；兼容 `show_thinking`、`showReasoning`、`show_reasoning` |
| `maxAnswerElementChars` | 30000 | 超过后创建“续”卡 |
| `accessPolicy` | `open` | 生产使用 `allowlist` |
| `allowedChatIds` / `allowedOpenIds` | `[]` | 两者均配置时必须同时匹配 |
| `requireMentionInGroup` | false | 生产群聊建议 true |
| `clarifyTimeoutSec` | 300 | `ask_feishu` 默认等待时间 |

## 命令

飞书和 Pi 终端支持 `/feishu status`、`monitor`、`monitor reset`、`config`、`config reload`、`doctor`、`help`；飞书还支持 `/stop`、`/queue`、`/compact` 以及旧 `/status`、`/help` 别名。

远程 `/new` 不会执行 abort/compact，也不会调用 Pi 私有 API。它只提示用户在 Pi TUI 中执行真正的 `/new`。

## LLM 工具

- `send_to_feishu`
- `send_image_to_feishu`
- `send_file_to_feishu`
- `ask_feishu`：发送选择卡，只接受访问策略授权用户的 action；支持超时、abort 和重复点击幂等处理。

## 飞书权限与事件

所需权限、事件订阅及 CardKit 开通项见 [docs/permissions.md](docs/permissions.md)。真实安装和 12 项验收步骤见 [docs/real-environment-smoke-test.md](docs/real-environment-smoke-test.md)。从 1.x 升级见 [docs/migration-2.0.md](docs/migration-2.0.md)。

## 开发验证

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## 来源致谢

CardKit 流式状态机、统一时间线、降级与元素安全网的设计参考 Hermes Lark Streaming v1.5.0（MIT）。本项目以 TypeScript 和 Pi 公开扩展事件重新实现，未移植 Python Monkey Patch、Gateway wrapper 或内部 session manager。

## License

MIT
