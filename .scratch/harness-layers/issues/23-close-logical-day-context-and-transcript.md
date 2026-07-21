# 23 - Close Logical-Day Context and Transcript Continuity

Status: resolved
Type: cross-layer context lifecycle

## Problem

Time Policy 已能为 Runtime 计算当地时间与 `recordingDay`，但 Main Agent 仍固定写入调用方给定的单个 `agent.jsonl`，`TranscriptAnchor` 不能定位所属 logical day，Context Window 明确拒绝跨 transcript session。Life Recorder 写出的 Daily Narrative 也没有正式进入 Main Agent 的 window-frozen Context。

只加入 Daily 读取会掩盖更深的恢复缺口；只轮换 Transcript 文件又会让跨日 Active Segment 无法验证、冻结和展开原始工具证据。本票把三者作为同一个跨日连续性合同闭合。

## Confirmed Direction

- Primary Agent Transcript 按 logical day 存放一份 append-only `agent.jsonl`。一个 Active Segment 和 Context Window 可以跨越多个 logical day 与 transcript session。
- Runtime 在 Turn 准入时用同一 Time Policy 固定该 Turn 的 transcript day；进行中的 Turn 和 steering 不因跨过边界而换文件。
- Transcript Anchor 必须稳定标识所属 transcript day / source、session 与 entry。Runtime 只持久保存并比较 opaque anchor；Main Agent 的 Transcript Module 负责将其解析为文件并验证分支。
- Main Agent 每个新 Turn 选择当日 SessionManager。跨日时从 committed Context messages 继续，但 Activity freeze、tool evidence expansion 和 branch verification 必须逐份读取所有被引用的 transcript，而不是把旧 entry 当作新文件的一部分。
- Context Window 开始时固定一份 Daily snapshot：当前 logical day 与前一 logical day的完整 Daily Narrative，排除 `## candidates` 及其后内容。文件后续变化不影响同一窗口；新 successor window 才重新读取。
- Daily 不做字符截断。它作为一个完整 normal Context material 参与 Planner；可以在预算取舍中整块进入或整块离开，不能留下半份叙事。
- 缺少当前或前一 Daily 不阻塞 Turn。两份都不存在时不生成 Daily Context。

## Model-Visible Daily Context

本票会改变 Main Agent Context，实施前明确采用以下语义：

- 使用中性的 `<daily_context>` wrapper 和明确 logical date，不使用具体 Individual、关系称呼、channel 或固定时区。
- wrapper 说明这些内容是在当前窗口开始时固定的过去连续性证据，不是当前请求、任务或行为指令。
- Daily 正文保持原语言和原格式；Harness 不翻译、不摘要、不插入结论。
- `## candidates` 只供后续 Cognitive Organs 使用，绝不进入 Main Agent Context。
- 只有前一日存在而当前日尚无记录时，保留前一日并明确当前 logical day 尚无 Daily Narrative；这只陈述材料状态，不暗示需要行动。

## Interface And Test Seams

- Time Policy / Runtime Interface：Turn 获得固定 transcript day，跨 boundary 的同一 Turn 不漂移。
- Primary Transcript Interface：Anchor 可定位并验证所属日的分支，tool reference 可跨日展开。
- Main Agent Context Interface：窗口首次建立时固定两日 Daily；同窗口不漂移，successor window 刷新。
- Activity lifecycle Interface：跨日 Segment 能从所有已提交 transcript branches 形成一份完整 Frozen Activity。

测试只穿过这些公开 Interface，不读取 Runtime SQLite 行，也不对 wrapper 字符串做碎片式快照断言。

## Acceptance

- 当地 logical-day boundary 前后产生的两个 Turn 分别写入正确日的 `agent.jsonl`，进行中的 Turn/steering 保持原文件。
- 跨日 Context Window 可以继续、失败恢复、压缩及展开工具证据，不信任错误日或错误 session 的 Anchor。
- 跨日 Active Segment 冻结后保留所有已提交 Turn 的真实输入、输出和工具证据。
- Daily snapshot 只含当前/前一 logical day 的完整 narrative，排除 candidates，在窗口内固定并在 successor 刷新。
- 缺少 Daily 不阻塞 Main Agent；损坏或不可读的必要 Transcript 明确失败且不消费 Input。
- 全量 typecheck、build、tests 与 `git diff --check` 通过。

## Out Of Scope

- logical-day close job、scheduler、quiet hours、pulse 或 maintenance cadence。
- Memory Reflector、Stable Facts 更新或 nmem 消费。
- Model Runtime Revision、route、hot reload、assembly、workspace init 或迁移。

## Source References

- Xi `docs/context-model.md`
- Xi `src/harness/windowed-context.ts`
- Xi source ticket 10: Primary Agent Transcript Protocol
- Loom tickets 02, 03, 06, 11, 12 and 22

## Result

Runtime 现在在领取 Turn 时用 Instance Time Policy 固定 `recordingDay`，并把该事实持久保存在 Turn 中；同一 Turn 后续接纳的 steering 沿用原归属。Main Agent 按 `transcripts/<logical-day>/agent.jsonl` 打开独立 SessionManager，`TranscriptAnchor` 与工具 evidence reference 都包含 source、session 和 entry。Context Window 保存每个在用 source 的最新已提交 Anchor，新 Turn 会逐份验证后才使用 committed Context；跨日时在新文件建立 branch，失败分支不会进入后继 Context。

Activity closure 改为按各个 completed Turn 的 Anchor 逐份读取 transcript branch，因此跨日 Segment 能保留全部已提交 Input、输出和工具证据。Recent Activity Bridge 的工具引用按事件所属 Turn 选择 source；tool trace compaction 会从当前窗口涉及的全部 transcript source 验证 raw interaction，`expand_tool_result` 也能回到旧日原文。

Agent Workspace 现在提供当前与前一 logical day 的 Daily source。Main Agent 把排除 `## candidates` 后的完整正文组成一个 `<daily_context>` message，在窗口首次建立或 successor 创建时固定；同一窗口内不重读、不截断、不翻译。只有前一日存在时会明确当前日尚无记录；两日都不存在时不生成该材料。Daily 与 recent bridge 仍作为分开的完整 normal material 交给 Context Planner。

本票没有引入 scheduler、logical-day close job、Memory Reflector、Model Runtime Revision、assembly 或迁移逻辑。

## Verification

- Runtime 测试覆盖 boundary 两侧的 Turn 归属，以及 Turn 跨 boundary 后 steering 仍沿用原日。
- Main Agent 测试覆盖每日 transcript 轮换、跨日 committed Context、失败 branch 恢复、跨日 Activity、工具压缩与旧日原文展开。
- Daily 测试覆盖两日正文、candidate 排除、窗口内固定、successor 刷新、仅前一日存在和两日都缺失。
- `npm run typecheck`
- `npm run build`
- `npm test`：132 tests passed
- `git diff --check`
