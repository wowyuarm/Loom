# effect-delivery（出站 Effect/Delivery 账本）

**Status:** v1 已实现并通过测试（`src/runtime-state/`、`src/channels/`；`tests/runtime-state.spec.ts`、`tests/channels.spec.ts`）。

**last-checked:** 2026-09-25

## 它是什么

出站方向的运行时账本：agent 对外做的动作先在 ② 落一条 Effect（durable），再尝试 Delivery，
结果回填状态。补上 [FRAMEWORK §6](../../../active/loom-architecture/FRAMEWORK.md) 一直推后的「完整 Effect/Delivery
三态」——把入站已有的「接受屏障」对称地做到出站。

对应 [FRAMEWORK §5](../../../active/loom-architecture/FRAMEWORK.md) 的 channels（①）出站行 + runtime-state（②）
里 Effect/Delivery 那一格。设计快照见 [DESIGN.md](DESIGN.md)。

## 当前 frontier

- 01 — message effect 账本 + 崩溃恢复提示：complete（见 issues/01）。
- 02 — effect 表增长与每-turn 全表扫：ready（见 issues/02，非阻塞的性能/存储后续）。

## 完成条件

- `message` 工具发送前落 pending Effect（durable），发送后回填 delivered/unknown。
- 崩溃/发送失败留下的未确认 Effect 在醒来上下文里被点名，且不自动重发。
- Delivery 状态更新走一次 event（`loom/delivery`），给未来 followup / 投影留接缝。
- 跨重启：未确认 Effect 仍查得到，被后续同 route 成功投递自然覆盖。

## 不做（明确切片外，避免重蹈 legacy 过度工程）

- 自动重试调度器（nextRunAt / attempt_count / transient 状态机）。
- blocked-runtime 状态机（legacy 的 reconciliation_required 卡死整个 runtime）。
- 多次 delivery_attempts 历史表；一条 Effect 行带最新状态即可。
- route/destination 不透明间接层；Effect 直接存 channel+route。
- 第二种 Effect kind（外部订阅等）；表留 `kind` 字段，加 kind 时再机械扩展。
