# 飞书应用权限与事件清单

在飞书/Lark 开放平台为测试应用开启机器人能力、CardKit，并按实际租户审批以下能力：

流式链路的最小权限建议明确确认：

- `cardkit:card:write`：创建 CardKit 实例、`cardElement.content`、`batch_update`、关闭 streaming mode
- `im:message:send_as_bot`：机器人发送/回复引用卡片消息
- `im:message`：消息基础读写能力

- 接收消息事件与读取消息基本信息
- 发送、回复和更新消息
- 下载消息中的图片、文件、音频和视频资源
- 上传并发送图片和文件
- 创建/删除消息 Reaction
- 创建 CardKit 卡片实例
- 更新 CardKit 元素、批量更新卡片与更新卡片 settings

`cardkit:card:read` 不是创建流式卡片的核心权限，但建议一并开通；`im:message:update` 用于普通交互卡兼容降级。应用权限变更后必须重新发布应用版本并重新授权测试租户，旧 token 不会自动获得新 scope。

事件订阅：

- `im.message.receive_v1`
- `card.action.trigger`（用于 `ask_feishu`）

可选保留 SDK 长连接所需的 read/reaction/chat bot 事件。使用 WebSocket 长连接时不需要公网 webhook，但事件订阅、应用版本发布和租户授权仍必须完成。

凭据不得提交到仓库。测试前用 `/feishu doctor` 检查缺失凭据、open 访问模式和未连接状态。
