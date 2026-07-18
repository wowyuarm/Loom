# Loom Terms

Loom 的术语用于把 Harness、Agent Individual、实例和内部边界区分开，避免把它们混成同一种 agent 或部署概念。

## Product Model

**Loom**:
面向长期关系主体的 Agent Harness 的正式实现项目名。它不是某个 Agent Individual，也不是某个 Runtime Instance。
_Avoid_: agent individual, runtime instance, individual name

**Agent Harness**:
为 Agent Individual 的长期存在、成长和关系提供条件的运行环境与能力组合。它以好奇、主动独立和以人为核心的关切为设计取向，但不内置某个具体个体。
_Avoid_: multi-agent platform, shared agent host, persona template

**Agent Individual**:
在一个 Runtime Instance 中跨时间持续成长、拥有自身身份、关系、记忆和私人活动的关系主体。
_Avoid_: agent slot, bot profile, tenant

**Runtime Instance**:
Loom 的一次独立部署，承载一个 Agent Individual 及其运行连续性。
_Avoid_: shared runtime, multi-agent host, tenant

**Instance Root**:
一个 Runtime Instance 的单一物理根目录。Loom 默认使用隐藏目录 `.loom/`，但该根目录本身不等于 Agent Workspace。
_Avoid_: workspace root, shared state directory

## Boundaries

**Agent Workspace**:
Agent Individual 的高权限文件工作空间，存放身份、关系、认知材料、skills 和私人工作。它是工作边界，不是宿主机级安全隔离承诺。
_Avoid_: runtime store, security sandbox, deployment root

**Primary Agent Transcript**:
主 Agent 按日追加的完整执行轨迹，保留原始消息、工具调用和结果等证据。它不是整理后的记忆，也不是恢复事实的权威来源。
_Avoid_: chat history, memory file, runtime store

**Runtime Store**:
Runtime Kernel 持久保存的运行事实，用于决定 input、turn、effect、delivery、调度与恢复。
_Avoid_: workspace, agent memory, transcript

**Integration**:
Runtime Instance 与 channel、外部记忆服务、extension 及其凭据之间的具体接入。它为 Harness 提供能力，不定义 Individual 的身份或关系。
_Avoid_: individual capability, relationship material, executor abstraction

**Cognitive Organ**:
由 Loom 内置并版本化维护的专职能力。它的职责、方法、工具面、触发条件和保护规则由 Harness 定义。
_Avoid_: optional plugin, workspace-defined agent, self-evolving organ
