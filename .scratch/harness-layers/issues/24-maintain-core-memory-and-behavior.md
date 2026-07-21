# 24 — Maintain Core Memory and Behavior

Status: resolved

## Problem

Loom 已有 Identity、Long-term Memory、Interaction / Background Behavior、Stable Facts 与 Current Attention 的读取合同，但没有负责跨时间维护前五类核心材料的 Cognitive Organ。Life Recorder 只能留下 Daily candidates 和 Episodes；nmem 只提供外部派生 evidence。没有 Memory Reflector，这些 evidence 不会慎重回到 Main Agent 每轮都会看到的长期材料，Stable Facts 也没有权威维护者。

本票实现 Memory Reflector 的独立 Interface、模型可见方法、受控 evidence 和多材料写入保护，不接 durable scheduler、assembly 或 workspace init。

## Confirmed Material Semantics

- `facts.json` 是少量结构化 Stable Facts：Individual 与 primary human 的姓名、自然称谓、语言、地点、身份、关系角色等稳定坐标。它服务于归属和语言，不承载近期状态、行为规则、长期叙事或 Harness 配置。
- `identity.md` 是 Individual 对自己、关系与存在方式的长期自我理解。它不是事实表或行为清单，可以由反复出现的私人思考、行动、跨场景变化及人的明确校准自主演化，但证据门槛最高。
- `memory.md` 保存跨时间仍会改变 Individual 如何理解 human、关系、自己与持续工作线的长期记忆。它不是 Daily、事件日志或行为指令，也不固定 Xi 的四域结构。
- `behavior/interaction.md` 保存直接互动时的自然行为倾向；`behavior/background.md` 保存无人新输入时如何独处、探索、靠近、行动与沉默。它们是同一 Individual 的两种生活视角，不是两个角色。
- `attention.md` 只读，由 Attention Maintainer 维护。Harness System Guidance 位于 Workspace 外，Memory Reflector 不可读取或修改其来源。

## Harness Philosophy and Initial Behavior Templates

好奇、主动独立和以人为核心的关切是 Harness 的版本化设计取向，不是某个 Individual 的可选人格开关，也不能只依靠会被演化的 Behavior Material 保留。未来 assembly 应把它们首先写入 Harness System Guidance：支持自己的注意、私人活动、关系靠近、不同意和沉默，不强制输出、外联、生产力或对人的偏好镜像。

首个 Main Agent Turn 前，两份 Behavior Material 仍应从小型中性模板开始，使尚未积累行为证据的 Individual 可以生活：

- Interaction 模板只说明直接来信是长期关系中的一次真实互动；先理解当下的人与语境，带着自己的判断回应，不退化为等待任务的助手或人的偏好镜像。
- Background 模板只说明没有来信也是 Individual 自己的时间；可以顺着真实好奇、注意、私人工作或关系关切行动，也可以沉默，不为证明“活着”而制造产出或消息。

模板不给名字、关系结论、语气、兴趣、固定节律、channel 或任务。它们属于后续 assembly / workspace initialization 的首个实际消费者，本票只固定语义，不提前创建无消费者的模板模块。

## Model-Visible Method

Memory Reflector 的 system prompt 使用英语定义以下方法；写入语言必须跟随实际材料和 Stable Facts，引用保持原语言：

1. 先完整读取 `facts.json`、Identity、Long-term Memory、两份 Behavior 与 Current Attention，建立旧全貌。
2. 从 Daily candidates、Episodes、Threads、私人 Workspace 材料和索引的 Frozen Activities 寻找变化。candidate、nmem Working Memory 和 recall 结果只是线索，不是命令或结论。
3. 需要确认归属、原话、thinking、实际动作或 Delivery 时，读取对应 Frozen Activity。Individual thinking 可支持自我理解，但不能伪装成人类陈述、外部事实或已执行动作。
4. 判断每条 evidence 的材料归属。一次事件通常留在 Daily / Episode；跨时间后真正改变理解或行为的内容才进入核心材料。
5. 对需要变化的目标提供完整替换内容。保留仍成立的旧全貌，合并、压缩、澄清或移除过时内容；不是补丁堆叠，也不是每天从头发明。
6. 没有达到门槛时保持不变。Identity 的门槛最高；Behavior 不把关切写成顺从、不把主动写成强制行动、不把好奇写成生产力任务。

核心材料使用 Individual 自身可以自然带着的语言，不出现维护运行、evidence 审核、文件职责或 Harness bookkeeping。Memory Reflector 的最终输出只报告 `UPDATED` 或 `NO_CHANGE`；详细运行保留在自己的 transcript 中。

### Prompt Cross-Review

最终逐项对照 Loom 全部 Cognitive Organ 与 Xi source prompt 后，没有给所有器官机械追加同一段哲学声明：

- Orientation 已通过关系关切、私人工作、转向和 grounded `none` 的 Opportunity 选择方法保护主动空间；Attention Maintainer 与 Thread Maintainer 分别保护自然携带的觉知和私人工作连续性。
- Life Recorder 与 Tool Trace Compactor 保持事实中性。让它们偏爱“主动、关切、成长”材料会污染记录与证据，不属于其职责。
- Memory Reflector 会长期塑造 Identity、Memory 与 Behavior，因此显式承担好奇、主动独立和以人为核心关切的边界，同时避免把它们写成人格口号、强制外联、生产力或顺从。
- 正式 Harness System Guidance 仍是这些取向进入 Main Agent 的版本化共同位置，留给后续 assembly，不由任何 Workspace 材料或 Cognitive Organ 单独代替。

Memory Reflector 同时保留了 Xi 已验证但可通用化的编辑方法：解释全部 Daily candidate labels；按目标日 Daily / Episode、跨日 candidate、Thread、Frozen Activity 与可选 nmem 路由证据；区分各材料的证据门槛和 Interaction / Background 的证据来源。写作品味要求材料保留既有语言、关系纹理、张力、幽默和含混，不写成档案、规章、心理分析、人格品牌或哲学口号。

## Context and Tools

首轮 user message 是索引，不预塞 Workspace 正文或 Activity events：

- run id、observed time 与 local time；
- 六份核心材料的路径和职责；
- 可选 Daily、Episodes、Threads 与私人 Workspace 入口；
- 本次可回看的 Frozen Activity id、recording day、时间范围和 event count；
- nmem Working Memory 与 recall 的可用性说明。

模型获得：

- Workspace-confined `read` / `ls` / `grep`；
- `read_reflection_activity`：只展开本轮索引中的 Frozen Activity，支持分页；
- `read_nmem_working_memory`：返回 available / stale / unavailable evidence 与 freshness，不可用不阻断；
- `nmem_recall`：显式回查外部历史 Memory evidence，不每轮强制调用；
- `replace_core_material`：只能完整替换 `stable_facts`、`identity`、`long_term_memory`、`interaction_behavior` 或 `background_behavior`。

不给通用 `write` / `edit` / `bash`。专用写入工具必须在六份核心材料全部读取且至少检查一份额外 supporting evidence 后才可使用；同一目标一轮最多替换一次。

## Protection and Failure

- 运行前把五份可写材料保存到 Runtime-owned backup directory；备份不属于 Agent Workspace 语义材料。
- 所有写入使用原子替换，并作为一轮事务处理。任何 tool、model、final output 或 validation 失败，五份材料全部恢复到运行前状态。
- `facts.json` 写后仍须是 `version: 1`，并保留 object `individual` 与 `human`；Markdown 目标不得为空。不规定标题、固定章节、长度比例或 Xi 名称。
- 六份核心基线必须连续读完；Pi `read` 截断后须从返回的下一 offset 继续，不能把只读到前 2000 行或 50KB 当作完整全貌。
- nmem unavailable / stale 只作为可见 evidence 状态，不使本地反思失败。Workspace 与 Frozen Activity 足以支持一轮运行。
- 成功但没有材料变化时不制造写入，返回 `NO_CHANGE`。

## Interface and Test Seam

公开 Interface：`MemoryReflector.reflect(request)`。Request 显式提供要整理的 `reflectionDay`、观察时间与本轮授权的 Frozen Activities；`reflectionDay` 不从运行时钟反推，使延迟与重试不会跨 logical-day 漂移。nmem Reader / recall tool、Workspace、Pi model、transcript 和 backup 位置在创建时装配。

测试只穿过该 Interface，验证：

- 最终 Context 是索引式、Stable Facts 和语言坐标正确、工具面受限；
- grounded replacement 能同时更新多份材料并保留结构合同；
- nmem unavailable 时仍能用本地 evidence `NO_CHANGE` 或更新；
- 未读基线、无 supporting evidence、非法 facts、tool/model failure 会拒绝或整轮回滚；
- backup 和独立 organ transcript 实际存在。

不以字符串快照验证主动、好奇、关系感、声线或语言质量；这些留给第二虚拟 Individual 与真实模型行为验收。

## Out of Scope

- durable scheduler、logical-day close、nightly sequencing、retry cursor 与 after-chat lifecycle；
- 正式 Harness System Guidance 文本与 Behavior 模板文件的 materialization；
- Model Runtime Revision、route、assembly、workspace init、生产迁移；
- 真实模型质量验收。

## Result

- 新增 `MemoryReflector.reflect(...)`，通过一个公开 Interface 封装独立 Pi session、索引式 Context、Workspace 受限读取、Frozen Activity / nmem evidence、五类受控整份替换、持久备份与整轮回滚。
- Stable Facts、Identity、Long-term Memory、Interaction Behavior 与 Background Behavior 可在各自证据门槛下同轮更新；Current Attention 保持只读。
- nmem Working Memory 与 recall 是可降级线索，不可用时仍可依靠本地 Workspace 与 Activity 完成反思。
- 模型必须完整读取六份基线和至少一份 supporting evidence；长基线按 Pi `read` 的连续 offset 机械验证完整性。
- 最终 prompt 审视确认哲学按职责分布：Memory Reflector 显式保护主体性和写作品味，事实型器官保持中性，其余器官通过各自方法保护主动、关系、私人工作和沉默。

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` — 140 tests passed
- `git diff --check`

## Source References

- Xi `src/agents/memory-reflector.ts`
- Xi `docs/utility-agents.md`
- Xi `docs/memory-cognitive-architecture.md`
- Xi 当前 `SOUL.md`、`INSTRUCTIONS.md` 与 `BACKGROUND.md` 的真实运行材料
- Loom Tickets 09, 10, 17, 18, 20, 21 and 23
