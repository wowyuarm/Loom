# Cognitive Organs

Cognitive Organs 是 Harness 内建、版本化的能力，维护 Agent Individual 的连续性材料。它们不是 Individual 的身份或声音——是在受控条件下读 Frozen Activities 和 Workspace 材料的证据、再写回的维护工具。

每个 Cognitive Organ 在隔离的 Pi session 中运行，带窄 system prompt、有界工具和严格的读写边界。它们由 Runtime 通过持久队列调度（Orientation 在 proactive pulse 上、Life Recorder 和 Thread Maintainer 在 Activity 关闭后、Attention Maintainer 在自己的短周期上、Memory Reflector 每逻辑日一次），不由 Main Agent 调度。

## 为什么需要 Cognitive Organs

长期存在的 agent 需要连续性：发生了什么、什么重要、哪些工作线还活着、什么注意力自然带向前。Main Agent 可以自己维护这些材料，但有问题：

- Main Agent 的 context 有限且面向 Turn，无法可靠回顾每个过去的 Activity。
- 连续性材料需要一致的结构和证据 grounding，不是逐 Turn 随意维护。
- 有些维护（如 Memory Reflection）应该按计划进行，而不是 Main Agent 恰好想到时。

Cognitive Organs 通过运行专门、有界的维护任务解决这些问题，使用自己的模型调用、证据访问和写权限。

## 五个 Cognitive Organs

### Orientation

**用途**：在可能的 proactive Turn 之前，纵览 Individual 的近期生活，提供一个 Main Agent 可能接住的开口。

**触发**：Proactive Pulse（Runtime 在 Instance 空闲时按可配置节奏调度）。人类 Input 立即取代正在运行的 Orientation。

**读取**：Identity、Stable Facts、Current Attention、Daily Narratives、Episodes、Frozen Activities（分页）、Workspace 文件（只读）、外部注意力证据（如 Raft ambient activity）。

**写入**：无。Orientation 产出 Opportunity（给 Main Agent 的叙述框架）或 `none`（没有值得接的开口）。Main Agent 决定是否行动。

**关键边界**：Orientation 是读者和框架者，不是将要活出下一个 Turn 的主体。它不向人类说话、不分配任务、不完成 Individual 的解读。它指出什么可能相遇；Main Agent 决定是否相遇。

### Life Recorder

**用途**：为每个 Frozen Activity 保存第一手发生了什么；不做长期分析。

**触发**：每个 Activity 关闭后（FIFO 队列，失败重试）。

**读取**：Frozen Activity（全部页）、当前 Daily Narrative、被引用的 Workspace 文件（理解什么变了）。

**写入**：
- `daily/<date>.md`：Daily Narrative（近期连续性、有用细节但不保留每个事件）。
- `episodes/`：可重放 Episodes（值得重建的重要场景）。
- 或 `NO_CHANGE`（Activity 没有值得带向前的）。

**关键边界**：Life Recorder 保存发生了什么，而不是它意味着什么。用 `actorRef` 作为归属的唯一权威。不写 Identity、Memory 或 Behavior。

### Thread Maintainer

**用途**：跨不同的调用保持 Individual Threads 的结构连续性。

**触发**：每个 Activity 关闭后（FIFO 队列，在 Life Recorder 之后）。

**读取**：当前 Turn 的完整证据（Frozen Activity、全部工具结果）、现有 Thread Index 和受影响的 thread 文件。

**写入**：
- `threads/index.md`：全局 Thread Index（入口、导航、生命周期）。
- `threads/<name>/thread.md`：Thread 入口（紧凑、指向 notes）。
- `threads/<name>/notes/*.md`：有实质进展的独立 notes。
- 或 `NO_CHANGE`。

**关键边界**：Thread Maintainer 在决定前读取完整当前 Turn 证据。写入是原子的（每次运行全有或全无）。它不创建证据中不存在的内容；它结构化已存在的内容。

### Attention Maintainer

**用途**：维护 Individual 自然地从一天带到下一天的东西——Daily Narrative 和 Long-term Memory 之间的跨日意识。

**触发**：独立可配置的短周期（与逻辑日关闭和 Activity 生命周期分开）。

**读取**：当前 `attention.md`、Frozen Activities（evidence window，cursor 驱动）、Workspace 材料。

**写入**：
- `attention.md`：Current Attention（被跟随的显式线 + 隐含的感觉上下文，如关系温度和个体节奏）。
- 或 `NO_CHANGE`。

**关键边界**：Current Attention 回答"这些天我自然带着什么？"，不是"我下一步该做什么？"它不是任务列表。Maintainer 可以更新或明确选择不更新。

### Memory Reflector

**用途**：反思已关闭的 Activities，谨慎演化 Individual 的核心连续性材料。

**触发**：每逻辑日一次，消费当日全部 Frozen Activities。

**读取**：全部五类核心材料（Identity、Long-term Memory、Interactivity Behavior、Proactivity Behavior、Stable Facts）、Current Attention、Daily Narratives、Frozen Activities、nmem Working Memory 和 recall（如启用）。

**写入**（带 before-image 备份和原子回滚）：
- `identity.md`：持久自我理解（最高证据门槛）。
- `memory.md`：长期记忆（持久理解，不是事件档案）。
- `behavior/interactivity.md`：互动中可辨识的生活方式。
- `behavior/proactivity.md`：主动时间可辨识的生活方式。
- `facts.json`：Stable Facts（归属、关系坐标等）。
- 或 `NO_CHANGE`。

**关键边界**：Memory Reflector 直接演化核心材料，因此承担最重的证据门槛和明确的哲学边界。形成更新前必须读取完整基线。Identity 演化要求最强证据；Stable Facts 修正保留当前证据中的明确修正而非旧事实。

## Tool Trace Compactor

除了上述五个器官，一个轻量 **Tool Trace Compactor** 在 Context window 准备期间内联运行（不是调度器官）。当已提交 tool traces 超过 context budget 时，它用独立模型调用压缩它们，保留稳定引用供后续展开。

## 调度与恢复

所有 Cognitive Organs 由 Runtime 通过 Runtime Store 中的持久队列调度：

| 器官 | 调度 | 队列 |
| --- | --- | --- |
| Orientation | Proactive Pulse（空闲驱动，可配置节奏） | Runtime Store 中的 Pulse schedule |
| Life Recorder | Activity 关闭后 | FIFO，失败重试 |
| Thread Maintainer | 同一 Activity 的 Life Recorder 之后 | FIFO，失败重试 |
| Attention Maintainer | 独立短周期 | Cursor 驱动，失败重试 |
| Memory Reflector | 每逻辑日一次 | 按日，失败重试 |

重启时 Runtime 从持久状态重建所有 pending organ 工作。器官不依赖外部服务；nmem 不可用时，Memory Reflector 仍基于 Workspace 和 Frozen Activity 证据运行。

## Workspace Mutation 恢复

Life Recorder、Thread Maintainer 和 Memory Reflector 可以在一次运行中写多个 Workspace 文件。这些多文件 revision 由 **Workspace Mutations** 保护：Runtime 持有的 before-image 快照，允许原子恢复。进程在写入中途退出时，下次启动要么恢复旧 revision，要么重放已完成的结果——不会留下半套认知材料。

## 版本化

Cognitive Organs 通过 **Model Runtime Revisions** 版本化。每个器官在创建时绑定到特定 revision；revision 变化（原子验证后）为后续运行创建新器官实例。这确保模型 provider 变化不影响进行中的器官执行。
