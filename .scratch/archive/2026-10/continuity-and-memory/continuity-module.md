# 模块：连续性（epoch / rollover / checkpoint / 召回）

**Status:** host binding + executeTransition + agent runtime + 检索/回返 + 压力策略已实现并测试（`src/context-continuity/`, `src/agent-runtime/`；`tests/context-continuity-host.spec.ts`, `tests/agent-runtime.spec.ts`, `tests/pressure.spec.ts`）。
**last-checked:** 2026-09-26

## 压力策略（本轮新增，“最后一道网”）

复用 context-continuity 导出的 `ContextPressurePolicy` + 一个薄 `LoomPressureHost`（`src/context-continuity/pressure.ts`）。对齐 dsh-agent-team：compaction-basic 改为 `auto:false`，由策略统一管两端：

- 到 handoff 预算：往当轮 steer 一条**一次性通知**（引擎拟文，内容固定：报用量 + “先把长期的记进 memory/notes” + “叫 context_rollover 写 handoff”）；一代一次，锁在会话日志证据上，重启安静、rollover 重新武装。
- 到硬上限：强制一次 reduce，压不动（surface 未推进）就 fail-closed 拒该步，不向模型提交超预算请求。
- 预算未知（无 meter / 无 contextWindow）也 fail-closed 拒；生产里 token-meter 常驻、adapter 提供 contextWindow，`budgetOf` 也回退到 default-model / agent.options 解析，故首步就有预算。

关键分工：通知只是“闹钟”（引擎控制实体，不可改）；“刷 attention / 更新 thread 状态 / 提炼进 memory”的具体手法在 **mind-guidance** 系统提示里（常驻），不塞进通知。DESIGN §11：提醒放在压力时刻（context 还完整、来得及），不堆到 rollover 那一刻；handoff 只写在途残留。

## 已实现（薄 host binding）

按 Team 的 `context-continuity-host.ts` 同构，但因 N=1 更薄：

- `LoomContextContinuityHost` 实现 `ContextContinuityHost<'loom'>`，代理 agentForSubject / subjectForAgent / projectionForSubject / executeTransition 到 options（由装配层供）。
- 自拥的三件：`rolloverIdentity`（sha256(JSON([prevSession,toolCallId])) → `loom-rollover-<digest>` + requestId，崩溃重放收敛）、`isEphemeralNotice`（v1 恒 false）、`LOOM_CONTEXT_CODEC`（中性 handoff prose）。
- `createLoomContextManagement(options)` 把 host + codec 装成 `ContextContinuityCoordinator`。

## 待装配层实现（重部分）

`options.executeTransition` 和 agent 句柄解析需要真正能启动的 agent（`ctx.agents.createAgent/resume` + 模型 + session store），属于装配/boot 层（类比 Team 的 `member-runtime.ts`）。届时：executeTransition 第 3 步 commit 写 `ctx.loomState.setCurrentSession`（指针原子）；第 5/7 经 `ctx.agents` dispose/create/activate；第 8 经 coordinator+inbox 投 handoff/carried。DSH 有 `dsh-llm-mock-server`，端到端 boot 可确定性测试。

---

## Loom 需要它做什么

- session 满了 rollover 到新 session，仍是同一个 agent，带 handoff。
- 能回到过去锚点（checkpoint）。
- 多个物理 session 当一条时间线走（timeline）。
- 召回过去说过/做过的（search + read）。
- 压力到了提醒准备 handoff（pressure policy）。

## 候选 plugin 与判定

`@wowyuarm/dsh-context-continuity`（0.1.3，已发布）。engine 泛型于 `SubjectId`，拥有全部通用机制（idle 边界切换、admission gate、carried input、checkpoint 续接、timeline 谱系游走、崩溃修复），领域相关的部分由 host 注入。

**判定：直接复用，不扩展 engine。** 插件文档把 "single-Individual harness" 列为目标场景；Team 用它管 N 个 Member，Loom 管 1 个 agent，是它更简单的特例。

## host binding：`ContextContinuityHost<SubjectId>` 六方法

| 方法 | Loom 实现 |
| --- | --- |
| `agentForSubject` / `subjectForAgent` | 单 agent ↔ 它的 live agent；runtime 里就一个 handle |
| `projectionForSubject` | 注册 `createContextProjectionDefinition`，折叠这一个 session，缓存一条 |
| `executeTransition` | 见下（本模块最重的一块） |
| `rolloverIdentity` | `loom-rollover-<sha256(prevSession + toolCallId)>` + requestId，崩溃重放收敛到一个操作 |
| `isEphemeralNotice` | v1 返回 `false`（全部保留）；主动性加了 pulse/通知后才识别为 ephemeral（预留挂点） |
| codec | Loom pluginId + 两句中性 handoff prose |

## executeTransition：通用必做 vs Loom 简化

对照 Team 的实现拆开：

```
  通用必做（engine 期望这步完成的）                Loom 单 agent 版
  ──────────────────────────────────────────────────────────────
  1. 等 idle（admission gate 收敛）                保留
  2. checkpointRef 有则先解析 seed                 保留
  3. commit rollover（持久记下新 session 绑定）     保留 —— 触到 ② store 的最小指针
  4. drain carried input                          保留
  5. 退休旧代：dispose 旧 Agent + archive 旧 session  保留
  6. 折叠旧 session 最终 projection → carried 真相   保留
  7. 激活后继代（新 Agent + 新 session，defer notify）保留
  8. 先投 handoff（steer），再投 carried（followup）保留

  Team 专属（Loom 砍掉/简化）
  ──────────────────────────────────────────────────────────────
  ledger getMember / state=enabled                → 单 agent，只需"它在不在跑"
  workspaceId / handle / 多成员目录                → 单 workspace，无 handle
  job 守卫（blockingJobs）                          → v1 不接，缓到主动性（预留挂点）
  notifications / notifyMember（Team inbox）        → 无 Team inbox，删
  enqueueLifecycle（多成员生命周期串行）             → 仍串行化，但只为单活，更简单
```

## 这步暴露的必造件：最小 agent runtime

Team 的换代靠 ledger + handles map 撑着。Loom 单 agent 需要一个等价物，只管一个主体：

```
  · current session id     —— agent 现在在哪个 session（持久，重启靠它 resume）
  · live agent handle       —— activate / dispose
  · 生命周期串行化           —— rollover 不和其它生命周期动作抢（单活锁）
  · create / activate / archive session —— 经 DSH session store + agent registry
```

**② store 在第一个切片只需要一条持久的 current-session 指针**（current session id + 谱系父链），rollover commit 时原子更新。没有它重启后不知道 agent 在哪个 session 上。自建极小记录，不借 DSH 机制（DSH 不提供"单 agent 当前 session"的单例语义；Team 也是自己在 ledger 里存）。更富的（epoch 谱系富信息、跨 epoch 的 Activity 边界）等 ② store 模块展开再加。

## search 接线（v1 就支持）

- `ContextSearchPort` 对着已发布 `@deepseek-ai/dsh-session-query`。
- `SearchScopeProvider`：单 agent 的可搜范围 = 这个 agent 的整条 session 谱系；单主体，实现极简。
- 产出 `context_search`（内容）+ `context_read`（引用）= 记忆设计的双通道。

## 预留挂点（主动性后加，现为空/no-op）

这些都是加性挂点，主动性收敛后填入，不动连续性主干：

- `isEphemeralNotice`：现 `false`，将来识别 pulse/主动性通知。
- executeTransition 的 job 守卫：现无，将来拒绝"还有在跑的 owned job"的 rollover。
- timeline domain boundary：现只有 checkpoint + engine 的 handoff/compaction 边界；将来 ② store 有 Input/Effect 事实后往 timeline 加锚点。
- jev 重排：`context_search` 候选交 jev 打分再排——engine 外的后处理，或 context-continuity 侧的可选 feat（不急）。

## 两条必须现在守住的纪律

主动性靠它们才能加性接入：

1. **一个 agent、一个 session**：单活 runtime。前台互动与后台主动是同一 agent 的不同时刻，共享材料与 continuity，不起第二个并发 agent。
2. **turn 由 inbox 驱动**：一个 turn = inbox 里有东西。Input 是触发方式之一，主动性唤醒是将来另一个生产者。不在上面盖 channel-only 的假设。

## 落点

- Loom bundle 里一个薄 host binding（类比 Team 的 `context-continuity-host.ts`，更薄）。
- 最小 agent runtime（current-session 指针 + live agent handle + 生命周期串行 + session 生命周期操作）。
- continuity 工具（rollover/checkpoint/timeline）+ search 工具挂进 agent 的 tool set。
- 依赖：`@wowyuarm/dsh-context-continuity`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-agent`。
