# Effect/Delivery 设计快照

**Status:** 已定，v1 建到此形状。

本文是讨论收敛后的设计依据；落地后以源码和测试为准。

---

## 1. 为什么要单独一份 Effect 记录

核心约束（FRAMEWORK §3）：**模型输出不等于世界结果。** 出站动作有两份记录，写入者和语义不同：

```
  ④ session log   写入者=模型执行流。记"我调了 message 工具，它同步告诉我 X"——模型的主观视角。
                  会被 compaction、会 rollover，不是可查询的"未了结动作"账本。
  ② Effect 账本   写入者=Loom 运行时（不是模型）。跨"尝试"分两步写：send 前落 pending，
                  send 后回填 delivered/unknown。是对外动作生命周期的客观记录，为崩溃恢复而存在。
```

关键在崩溃点：进程崩在 send 那一瞬时，只有 ④ 的话工具没返回、log 里干脆没这条，但消息可能已发出去 →
重启后模型不知道发过，可能重发。有 ② 的话 send 之前已落 pending，重启扫到未确认 Effect → 不盲目重发。

② 不是 agent 的记忆。② 是运行时的机械账本（为正确性）；agent 想记住"我跟谁说了什么"作为关系材料，
那是 ③ memory/threads（agent 自己写、有语义）。两层别混。

## 2. Effect 不只是 message

Effect 定义是「一个 turn 想对外部世界做的动作」，message 是第一种、v1 唯一一种。表叫 `effect`、留
`kind` 字段就是这个前向兼容口子；但 v1 只实现 `message`，不建多-kind 派发框架。

判据（决定什么进 Effect 账本）：**动作跨出 Loom 控制的边界，且结果不同步确定。**

```
  写 workspace / 跑 bash / 读网页   → 结果同步确定（退出码/返回值即真相），不进 Effect 账本
  发 telegram / 发 email / 调外部 API → 跨出边界、结果不同步确定，才进 Effect 账本
```

## 3. 一条边界、两个方向（未来展开的框）

```
        世界  ←──────────  边界  ──────────→  agent
   入站 Input ─(accept 账本)─> agent 能信的事实       （已实现：runtime-state acceptedInput）
   出站      <─(Delivery 尝试)─ Effect(声明) ─先落 pending   （本工作项）
             ─(确认/未知)────> 回填 Effect 状态
```

- **inbox 模型（未来）**：把所有"该给 agent 一个 turn 的理由"（channel 消息 / 主动性 pulse /
  reminder / 外部事件 / followup）归一成 Input 项进同一队列。现在的 `agentRuntime.deliver` + 单 focus
  是它的退化实现。出现真实第二个 Input 来源前不碰；真做时先建扁平持久队列，不要 legacy 的
  segment/wave/reply-gate 那套。
- **reminder 影不影响 Effect**：内部定时器（Loom 自己到点塞一条 Input）不是 Effect；外部订阅
  （向外部服务注册）是 Effect，且它 fire 回来是一条 Input——环闭合，Effect 与 inbox 是同一条边界两头。
- **Effect 唯一碰主动性的点**：一次 confirmed Delivery 可触发 followup（legacy 有此概念）。所以 v1
  在 Delivery 状态更新时 emit 一次 `loom/delivery` 事件，未来 followup / 投影订阅它，零改动。

## 4. v1 形状

```
  runtime-state domain 加表 effect（version 1→2，compatibleVersions:[1]）:
    effectId (key) | kind='message' | channel | route | text
                   | status: pending | delivered | unknown
                   | remoteId? | error? | createdAt | resolvedAt?

  message 工具：
    1) 落 effect = pending（await，durable，先于 send）
    2) ctx.channels.send(...)
    3) 返回 → resolveEffect(delivered, remoteId)；抛错 → resolveEffect(unknown, error) 并 re-throw
    4) 每次 resolve 后 emit loom/delivery

  醒来提示（不自动重发）：
    systemPrompt.context() 渲染"未确认投递"——status ∈ {pending, unknown} 且
    同 (channel, route) 上没有更晚的 delivered 覆盖它的 Effect。
    → 后续同 route 成功投递时自然清掉，无需新工具、无需 flag、无需 boot 迁移。
```

### 状态语义为什么是 pending|delivered|unknown（没有 not_sent）

gateway 的 `send` 只有"返回 ChannelSendResult"或"抛错"两种结果，无法区分"确实没发出去"和
"发了但 ack 丢了"。所以 send 抛错保守记 `unknown`（可能已送达），不记 `not_sent`——避免模型自信重发
造成双发。这比 legacy 乐观的 not_sent 更正确也更简单。`pending`（永远没回填）是崩溃 mid-send 的痕迹。

## 5. 明确不做（避开 legacy 过度工程）

见 [README.md](README.md) 的"不做"清单。一句话：门开着，不提前盖楼。
