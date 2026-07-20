# Loom Harness Layers

Status: active

## Purpose

从 Xi 已讨论的 source tickets 中选择、归并并分辨 Loom 的主要层次，为后续逐层讨论与实现提供导航。这里不重开项目方向，也不把地图本身当作代码前置交付物。

## Whole

Loom 是完整的 Agent Harness。`Harness` 不作为与 Runtime、Workspace 或 Cognitive Organs 并列的内部层名；Xi `src/harness/` 中与主 Agent 调用有关的职责在 Loom 中归入 Main Agent。

## Executing Modules

| Module | Owns |
| --- | --- |
| Runtime | input、时间、调度、turn、effect/delivery、恢复与运行观测。 |
| Main Agent | 主 Agent 的 Pi 执行、Context、Primary Agent Transcript 与 tool trace。 |
| Cognitive Organs | Harness 内化且版本化的认知维护能力。 |
| Integrations | channel、nmem、extensions 及其具体 Adapter。 |

## Owned Surfaces

| Surface | Meaning |
| --- | --- |
| Agent Workspace | Individual 的身份、关系、记忆、行为材料、skills 与私人工作。 |
| Runtime Store | Runtime 恢复所需事实的唯一权威。 |
| Primary Agent Transcript | 主 Agent 的原始执行证据，不承担恢复真相。 |
| Instance Configuration | 实例装配、时间节律、模型策略与默认 route 引用。 |

Skills 只有一套发现与加载机制，来源只表示维护权；tools 是 Main Agent 暴露的动作面，两者都不单独成为主层。

## Detail Order

1. Runtime + Runtime Store
2. Main Agent + Primary Agent Transcript + Context
3. Agent Workspace
4. Cognitive Organs
5. Integrations
6. Instance Configuration and assembly

这个顺序用于讨论依赖，不预先规定代码目录或实施提交顺序。

## Current Frontier

- Completed: [01 — Refine Runtime and Runtime Store](issues/01-refine-runtime-and-store.md)
- Completed: [02 — Bind Agent Execution to Pi Transcript Evidence](issues/02-bind-pi-execution-and-transcript.md)
- Completed: [03 — Materialize Context Windows per Turn](issues/03-materialize-context-windows-per-turn.md)
- Completed: [04 — Bind Agent Workspace Materials to Turns](issues/04-bind-agent-workspace-materials-to-turns.md)
- Completed: [05 — Unify Skill Discovery per Turn](issues/05-unify-skill-discovery.md)
- Completed: [06 — Compact Tool Traces Before Context Reuse](issues/06-compact-tool-traces-before-reuse.md)
- Completed: [07 — Correct Runtime and Source Boundaries](issues/07-correct-runtime-and-source-boundaries.md)
- Completed: [08 — Run Life Recorder from Frozen Activity Evidence](issues/08-run-life-recorder-from-frozen-activity.md)
- Completed: [09 — Correct Life Recorder Context and Grounding](issues/09-correct-life-recorder-context-and-grounding.md)
- Completed: [10 — Define Replayable Episodes and the Life Recorder Method](issues/10-define-replayable-episodes-and-recorder-method.md)
- Completed: [11 — Close Activity without Blocking Continuity](issues/11-close-activity-lifecycle.md)。Runtime 已持久连接 Active Segment、Frozen Activity、successor Context、pending Life Recorder 与 Receipt，并建立 Workspace 受限 `read` / `ls`。durable freeze 允许后继 Input；器官运行本身不进入 lived Activity。其最初按 pending 状态选择 bridge 的做法已由 Ticket 12 修正。
- Completed: [12 — Bound the Recent Activity Bridge](issues/12-bound-recent-activity-bridge.md)。Recent Activity 与 Recorder 队列已解耦；successor 固定最近四段紧凑 bridge，普通工具 pair 共享 1K 额度、保留 200 字预览，并通过现有 `expand_tool_result` 读取完整证据。
- Completed: [13 — Bind Main Agent Message Decisions](issues/13-bind-main-agent-message-decisions.md)。Main Agent 在装配默认 Interaction Route 时获得通用 `message`；`send` 先形成持久 Effect，`no_reply` 形成明确 Turn outcome，成功的 Harness terminal tool result 可作为已验证 Transcript 末尾。
- Completed: [14 — Form Proactive Opportunities](issues/14-form-proactive-opportunities.md)。Orientation 通过隔离 Pi session、Stable Facts、Workspace 受限读取和专用 Activity 分页形成 Opportunity 或 none；Runtime 只在持续空闲时原子接纳，主动 Turn 的静默、私活、message、途中来信和失败前工具活动均已闭合到 Active Segment / Frozen Activity 生命周期。

## Context Follow-ups

Ticket 03 已闭合 per-Turn session、committed branch、active window projection 与材料选择。以下后续项属于同一 Context 路线，不能因离开首个 Context 实现而丢失：

| Follow-up | Current handling |
| --- | --- |
| Window Closure and Recent Activity Bridge | Tickets 11-12 completed：durable freeze、successor Context、FIFO Life Recorder 与 Receipt 已闭合；bridge 独立选择最近四段、固定于 Segment，并提供受限可展开的工具证据。 |
| Tool Trace Compaction and Evidence Expansion | Ticket 06 completed：真实 compactor、失败 gate、Runtime 原子替换、稳定引用分页展开与机械收回已闭合。 |
| Logical Day and Cross-day Context Recovery | 等时间/节律配置与每日 transcript 归属明确后实现。 |
| Workspace Material Sources | Tickets 04-05 已接入 Identity、Memory、Behavior、Current Attention 与统一 skills catalog。 |
| Configuration and Model Revision Input | 等 Instance Configuration 层提供预算与每 Turn revision。 |

具体边界与进入条件由 [ticket 03](issues/03-materialize-context-windows-per-turn.md#deferred-context-work) 维护；关闭一项后再为下一项建立实际 ticket，不提前创建空文件。

## Source References

- Xi [Harness Generalization Map](../../../Xi/.scratch/harness-generalization/map.md)
- Xi [03 — Runtime Kernel Contract](../../../Xi/.scratch/harness-generalization/issues/03-identify-the-runtime-kernel-contract.md)
- Xi [04 — Runtime Instance, Workspace, and Individual](../../../Xi/.scratch/harness-generalization/issues/04-define-workspace-and-instance-semantics.md)
- Xi [05 — Harness Capability Composition](../../../Xi/.scratch/harness-generalization/issues/05-define-harness-capability-composition.md)
- Xi [07 — Interaction Route and Message Contract](../../../Xi/.scratch/harness-generalization/issues/07-define-interaction-route-and-message-contract.md)
- Xi [09 — Runtime Store and Recovery](../../../Xi/.scratch/harness-generalization/issues/09-set-runtime-store-storage-and-recovery-boundaries.md)
- Xi [10 — Primary Agent Transcript](../../../Xi/.scratch/harness-generalization/issues/10-define-primary-agent-transcript-protocol.md)
