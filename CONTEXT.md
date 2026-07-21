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

**Runtime**:
Loom 内部负责 input、时间、调度、turn、effect、delivery 与恢复的运行模块。它提供可靠的生命周期条件，不决定 Individual 的关注、表达或关系判断。
_Avoid_: Agent Harness, daemon, scheduler

**Main Agent**:
Loom 内部负责主 Agent 的 Pi 执行、Context 组装、Primary Agent Transcript 和 tool trace 的模块。它不负责 Runtime 生命周期，也不定义认知器官如何运行。
_Avoid_: Agent Individual, Agent Harness, runtime, cognitive organ

**Agent Workspace**:
Agent Individual 的高权限文件工作空间，存放身份、关系、认知材料、skills 和私人工作。它是工作边界，不是宿主机级安全隔离承诺。
_Avoid_: runtime store, security sandbox, deployment root

**Primary Agent Transcript**:
主 Agent 按 logical day 追加的一份完整执行轨迹，保留原始消息、工具调用和结果等证据。进行中的 Turn 固定使用准入时所属日的 Transcript；它不是整理后的记忆，也不是恢复事实的权威来源。
_Avoid_: chat history, memory file, runtime store

**Runtime Store**:
Runtime 持久保存的运行事实，用于决定 input、turn、effect、delivery、调度与恢复。
_Avoid_: workspace, agent memory, transcript

**Input**:
Runtime 已持久接受、可以交给主 Agent 处理的一份外部来信或主动机会。它不是 prompt；一次处理失败后是否还能继续，取决于已经发生的事实。
_Avoid_: message, prompt, queue item

**Active Segment**:
Agent Individual 一段连续且仍可能继续变化的实际活动范围。它可以包含多个 Input 与 Turn，直到 Runtime 将其冻结为 Frozen Activity。
_Avoid_: turn, context window, transcript branch

**Turn**:
主 Agent 对一组已纳入输入进行的一次有边界运行。一个 Turn 可在运行中接纳后续 Input，但同一 Runtime Instance 同时只有一个主 Agent Turn。
_Avoid_: session, request, model call

**Effect**:
Turn 在模型计算之外改变状态或对外行动的持久声明。Effect 必须先存在，相关工具或 Integration 才能实际执行。
_Avoid_: tool call, delivery, log event

**Delivery**:
Integration 对一个 outbound Effect 的实际投递尝试及其结果。Effect 被 Runtime 接受不表示 Delivery 已成功。
_Avoid_: message send, effect, tool result

**Transcript Anchor**:
Runtime Store 对 Primary Agent Transcript 中已存在执行证据的可验证引用，由 transcript source、session 和 entry 共同定位。它证明记录位置，不把 Transcript 变成恢复事实源。
_Avoid_: transcript content, summary, runtime state

**Instance Configuration**:
描述一个 Runtime Instance 如何装配，以及使用哪些时间政策、模型策略与 Integration 引用的配置材料。它不承载 Individual 材料、凭据内容或动态运行事实。
_Avoid_: persona configuration, workspace material, runtime state

**Integration**:
Runtime Instance 与 channel、外部记忆服务、extension 及其凭据之间的具体接入。它为 Harness 提供能力，不定义 Individual 的身份或关系。
_Avoid_: individual capability, relationship material, executor abstraction

**Integration Receipt**:
Runtime Store 中证明一份本地证据已经由某个 Integration 完成外部投影的持久事实。它用于幂等恢复，不改变本地证据的成立或语义。
_Avoid_: workspace metadata, life recorder receipt, external truth

**nmem Conversation Thread**:
一份 Frozen Activity 向 nmem 投影形成的外部会话来源。它保留真实人类输入、确认送达的回复，以及有实际动作或结果的简洁私人活动，但不包含模型 thinking 或原始工具结果；它服务于外部记忆演化，不是 Agent Workspace 中的私人工作线。
_Avoid_: Thread, transcript archive, episode, raw activity trace

**nmem Working Memory Evidence**:
nmem 对近期跨时间重点形成的外部派生证据。Loom 保存其来源日期、成功抓取时间和失败后的 stale 状态，供需要跨时间校准的 Cognitive Organ 按需读取；它不是 Agent Workspace 材料，也不能阻断 Runtime 或当前活动。
_Avoid_: Current Attention, long-term memory, workspace projection, runtime gate

**Cognitive Organ**:
由 Loom 内置并版本化维护的专职能力。它的职责、方法、工具面、触发条件和保护规则由 Harness 定义。
_Avoid_: optional plugin, workspace-defined agent, self-evolving organ

**Orientation**:
在 Runtime 空闲时探索近期 Activity、Agent Workspace 与动作空间，并为 Main Agent 提供一个可能关注点的 Cognitive Organ。它不是 gate、planner、任务分发器或 Main Agent 的替代判断者；没有真实牵引时可以不形成 Opportunity。
_Avoid_: scheduler, background agent, task planner, proactive gate

**Opportunity**:
Orientation 结果经 Runtime 原子确认仍然空闲后形成的一种 Input。它不是人类来信或任务，可以被 Main Agent 放下、转化为私人活动或通过 Effect 走向外部行动。
_Avoid_: human message, scheduled task, orientation result, mandatory action

## Cognitive Recording

**Stable Facts**:
Agent Workspace 中供 Cognitive Organs 共同使用的少量结构化事实，描述 Agent Individual、主要关系对象及双方相对稳定的身份、称谓、关系、地点与语言。它提供归属和表达的基本坐标，不承载近期状态、行为规则、长期叙事或运行配置。
_Avoid_: identity prose, long-term memory, actor registry, persona configuration

**Memory Reflector**:
Loom 内负责把跨时间 evidence 慎重写回 Stable Facts、Identity、Long-term Memory 与两份 Behavior Material 的 Cognitive Organ。它可以在最高证据门槛下支持 Individual 的身份演化，但不维护 Current Attention，也不把 nmem 或 Daily candidate 当作命令。
_Avoid_: summarizer, memory importer, behavior generator, identity author

**Frozen Activity**:
面向一个已关闭 Active Segment、已停止变化并可供认知器官消费的实际活动证据，其中每个事件都通过 Actor Reference 明确归属。它完整覆盖该段内已持久确认的 Input、Turn、Transcript、工具、Effect 与 Delivery；未提交的失败分支只能作为 Runtime 已确认的停止事实进入，不能被推测为 transcript evidence。它不是自然语言摘要。
_Avoid_: active segment, transcript slice, conversation summary

**Actor Reference (`actorRef`)**:
Frozen Activity 内标识事件归属的稳定引用；当前只区分 Agent Individual、主要关系对象与 system。自然姓名和关系称谓来自 Stable Facts，不能替代或改变 Actor Reference 所确定的归属。
_Avoid_: display name, inferred speaker, relationship label

**Daily Narrative**:
Agent Workspace 中面向近期接续的一日叙事。它保留当天仍有用的经过与悬而未决之处，不承担长期模式判断。Main Agent 的新 Context Window 固定当前与前一 logical day 的完整正文，Daily Candidate 不进入该材料。
_Avoid_: long-term memory, transcript, episode collection

**Daily Candidate**:
Daily Narrative 中留给后续 Cognitive Organ 的简短证据线索。它可以指出稳定事实、校准、成长、注意力或尚待观察之处，但不是已确认的跨时间结论，也不是 Episode。
_Avoid_: long-term conclusion, task item, episode candidate

**Episode**:
Agent Workspace 原生保存的“发生了改变”的可回放场景，服务于 Agent Individual 未来的连续性。它不依赖外部记忆 Integration；Integration 可以后来消费它，但是否导入不改变 Episode 自身的成立。
_Avoid_: summary, daily candidate, imported memory

**Life Recorder Receipt**:
Life Recorder 对一份 Frozen Activity 已完整读取且相应 Workspace 写入已完成的证明。它不证明 Activity 已关闭，也不证明任何外部记忆 Integration 已完成导入。
_Avoid_: activity close, import receipt, model confirmation

**Recent Activity Bridge**:
将最近最多四段 Frozen Activity 作为过去证据带入后继 Context 的确定性紧凑投影。它与 Life Recorder Receipt 状态无关，在一个 Active Segment 内固定，普通工具交互成对受限并可从授权引用展开；它不是新的 Input，也不包含未对外显露的 thinking。
_Avoid_: current request, daily narrative, conversation summary

**Current Attention**:
Agent Individual 在最近几天里无需主动回想、醒来时自然带着的中短期觉知。它包含仍在追的方向及其当前位置，也包含会影响表达、靠近、沉默或转向的关系底色与自身节奏；它不是即时任务前景、事件摘要、行为指令或长期记忆。
_Avoid_: active attention, task list, daily narrative, opportunity, long-term memory

## Private Work

**Thread**:
Agent Individual 主动抽出、能在离散调用之间继续生长的一条中长期私人工作线。它可以连接兴趣、关系、研究、创作或实验，但不是任务、项目状态或普通笔记集合。
_Avoid_: task, project, topic folder, note collection

**Thread Entry**:
一条 Thread 的当前可进入全貌，连接它是什么、走到哪里、关键转折、开放处与来源入口。它不是完整历史、下一步计划或维护日志。
_Avoid_: summary, task status, changelog

**Thread Note**:
Thread 中一份值得以后独立重读、引用或比较的推进记录。它保留一次实质探索、实验或判断转折，但不是每次活动的强制日志。
_Avoid_: daily entry, activity log, thread summary

**Thread Index**:
Agent Workspace 中跨 Thread 的当前导航地图，呈现可进入的线、生命周期、最近落点和重要联系。它不是 Current Attention、长期记忆或维护运行历史。
_Avoid_: attention, memory, maintenance log

**Thread Maintainer**:
Loom 内负责保持 Thread 结构连续性的 Cognitive Organ。它维护入口、独立记录、导航、关联和可恢复生命周期，但不拥有或改写 Agent Individual 的思想与方向。
_Avoid_: project manager, content author, thread indexer

**Thread Evidence Reference**:
一条 Thread 与某份 Frozen Activity 中具体 Turn 的稳定关联，表示该 Turn 改动或明确查看过这条线。它保存可按需展开的来源位置，不复制活动轨迹，也不证明器官对材料的解释成立。
_Avoid_: copied trace, thread summary, interpretation, workspace link

**Dormant Thread**:
当前没有继续推进但仍保留返回可能的 Thread。时间可以提示休眠，但不能单独证明一条线已经失去活性。
_Avoid_: expired thread, archived thread

**Archived Thread**:
已经结束、被替代或合并，不再占据当前导航前景但仍完整保留来源的 Thread。Archive 是可恢复保存，不是删除。
_Avoid_: deleted thread, dormant thread
