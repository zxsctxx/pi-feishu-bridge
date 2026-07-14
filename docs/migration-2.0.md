# 从 Pi-Feishu 1.x 升级到 2.0

1. 使用 Pi v0.80.6；2.0 的 peer dependency 明确排除 0.81+。
2. 备份现有 settings，安装本地发行包 `pi-feishu-bridge-2.0.12.tgz`。
3. 增加 `accessPolicy: "allowlist"` 和允许的 chat/open_id。留在 open 模式会持续显示风险警告。
4. `showThinking` 默认由 true 改为 false；确需展示时显式开启，并确认不会泄露敏感推理或工具内容。
5. 远程 `/new` 不再伪装成新会话。必须在 Pi TUI 执行 `/new`；`/compact` 仅压缩当前上下文。
6. 流式消息由普通 interactive 整卡 PATCH 改为 CardKit card 实例和元素级更新，需补齐 CardKit 权限。
7. 多个飞书聊天不会获得独立上下文。需要隔离时为每个边界启动独立 Pi 进程。
8. 运行 `/feishu doctor`，随后按真实环境冒烟文档验证媒体、Reaction、主动发送工具和 CardKit。
