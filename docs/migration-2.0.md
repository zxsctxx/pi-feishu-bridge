# 从 Pi-Feishu 1.x 升级到 2.0

> 早期渠道能力参考 / 演进自 [surenkid/pi-feishu](https://github.com/surenkid/pi-feishu)；CardKit 流式设计参考 [Aowen-Nowor/hermes-lark-streaming](https://github.com/Aowen-Nowor/hermes-lark-streaming)。2.0（`pi-feishu-bridge`）已大幅重写，与上游无自动同步。详见 README「来源致谢」。

1. 使用 Pi `>=0.80.6 <0.82.0`（已验证 0.81.1）；peer 不再排除 0.81.x。
2. 备份现有 settings，安装本地发行包 `pi-feishu-bridge-2.0.18.tgz`（版本以 `package.json` 为准）。
3. **默认已是 `accessPolicy: "allowlist"`**。必须配置 `allowedOpenIds` 和/或 `allowedChatIds`，否则所有消息被拒绝。给 Bot 发消息可收到自身 ID 提示。仅开发环境可显式设 `open`（会持续告警）。
4. `showThinking` 默认由 true 改为 false；确需展示时显式开启，并确认不会泄露敏感推理或工具内容。
5. 远程 `/new` 不再伪装成新会话。必须在 Pi TUI 执行 `/new`；`/compact` 仅压缩当前上下文。
6. 流式消息由普通 interactive 整卡 PATCH 改为 CardKit card 实例和元素级更新，需补齐 CardKit 权限。
7. 多个飞书聊天不会获得独立上下文。需要隔离时为每个边界启动独立 Pi 进程。
8. 运行 `/feishu doctor`，随后按真实环境冒烟文档验证媒体、Reaction、主动发送工具和 CardKit。
