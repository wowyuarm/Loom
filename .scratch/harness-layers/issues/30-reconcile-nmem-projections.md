# 30 - Reconcile nmem Projections from Runtime Evidence

Status: resolved
Type: implementation

## Problem

Loom 已有两个完整、可恢复的 nmem projection Interface：Frozen Activity -> nmem Conversation Thread，以及 durable Life Recorder Receipt -> nmem Episode Memory。但它们仍只能由外部调用方手工运行，`openLoomInstance` 只装配了 `nmem_recall`。

本票把这两个现有消费者接入 `LoomInstance.runOnce`。它不改变投影内容、nmem wire protocol、Cognitive Organ prompt 或 Runtime Store，也不建立通用 Integration scheduler。

## Confirmed Interface

- 只有配置了 nmem endpoint 的 Runtime Instance 才装配 projection reconcilers；未配置时不建立伪 blocked 状态或做外部工作。
- 每次 `LoomInstance.runOnce` 先推进本地 Runtime / Cognitive Organ 生命周期，再顺序 reconcile Conversation Threads 与 Episodes。
- Conversation Thread 由已冻结 Activity 授权，不等待 Life Recorder；Episode 只由 durable Life Recorder Receipt 授权。两者既有 hash、连接 fingerprint、幂等、backoff 和恢复规则不变。
- nmem 外部失败不改变 Input、Turn、Activity、Recorder、Thread maintenance 或本次 `runOnce` 的本地结果，也不阻断下一段活动。
- 失败不能静默：每个 reconciler 暴露其持久 aggregate status，包括 current / pending / blocked 数量，以及各 item 的 attempt、next attempt 和错误。
- `LoomInstance.status()` 可选暴露 nmem projection 状态；Instance close 同时关闭两个 reconciler。
- 不为 nmem 增加固定 cadence。process driver 未来按 `runOnce` 的现有 wake / nextRunAt 语义驱动即可，reconciler 自己根据持久 backoff 决定是否请求外部服务。

## Test Seam

测试只穿过公开 nmem reconciler 与 `LoomInstance.runOnce/status`：

- 一份已关闭 Activity 投影一个 Conversation Thread；Recorder Episode 投影一个 Memory；重复 `runOnce` 不重复请求。
- temporary / authentication / incompatible 状态可在 Instance status 中观察，本地 Runtime 结果不变。
- restart 后沿用既有 Integration state 和 backoff；到期后继续重试。
- 未配置 nmem 时不出现 projection 状态。

## Out of Scope

- nmem nightly、Working Memory refresh cadence 或 Memory Reflector 调度。
- logical-day close marker。
- Thread search、自动 recall 或 prompt 注入。
- 通用 Integration job runner、daemon 或 process driver。
- 修改 Episode / Conversation Thread projection 语义。

## Source References

- Loom Tickets 19, 20, 21, 27 and 29
- Xi `src/memory/nmem/thread-import.ts`
- Xi `src/runtime/daemon.ts`

## Result

- 配置 nmem endpoint 的 `openLoomInstance` 现在装配现有 Conversation Thread 与 Episode reconcilers；未配置时不创建 projection 状态，也不做外部请求。
- 每次 `LoomInstance.runOnce` 完成本地 Scheduler 推进后，先 reconcile 已冻结 Activity，再 reconcile durable Recorder Receipt 中的 Episode。现有投影内容、授权边界、hash、连接 fingerprint、幂等与 backoff 均未改变。
- nmem temporary、authentication 或 incompatible 失败仍由 Integration 自己持久化；它们不改变本地 `runOnce` 结果，不回滚 Activity，也不阻断后续本地工作。
- 两个 reconciler 增加同一小型只读 `status()` Interface，按当前连接展示 current / pending / blocked 汇总，以及 item 的 attempts、nextAttemptAt 和 lastError；不暴露 endpoint、API key 或连接 fingerprint。
- `LoomInstance.status().nmem` 聚合两类 projection 状态，`close()` 一并关闭 Integration Store。restart 后沿用既有 backoff，到期再请求；成功后清除错误且不重复投影。
- 本票没有修改 prompt、tool description、首轮 Context、Runtime Store、nmem wire protocol 或模型可见材料，也没有增加固定 cadence、day-close marker 或通用 Integration job runner。

## Verification

- `npm run typecheck`
- `npm test` - 177 tests passed
- `git diff --check`
