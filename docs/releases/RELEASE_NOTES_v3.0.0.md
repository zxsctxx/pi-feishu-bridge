# Pi-Feishu Bridge 3.0.0

重构版本。功能没有删减，但配置有破坏性变更 —— 升级前请看 [migration-3.0.md](../migration-3.0.md)。

## 破坏性变更

- **settings.json 只接受 camelCase**，全部 snake_case 别名移除（`app_id`、`show_thinking`、`allowed_open_ids` 等），`showReasoning` / `show_reasoning` 一并移除。环境变量与 CLI 标志不受影响。
- **移除 `streamingTransport` 配置**，连同 `im_patch` 传输方式一并删除。
- **移除 `monitoringEnabled`** —— 该字段在 2.x 被解析但从未被读取。

## 修复

- **`auto` 探测从未生效**：`checkCardKitAvailability()` 失败时返回非空错误字符串，而调用方写的是 `if (!available)` —— 非空字符串 truthy，分支永远进不去。实际行为一直是「直接建卡，失败再降级」。
- **数值配置边界此前只存在于文档**：`flushIntervalMs`、`printFrequencyMs` 等标注的范围没有任何代码执行，现在会实际钳制。
- **`null` 配置值被当作 0**：`Number(null) === 0` 通过了有限性检查，导致钳制到 `min` 而非回落默认值。
- **消息投递失败被静默吞掉**：媒体下载或 `sendUserMessage` 失败时用户毫无感知，现在会回复失败原因并释放队列。
- **排队判断遗漏流式状态**：卡片仍在流式收尾但队列已标记空闲时，新消息会插队。

## 降级链路简化

5 层压缩为 2 层：

```
2.x: CardKit → im_patch 整卡 PATCH → fallback 卡 → 静态尾部 → 纯文本
3.0: CardKit → 静态卡片 → 纯文本
```

内容完整性不变，任何路径下答案都会送达；CardKit 不可用时不再有流式体感。

状态机随之简化：`creation_failed` 这个把「生命周期阶段」和「降级状态」混在一起的 phase 被拆成正交的 `degraded` 标志，绕过 `TRANSITIONS` 校验的 `resolveCreationFailure()` 后门得以删除。

## 结构重构

`index.ts` 从 1870 行降到 887 行，拆出：

| 模块 | 职责 |
|---|---|
| `config.ts` | 配置加载、校验、边界钳制 |
| `queue.ts` | `MessageQueueManager`，通过 `isAgentIdle` hook 与客户端解耦 |
| `commands/` | 12 个斜杠命令，表驱动路由取代 396 行 switch |
| `tools.ts` | LLM 工具注册 |
| `model-registry.ts` | `/model` 解析与列表 |
| `session/usage.ts` | token / 费用累计 |
| `log.ts` | 统一日志（`FEISHU_DEBUG=1` 开启 debug） |

同时删除死代码：`buildStreamingCard`、`buildFinalCard`、`PANEL_CONTENT_ELEMENT_ID`、`FeishuSettingsSection`，以及只写不读的 `streamingAlreadyClosed`、`rolloverCardIds`、`rolloverMessageIds`、`epoch`。

## 测试

30 → 102 个测试。新增覆盖：

- `streaming/card-manager.test.ts`（16）：正常流式、建卡失败降级、流式中断、rollover、`message_unavailable`、终态幂等
- `queue.test.ts`（19）：入队出队、`queue`/`interrupt` 双策略、跨 chat 互斥、超时释放
- `config.test.ts`（20）：边界钳制、优先级、页脚字段校验
- `commands/dispatch.test.ts`（9）：命令集合完整性、`/help` 与注册表一致性
- `session/usage.test.ts`（8）：token 累计与缓存命中率
