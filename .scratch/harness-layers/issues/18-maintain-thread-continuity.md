# 18 - Maintain Thread Continuity and Structure

Status: completed
Type: implementation

## Problem

Loom 已把 `threads/` 确认为 Agent Individual 的 Private Work Material。Thread 让 Individual 把一件或几件值得持续追的事抽成一条线，在离散的模型调用之间继续生长；它不只是一个索引条目，也不是普通项目或任务。

Xi 的真实 Workspace 已证明这种连续性可以形成：实验会改变后续判断，关系中的校准会进入另一领域，自主探索也会在数日后接回原问题。但当前结构仍会漂移：有意义的新探索有时继续堆进 `thread.md` 而没有独立保存，入口文件重新膨胀；已经 merge 或 archive 的 thread 仍可能同时保留两份入口；全局 index 又累积大量维护流水。Thread Maintainer 因此不能只维护一张 index，也不能照搬固定 10/20 天与 80 行规则。

## Decisions

- 下一 Cognitive Organ 是 **Thread Maintainer**。它可以只依赖 Agent Workspace 成立，不等待 nmem Integration、logical day、固定 cadence 或完整 assembly。
- **Thread** 是 Individual 主动抽出的中长期私人工作线。它可以来自关系、兴趣、研究、创作、实验或几件事之间逐渐显出的共同问题；它的价值在于让后续离散调用能够接着走，而不是把活动分类得整齐。
- Main Agent / Agent Individual 拥有 thread 的思想、问题、判断与方向。Thread Maintainer 拥有 thread 的结构性维护：入口、独立笔记、全局导航、关联和生命周期。整理结构不能改写成器官自己的观点，也不能替 Individual 发明下一步。
- 每个 thread 默认有一个紧凑的当前入口 `thread.md`，说明这条线是什么、走到了哪里、有哪些关键转折、仍有哪些真实开放处，以及去哪里重读来源。它不是完整历史、运行日志或不断追加的容器。
- 一次值得独立保留的探索、实验、判断转折或外部材料消化，应成为 thread 下的一份独立 note。不是每次活动都要落一份文件；是否独立保存取决于它以后是否值得单独重读、引用或比较。
- Thread Maintainer 可以把堆进 `thread.md` 的实质探索拆成独立 note，再重写入口；也可以更新 thread 间的关联。拆分必须保留原有信息和来源，不把有质地的探索压成几行摘要。
- Thread Maintainer 可以创建结构上已经显明的新 thread、合并实质上已经收敛的 thread、将暂不再推进的线标为 dormant、将已经结束、被替代或合并的线 archive，并在新活动出现时恢复。它默认自主完成这些维护，不等待人类审批。
- merge、split-thread 与 archive 是较高门槛的结构判断：必须从实际材料中成立，保留全部来源文件和明确去向，不制造两个都像当前真相的入口。Archive 是可恢复的保存，不是删除。
- 时间是生命周期证据之一，不是唯一裁决。长期无活动可以提示 dormant 或 archive，但不能用固定天数覆盖材料本身仍然活着、等待外部条件或明确保留的状态。具体默认时间政策留给后续 Configuration；本票不硬编码 Xi 的 10/20 天阈值。
- 全局 `threads/index.md` 是紧凑的当前地图：列出可进入的 thread、当前状态、最近落点和少量重要联系。它不追加本次健康检查、运行总结、给其他器官的建议或历史快照。
- Memory Reflector 暂缓。它会同时影响 Identity、Long-term Memory 与两份 Behavior Material，并依赖 nmem evidence、跨天材料和更强的多文件保护；在 nmem Integration 接口与证据新鲜度尚未确定前实现会提前耦合后续层次。

## Evidence From Xi

- `living-tank` 从机制设计与连续实验，走到“不替系统决定方向”，后来又用 10000 tick 观察修正先前判断；后一次调用不是重复旧结论，而是从旧材料继续。
- `crystal-nights` 从作品里的创造者关系，连接到实际系统干预，再把“内部模型盲区”迁移到架构设计域；这是一条跨月、跨领域的认知弧线。
- `framework-generalization` 会吸收用户纠正、源码证据和新的商业前提，持续改写中心问题；它同时表明即使有 dated notes，`thread.md` 仍可能重新膨胀。
- `fanren-xiuxian-zhuan` 表明连续性不总是研究产出；关系中的陪伴与共同关注也可以构成 thread，而且不是每次靠近都需要独立 note。
- `auto-memory-pool`、`sqlite-workflows-and-xi-harness` 和已合并的安全 threads 出现重复根入口、archive 副本或旧入口未收束，证明 merge/archive 不能只停留在建议文本。

## Proposed Cognitive Organ Contract

一次运行获得完整 Stable Facts、当前时间、`threads/` 变更索引，以及 Agent Workspace 中的固定入口说明。首轮 Context 不预包装 index 或 thread 正文。

器官只获得 `threads/` 范围内的读取、搜索和结构写入能力。写入能力必须支持在一次维护运行中创建、替换、移动多个 thread 文件，并以整轮事务提交；任一工具、模型、校验或最终输出失败时，`threads/` 恢复到运行前的逐字状态。

更新或确认无变化前必须读取当前全局 index，并检查本轮变化涉及的 thread 材料。Change index 只是读取入口，不能替代正文证据。涉及 merge、archive、split-thread 或恢复时，还必须读取所有受影响 thread 的入口与相关来源。

成功结果区分 `updated` 与 `no_change`；具体改了哪些结构进入运行结果和审计，不写进 `threads/index.md`。本票不建立调度、pending retry 或 Runtime change watcher。

## Prompt Resolution

- 独立 note 的门槛是一次推进以后值得单独重读、引用或比较，而不是 Activity、日期或文件变化本身。入口已经积累有质地的实验、来源消化或判断转折时，先将其无损保存为 note，再收紧入口。
- Thread Entry 保留这条线是什么、走到哪里、关键转折、真实开放处和来源入口；不压成项目状态，也不复制完整历史。模型不得为整洁而删掉 Individual 的推理、决定性观察、原话或来源。
- create 需要已有工作确实形成可返回的连续性；split 需要两条可以独立续接的问题或来源线；merge 需要两条线已经共享同一个活的连续性，而不只是同主题或互相引用。
- dormant 需要材料仍值得保留但当前确有暂停；archive 需要材料表明已经结束、被替代或被吸收；restore 需要新工作真实恢复或改变旧线。仅无活动、提及或重读都不足以单独触发这些生命周期变化。
- merge、split 和 archive 前必须读完所有受影响入口及支持判断的来源。所有来源继续保存，并且只能留下一个不含糊的当前入口。

## Implementation

- Frozen Activity 的每个事件现在带有 `turnId`，并保存结构化 Turn 状态与可选 Transcript Anchor；Thread Maintainer 因而能读取一段 Activity 中恰当的完整 Turn，而不把整个 Segment 当作同一次上下文。
- `ThreadEvidenceIndex` 在 Workspace 外为每条 Thread 分配稳定 `threadRef`，持久保存 `Thread -> Activity/Turn` 引用。rename、archive 与 restore 后路径可以变化，Thread 身份和旧来源不变；引用只保存位置，不复制 trace。
- 首轮 Context 只提供 Stable Facts、当前时间、受影响 Thread、当前引用、少量旧引用索引和 `threads/` 路径说明。当前 Thread 正文和旧 Turn 轨迹均由模型按需读取。
- 工具面仅包含 `threads/` 内的 `read` / `ls` / `grep`、引用分页与 Turn 分页，以及完整文件替换和路径移动。不给 `bash`、nmem、Daily、Current Attention 或通用 Workspace 写入。
- 写入前强制读取现有 Thread Index、所有本轮确实存在的变更文件，以及每个 changed 引用的完整当前 Turn。旧 Turn 可按引用分页展开。
- `ThreadWorkspaceTransaction` 保存运行前逐字快照，统一执行多文件 write/move、计算变化路径，并在任一工具、模型、校验或最终输出失败时整轮恢复。已经观察到的 Activity/Turn 引用不回滚，因为它记录的是确实发生的来源事实。
- 成功结果只有 `UPDATED` 与 `NO_CHANGE`。本票不接 cadence、Runtime watcher、Configuration、nmem Integration 或 assembly。

## Verification

- 历史只以引用进入首轮 Context，模型请求后才能展开旧 Turn。
- 实质推进可同时形成独立 note、收紧 Thread Entry 并更新全局 Index。
- provider 在写入和 archive move 后失败时，整个 `threads/` 逐字恢复。
- archive 后的新 Activity 延续同一个稳定 `threadRef`。
- 当前 Turn 只读取部分分页时，结构判断被拒绝。
- 全库 typecheck、build 与 106 条测试通过。

## Out Of Scope

- 改写 Individual 的观点、替它发明兴趣、结论或下一步。
- 接管 `threads/` 之外的私人材料。
- nmem recall、Episode import、cadence、调度和 Runtime 文件监听。
- 在本票硬编码固定 dormant/archive 天数或暴露为 Configuration。
- 自动影响 Current Attention、Memory、Behavior 或其他 Cognitive Organ。

## Acceptance

- Thread Maintainer 能维护全局 index、thread 入口、独立 notes、关联和生命周期，而不接管思想内容。
- 有意义的探索可以从膨胀入口中无损拆出；入口仍能让后续调用接住当前弧线。
- merge、archive、恢复和 thread split 不丢来源、不制造双重当前入口，任一失败整轮回滚。
- Index 是紧凑的当前地图，不累积维护历史；时间只作为判断证据，不成为固定机械裁决。
- 无实质变化时不写。
- faux provider 测试只验证最终 Context、`threads/` 范围、结构事务、读取前置、`NO_CHANGE` 与回滚；语言、判断和连续性质量留给真实模型评估。
