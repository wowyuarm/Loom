# 35 - Schedule After-chat Continuation from Delivered Effects

Status: resolved
Type: implementation

## Problem

Loom can durably deliver outbound Effects and keep an Active Segment open across several Turns, but a confirmed outbound currently has no later opportunity to continue naturally after the immediate exchange has settled. The continuation must reuse the existing activity and Context without turning every message into a compulsory follow-up or creating a general job system.

## Confirmed Semantics

- Every confirmed outbound Delivery may schedule one continuation, whether the source Turn began from human interaction or proactive activity.
- A later confirmed Delivery replaces the pending continuation, so the delay is measured from the latest message that was actually delivered.
- A Delivery from a continuation Turn does not schedule another continuation. Unknown and `not_sent` Delivery results never schedule one.
- The continuation becomes due five minutes after confirmed Delivery and expires twenty minutes after it. These are Harness policies, not Instance Configuration in this phase.
- Accepting a new human Input atomically cancels a pending continuation. Duplicate ingress does not cancel it again.
- A pending continuation keeps its source Active Segment open. When admitted, it reuses that Segment, its Context Window, and the interaction/background Behavior selected by the source Turn.
- `message.no_reply` in a continuation is quiet: its Input inclusion and Turn completion do not advance Activity time. Successful ordinary Workspace/tool activity or a new outbound Effect remains real activity and advances it normally.
- Model blockage leaves a due continuation recoverable until expiry. Restart reconstructs the same pending state from Runtime Store.

## Model-visible Context

The existing Main Agent assembly remains authoritative. A continuation sees, in order:

```text
System
  Harness System Guidance
  Identity
  source Turn Behavior
  Long-term Memory

Context
  Current Attention
  Daily / Recent Activity Bridge
  committed trace in the current Active Segment
  after-chat continuation Input
```

The final Input is:

```text
<after_chat_continuation>
Observed at: ...
A message from the current activity was confirmed delivered ... ago.
No new human Input has been accepted since that delivery.
</after_chat_continuation>

This is not a human message or a task. The recent exchange may simply
still be present.

If something genuinely remains, you may look into it, continue private
work, or say it through message. If nothing does, use message.no_reply
and let it pass.

Do not manufacture a follow-up merely because this continuation occurred.
```

Tests verify the assembled mechanical Context and do not treat prompt string assertions as a behavior evaluation.

## Interface And Test Seam

- Runtime: confirmed Delivery creates recoverable continuation state; human ingress cancels it; quiet continuation completion does not advance Activity.
- Scheduler: due admission, expiry, Activity-close ordering and `nextRunAt` are visible through `runOnce` and Runtime status.
- Main Agent: a continuation uses the source Behavior and current Context Window, with the confirmed Input wrapper.
- Instance: restart, model blockage and the complete Delivery-to-continuation path work through `openLoomInstance`.

Tests do not query SQLite or expose a generic scheduling interface.

## Out Of Scope

- General jobs, configurable delay/expiry, CLI, signal handling or channel Adapter work.
- A separate Context snapshot or a new Context Window for after-chat.
- Behavioral quality claims that require a real model evaluation.
- Production migration or compatibility with an existing Agent Individual.

## Result

- confirmed outbound Delivery 现在会在 Runtime Store 中留下一个五分钟后可运行、二十分钟后失效的 continuation；后续 confirmed Delivery 重新计时，`unknown` / `not_sent` 与 continuation 自己的 outbound 不会安排新一轮。
- 新 human Input 与 continuation cancellation 在同一事务中完成。未进入 Turn 的内部 Input 会删除；已有 Turn evidence 的 Input 会保留引用并封存为 `blocked`，不会破坏历史事实。
- Scheduler 在 Activity closure 前推进 continuation；model blocked 时保留至失效，重启后从同一状态恢复。admitted continuation 复用来源 Active Segment、Context Window 与 interaction/background Behavior。
- continuation 的 `no_reply` 不推进 Activity；普通 Workspace/tool activity 或 outbound Effect 仍按真实活动推进。失败 Turn 已产生真实工具或 Effect 时视为覆盖，不再重放。
- Main Agent 使用已确认的 `<after_chat_continuation>` framing。公开 ingress 的 Input 类型与 Runtime 防线都不允许外部伪造 continuation。
- Runtime Store schema 升至 v12，并在打开 v11 Store 时一次迁移现有 Input 与 Turn 引用；没有兼容双轨、通用 job framework 或新增配置。

## Verification

- `npm run typecheck`
- `npm test` - 211 tests passed
- `npm run build`
- `git diff --check`

## Source References

- Loom Tickets 13, 25 and 34
- Xi `src/state/after-chat.ts`
- Xi `src/runtime/actions.ts`
- Xi `src/runtime/conversation-window-lifecycle.ts`
- Xi `docs/context-model.md`
