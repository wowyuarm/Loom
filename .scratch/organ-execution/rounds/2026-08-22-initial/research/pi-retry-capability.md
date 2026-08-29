# pi 重试与超时能力调研

版本基线：`@earendil-works/pi-ai` / `pi-agent-core` / `pi-coding-agent` 0.84.2。

> **勘误（同日补充）**：本文件初稿断言“Loom 对 pi 调用零重试、零超时”。后续核查发现该结论**错误**：AgentSession 的 turn 级自动重试与流空闲超时均默认开启且已在 Loom 生效。详见下文“实际接线现状”。

## 结论速览

| 能力 | 状态 | 说明 |
|---|---|---|
| turn 级自动重试 | **已默认启用** | `settings.retry?.enabled ?? true`，maxRetries=3，baseDelayMs=2000 指数退避 |
| 流空闲超时 | **已默认启用** | `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`，流静默 5 分钟被掐断 |
| provider 层 timeout/retry 透传 | 已接线 | sdk.js streamFn 将 provider 设置透传给 modelRuntime.streamSimple |
| 错误分类器 | 覆盖两种生产错误 | `"ended without"` 可重试；`GoUsageLimitError`/quota 不可重试快速失败 |
| **重试可观测性** | **缺失** | `auto_retry_start/end` 未接入 Loom 结构化日志，外部只能凭运行时长推断 |

## 实际接线现状（核查于 2026-08-22 下午）

### turn 级自动重试（pi-coding-agent core/agent-session.js）

- `_willRetryAfterAgentEnd()` / `_handlePostAgentRun()`：agent 结束后检查最后 assistant 消息，`_isRetryableError()` 命中则 `_prepareRetry()` 续跑。
- `SettingsManager.getRetryEnabled()` 默认 `true`；`getRetrySettings()` 默认 `{maxRetries: 3, baseDelayMs: 2000}`。
- Loom 七处 `createAgentSession` 均使用 pi 正牌 `SettingsManager.create(...)`，未覆写关闭。
- context overflow 不走此路径（由 compaction 处理）；abort 永不重试。

### 流级超时（core/sdk.js streamFn + http-dispatcher.js）

```text
timeoutMs = options.timeoutMs ?? providerRetry.timeoutMs ?? httpIdleTimeoutMs(默认 300_000)
```

流静默 5 分钟即失败；provider 层 `maxRetries`/`maxRetryDelayMs` 同步透传给底层 SDK。

### 分类器（pi-ai utils/retry.js）

- RETRYABLE：`429/5xx`、`overloaded`、`connection.*`、`timed? out`、**`ended without`**（注释点名 "stream ended without ..." 场景）、`stream ended before message_stop` 等。
- NON-RETRYABLE（快速失败）：**`GoUsageLimitError`**、`FreeUsageLimitError`、`Monthly usage limit reached`、`insufficient_quota`、billing 类——注释明确写着 OpenCode Zen 订阅限额不是瞬时节流。

### 与 08-22 生产现象互证

- thread-maintainer 单次 run 10m34s 后失败 = 会话内多轮重试全部撞进同一上游故障窗口后上抛；
- memory-reflector 约 5 分钟失败 = 一次撞满 300s 流空闲上限；
- 之后 organ ledger 的 1min/5min 退避接管并最终全部自愈——**两层重试按设计协作，无需新增机制**。

## pi-ai 直接 API（retryAssistantCall / RetryPolicy）

供 SDK/脚本调用者直接使用；AgentSession 内部的 turn 重试与之共用同一分类器。Loom 无需绕过 AgentSession 另行包装。
