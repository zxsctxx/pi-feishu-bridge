# 从 2.x 升级到 3.0

3.0 是一次重构版本：简化降级链路、清理历史包袱、拆分内部结构。**功能没有删减**，但有三处破坏性配置变更需要处理。

## 必须修改的配置

### 1. settings.json 只接受 camelCase

2.x 每个字段都同时支持 camelCase 和 snake_case，3.0 起只保留 camelCase。

```jsonc
// ❌ 3.0 起不再识别
{
  "feishu": {
    "app_id": "cli_xxx",
    "app_secret": "xxx",
    "show_thinking": true,
    "access_policy": "allowlist",
    "allowed_open_ids": ["ou_xxx"],
    "task_timeout_sec": 900
  }
}

// ✅ 改为
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "showThinking": true,
    "accessPolicy": "allowlist",
    "allowedOpenIds": ["ou_xxx"],
    "taskTimeoutSec": 900
  }
}
```

完整字段对照见 [examples/settings.example.json](../examples/settings.example.json)。

> `showReasoning` / `show_reasoning` 这两个 `showThinking` 的旧别名同样已移除。

环境变量（`FEISHU_*`）不受影响。

### 2. `streamingTransport` 已移除

该字段连同 `im_patch` 传输方式一并删除，配置里保留它不会报错但会被忽略。删掉即可：

```jsonc
{
  "feishu": {
    "streamingTransport": "auto"  // ← 删除这一行
  }
}
```

原因见下方「降级链路简化」。

### 3. `monitoringEnabled` 已移除

该字段在 2.x 就已被解析但从未被任何代码读取，属于无效配置。删掉即可。`/feishu monitor` 始终可用。

## 行为变化

### 降级链路简化

2.x 有 5 层兜底：

```
CardKit 原生 → im_patch 整卡 PATCH → fallback 卡 → 静态尾部 → 纯文本
```

3.0 简化为 2 层：

```
CardKit 原生流式
  ↓ 失败（建卡失败 / 流式中断）
静态卡片（占位一次 + 终态一次，流式期间不更新）
  ↓ 失败
纯文本消息（必达）
```

具体差异：

| 场景 | 2.x | 3.0 |
|---|---|---|
| CardKit 不可用 | 全程 im_patch 流式卡 | 占位静态卡 → 终态静态卡（无流式过程） |
| 流式中途 300309/300313 | 整卡 PATCH 持续追更 | 停止更新，终态时 PATCH 一次成静态卡 |
| 建卡与静态卡都失败 | 静态尾部 → 纯文本 | 直接纯文本 |
| 原消息被撤回（230011） | 标记终止 | 相同 |

**内容完整性不受影响** —— 任何路径下答案都会送达。变化的是 CardKit 不可用时没有流式体感。

> 顺带修复：2.x 的 `auto` 探测因为一个判断错误（`checkCardKitAvailability` 失败时返回非空字符串，而调用方写的是 `if (!available)`）**从未生效过**。实际行为一直是「直接建卡，失败再降级」，与 3.0 的行为一致，所以这次简化在真实环境里没有回归。

### 配置边界现在真的生效

README 里标注的建议范围此前只是文档，3.0 起会实际钳制：

| 字段 | 范围 |
|---|---|
| `flushIntervalMs` | 80–2000 |
| `printFrequencyMs` | 20–1000 |
| `maxAnswerElementChars` | 1000–30000 |
| `maxReasoningChars` | 200–30000 |
| `maxToolDetailChars` / `maxToolOutputChars` | 50–10000 |
| `clarifyTimeoutSec` | 10–3600 |
| `taskTimeoutSec` | 30–86400 |
| `maxToolSteps` / `maxThinkingRounds` | 1–200 |
| `printStep` | 1–100 |

超出范围的值会被钳制到边界而非报错。非数值或 `null` 回落到默认值。

### 页脚字段校验

`footer.lines` 里无法识别的字段名此前会被静默忽略并在页脚留下空洞，现在会被过滤掉；整行都无效时该行不再渲染。合法字段：`status`、`elapsed`、`model`、`api_calls`、`tokens`、`context`、`cache`、`error`、`cost`、`stop_reason`。

### 消息投递失败现在会告知

媒体下载或消息投递失败时，2.x 会静默丢弃该消息（队列标记复位但用户毫无感知），3.0 会回复具体失败原因并释放队列。

## 新增

- `FEISHU_DEBUG=1` 开启调试日志。全项目日志统一 `[pi-feishu]` 前缀。

## 无需改动

- 所有 `FEISHU_*` 环境变量
- 所有 CLI 标志（`--feishu-app-id` 等）
- 全部飞书命令（`/new` `/resume` `/model` `/status` …）与 LLM 工具（`send_to_feishu` 等）
- 飞书应用权限与事件订阅配置

## 升级步骤

1. 按上文改 `settings.json`（camelCase、删两个废弃字段）
2. 安装 3.0
3. 飞书里发 `/feishu config` 确认配置读取正常
4. 发 `/feishu doctor` 确认 CardKit 可用
5. 随便发一条消息，确认流式卡片正常
