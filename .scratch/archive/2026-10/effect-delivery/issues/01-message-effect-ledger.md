# 01 — message effect 账本 + 崩溃恢复提示

**What to build:** agent 用 `message` 工具对外发消息时，Loom 在发送前把这次对外动作作为一条 Effect
持久落库，发送后回填投递结果；进程崩在发送那一瞬或发送报错留下的"未确认投递"，在 agent 下次醒来的
上下文里被点名，且 Loom 绝不自动重发。对模型可见行为不变（发成功照常拿到 providerMessageId，发失败照常
看到报错）。

**Blocked by:** None — can start immediately

**Status:** complete

- [x] `runtime-state` domain 加 `effect` 表（version 1→2，compatibleVersions:[1]），`RuntimeState`
      暴露 `recordEffect` / `resolveEffect` / 未确认投递查询。
- [x] `message` 工具：send 前 `await recordEffect(pending)`，send 返回 → `resolveEffect(delivered)`，
      send 抛错 → `resolveEffect(unknown)` 并 re-throw。
- [x] 每次 resolve 后 `ctx.emit('loom/delivery', effect)`。
- [x] 醒来上下文点名未确认投递（status ∈ {pending, unknown} 且未被同 route 更晚的 delivered 覆盖）；
      不自动重发。
- [x] 测试：pending→delivered 落库；send 抛错→unknown 且工具仍抛错；跨重启未确认仍在、被后续同 route
      成功投递覆盖后不再点名；`loom/delivery` 事件带 resolved effect。
