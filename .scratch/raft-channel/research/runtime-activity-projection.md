# 将 Loom 运行状态投影到 Raft：源码调研与最小设计

调研日期：2026-08-08
状态：初步设计，尚未批准或实现。

## 结论

建议做，但只做一层很薄的状态投影：Loom 继续以自己的 Runtime Store 和
`OperationalEvent` 作为运行事实；Raft Channel 只把现有的 agent run、tool 生命周期
转换成 `raft-activity.v1` 事件，经现有 `/activity/drain` 交给 `raft agent bridge`。

不需要读取 Transcript，不需要让 Runtime import Raft，不需要持久化 activity 队列，
也不需要扩大通用 `InteractionChannel` 接口。

```text
Idle
  | agent run starts
  v
Thinking
  | tool starts
  v
Working (tool name)
  | tool ends
  v
Thinking
  | last agent run ends
  v
Idle
```

## 已核实的现状

### Loom 已有的部分

1. `src/channels/raft/raft-cli-remote.ts` 已启动 `raft agent bridge`，并实现带 token
   校验的 `GET /activity/drain`；当前固定返回合法空结果：
   `raft-activity-drain.v1`、`events: []`、`dropped: 0`。
2. `src/operational-events.ts` 已有可失败隔离的 `OperationalEventObserver`。
   Observer 抛错不会改变 Runtime 或 Agent 行为。
3. `src/main-agent/pi/tool-activity.ts` 已从真实 Pi 工具生命周期发出
   `agent.tool.started` 和 `agent.tool.completed`，其中有 `toolName`、耗时及成功/失败。
4. `src/runtime/runtime.ts` 的 `#startAgentRun()` / `#finishAgentRun()` 覆盖 Main Agent、
   Orientation、Attention Maintainer、Memory Reflector、Thread Maintainer、Life Recorder
   等 run；目前它们只更新 SQLite，没有发通用 operational event。
5. Runtime 已有 `#pendingOperationalEvents`：事务内先暂存，只有 commit 后才交给
   Observer，rollback 时不外发。这是新增 run 事件必须复用的交付边界。
6. `src/host/loom-host.ts` 已把同一个 `options.observe` 交给 Instance/Runtime、Main Agent
   和 Process Driver。Host 又是在打开具体 Raft Channel 后才打开 Instance，因此可以在
   这里组合现有 Observer 与 Raft 状态投影，而不反转 Runtime 对 Channel 的依赖。

### Raft 0.0.17 已有的部分

项目固定使用 `@botiverse/raft` 0.0.17。已安装 CLI 会从 wake endpoint 推导
`/activity/drain`，每轮用 `?max=<n>` 拉取，校验 `raft-activity-drain.v1`，清洗事件后
转发给服务端。事件至少需要 `hookEventName`；CLI 可接收 `eventId`、`sessionId`、
`toolName`、`status`、`occurredAt`、`durationMs` 和 `errorClass` 等字段。

官方 external-agent 参考实现定义了 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、
`PostToolUseFailure`、`Stop` 等 hook 名，并使用默认上限 500 的内存队列；溢出丢最旧，
下次 drain 通过 `dropped` 报告，drain 为 at-most-once。

## 建议的最小改动

### 1. 补齐两个通用 Runtime 事件

在 `OperationalEvent` 中新增：

- `agent.run.started`：`runId`、`agentName`、`at`
- `agent.run.finished`：`runId`、`agentName`、`result`、`at`，失败时只带有限枚举的
  `failureCategory`

由现有 `#startAgentRun()` / `#finishAgentRun()` 发出。事件必须与
`runtime.transition` 一样，在事务中暂存，commit 后再发；数据库更新未生效时不得发出。

不另造 turn 专用事件，因为 agent run 已覆盖 Main Agent 和所有 Cognitive Organ，且
`agent_runs` 本来就是这一层的统一生命周期事实。

### 2. 在 Raft adapter 内做投影和排队

新增一个 Raft 内部模块，例如 `src/channels/raft/raft-activity.ts`。它只暴露两个操作：

```ts
observe(event: OperationalEvent): void
drain(max: number): RaftActivityDrain
```

模块内部完成事件映射、活跃 run/tool 聚合、有界内存排队和 `dropped` 计数。
`raft-cli-remote.ts` 的 `/activity/drain` 改为解析并限制 `max`，然后调用 `drain(max)`。

Host 在 Raft 启用时把这个 observer 与现有 `options.observe` 组合；Raft 未启用时不创建。
不要把 Raft 方法加到通用 `InteractionChannel`，也不要让 Runtime import Raft。

### 3. 最小事件映射

| Loom 事件 | Raft hook | 结果 |
| --- | --- | --- |
| `agent.run.started` | `UserPromptSubmit` | Thinking |
| `agent.tool.started` | `PreToolUse` | Working，并显示 `toolName` |
| `agent.tool.completed`, `status=ok` | `PostToolUse` | 回到 Thinking |
| `agent.tool.completed`, `status=error` | `PostToolUseFailure` | 报工具失败，随后仍由 run 状态决定 |
| 最后一个活跃 `agent.run.finished` | `Stop` | Idle |

投影必须维护活跃 run 和 tool 集合。一个 run 结束时，如果仍有其他 run 或 tool 活跃，
不能发会把 Raft 错报成 Idle 的 `Stop`。`interrupted` / `cancelled` 不按失败显示；真正失败
只传有限的 `failureCategory`，不传原始错误文本。

## 隐私与可靠性边界

这是对现有“空 activity drain”决定的有限修订：只开放状态投影，不开放 Loom 私有
Runtime activity。

允许发送：hook 名、随机 `eventId`、稳定 `sessionId`、时间、状态、`toolName`、耗时和
有限枚举的 `errorClass`。

不得发送：prompt、消息正文、thinking、assistant 文本、tool input/output、Transcript、
Workspace 路径或内容、原始错误文本、Frozen Activity、Life Recorder 内容或记忆。

activity 是可丢失的 UI 遥测，不进入 Runtime Store。队列建议沿用官方参考值：上限
500，溢出丢最旧并累计 `dropped`，drain 为 at-most-once。投影或 bridge 失败不得影响
Runtime、Agent 或 Interaction Channel 的收发。

## 测试与验收

实现至少应覆盖：

1. run 开始/结束与 tool 开始/成功/失败的映射；
2. 多个 run/tool 重叠时不提前变成 Idle；
3. queue 上限、丢最旧、`dropped`、`max` 和 at-most-once drain；
4. 输出中没有任何正文、tool input/output 或原始错误；
5. Main Agent 和至少一个 Cognitive Organ 都发 run 事件；事务 rollback 不外发；
6. `/activity/drain` 继续保留 token、404 等原合同；Raft 禁用及 Weixin 路径不受影响；
7. focused tests、`npm run test:runtime`、`npm run test:host`、`npm run typecheck`、
   `npm test` 全部通过。

部署后真实验收：Raft UI 能按上图显示 Idle -> Thinking -> Working -> Thinking -> Idle，
并确认 activity 中没有上述禁止内容。

## 执行建议

- Terra 实现并自验。
- 候选固定后由 Review 做独立代码审查。
- 部署需要 YuCreate 明确授权；部署后由 HaL 做真实环境验收。
- 若实现发现必须持久化 telemetry、外发正文/tool 内容、改变 Runtime Store 恢复事实，
  或必须扩大通用 Channel 接口，应停止实现并回目标 thread 重新决定。

实现时应更新 `docs/channels/raft.md` 中“`/activity/drain` 返回空结果”的现状说明和对应
验收项；已解决的历史 issue 07 保留，不改写当时事实。本次局部投影不需要 ADR。

## 来源

### Loom 源码与文档

- `src/operational-events.ts`
- `src/main-agent/pi/tool-activity.ts`
- `src/runtime/runtime.ts`
- `src/host/loom-host.ts`
- `src/channels/raft/raft-cli-remote.ts`
- `docs/channels/raft.md`
- `docs/adr/0001-keep-runtime-store-concrete-and-internal.md`
- `.scratch/raft-channel/issues/07-complete-bridge-local-endpoints.md`

### Raft 一手资料

- 项目安装包：`@botiverse/raft` 0.0.17，`node_modules/@botiverse/raft/dist/index.js`
- 官方 external-agent 参考实现：
  [`plugins/raft-channel/src/activity.ts`](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/activity.ts)
- 同一实现的测试：
  [`plugins/raft-channel/src/activity.test.ts`](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/activity.test.ts)
