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
- Current frontier: Life Recorder 已使用 Stable Facts、索引驱动 Context 和受保护写入独立消费 Frozen Activity。Runtime Active Segment、recorder receipt 的持久接入、Window Closure 与 Recent Activity Bridge 现在满足进入条件；下一张 ticket 应先共同收束这条生命周期，不提前进入 nmem Integration、logical day、Configuration 或 generic organ framework。

## Context Follow-ups

Ticket 03 已闭合 per-Turn session、committed branch、active window projection 与材料选择。以下后续项属于同一 Context 路线，不能因离开首个 Context 实现而丢失：

| Follow-up | Current handling |
| --- | --- |
| Window Closure and Recent Activity Bridge | Agent Workspace 与 Life Recorder 已具备；下一步与 Runtime Active Segment 和持久 receipt 一起收束。 |
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
