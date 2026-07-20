# 17 - Maintain Current Attention

Status: resolved
Type: implementation

## Problem

Loom 已将 `attention.md` 作为每个新 Turn 都会刷新的 Current Attention 材料，但它仍只是一个由外部预置的文件：没有 Harness 内置的 Cognitive Organ 维护它，Context Planner 也可能把它当普通 Turn-live 材料静默丢弃。

Xi 已验证 Current Attention 对跨窗口连续性有价值，但现有实现内部存在冲突：Maintainer 被允许生成远长于 Main Agent 实际注入上限的材料，导致文件后部的关系体感与自身状态可能长期不可见。Loom 需要保留这一层的意义，而不是复制固定字符截断或把它收窄成下一轮提示。

## Decisions

- 正式术语是 **Current Attention**，Workspace 路径保持 `attention.md`；不引入 `active_attention` 或 attention 状态机。
- Current Attention 是 Individual 在最近几天里无需主动回想、醒来时自然带着的中短期觉知。它回答“这几天自己自然带着什么”，不回答“下一步要做什么”。
- 它同时允许两种自然交织的内容：仍在追的方向、当前位置与核心牵引；关系底色、自身状态和节奏。它们不要求固定标题或 schema。
- 它不是 Daily 事件流、Recent Activity 重放、Opportunity、待办、行为指令、长期事实或跨时间模式分析。
- 时间尺度通常约为 2-5 天，但不是机械过期时间。是否保留取决于它是否仍会自然影响表达、方向选择、靠近、沉默或转向。
- 更新以确认、微调、增减为主。新事件只有改变当前觉知时才进入；没有变化时返回 `NO_CHANGE`，不改文件。
- 文字像 Individual 自己自然带着的觉知，不出现 Maintainer、刷新、整理或本次运行等外部器官痕迹。叙述语言跟随实际材料与 Stable Facts，引用保留原语言。
- Main Agent 在每个新 Turn 完整获得一份 Current Attention snapshot。同 Turn steering 继续使用已物化 snapshot；下一个 Turn 才刷新。Context Planner 不静默截断或丢弃它。

## Cognitive Organ Contract

Current Attention Maintainer 是 Harness 内置并版本化的 Cognitive Organ。它只维护 `attention.md`，不承担调度、长期记忆、Daily、Episode、thread 结构或行为层维护。

一次运行获得：

- 完整 Stable Facts，作为身份、称谓、归属和语言坐标；
- 当前时间以及 Agent Workspace 材料索引；
- 调用方提供的近期 Frozen Activity 索引。

首轮 Context 不预包装 `attention.md`、Daily、Memory 或 Activity 正文。Maintainer 按需读取：

- Workspace 受限 `read`、`ls`、`grep`；
- `read_recent_activity`，只分页读取本次索引中的 Frozen Activity；
- `replace_attention`，一次性原子替换完整 `attention.md`。

Maintainer 必须先读现有 `attention.md`，并检查至少一份额外的 Workspace 或 Activity 证据，才能替换或确认无变化。它没有通用 `edit` / `write`，不能修改其他 Workspace 文件。替换内容必须非空且确有变化；同一运行只能成功替换一次。

运行成功后返回 `updated` 或 `no_change`。模型、工具或最终输出失败时恢复运行前的 `attention.md`；本票不建立 Runtime pending/retry 状态。

## Interface And Test Seams

测试只穿过两个既有公开 seam：

1. **Main Agent Context Interface**：给定真实 Workspace 与小预算运行 Context Planner，观察 Current Attention 要么完整进入 provider Context，要么在硬上限前明确失败；不测试 Planner 内部排序。
2. **Current Attention Maintainer Interface**：用真实临时 Workspace 与 Pi faux provider 运行一次维护，观察最终 Context、可用工具、结果与 `attention.md`；不以 prompt 字符串断言代替模型质量。

机械测试覆盖：Workspace/Activity 读取限制、未读基线或未探索证据时拒绝写入、单次原子替换、`NO_CHANGE`、失败回滚、称谓与正文不被首轮预包装。语言跟随、叙事质地和判断质量留给后续真实模型评估。

## Out Of Scope

- 固定运行时段、pulse、logical day、quiet hours 或 scheduler 接线。
- Instance Configuration、模型选择、热加载或 retry policy。
- nmem、Working Memory 或其他 Integration。
- 默认 Workspace 模板、init、迁移或兼容导入。
- Current Attention 的固定标题、行数、字符数或 attention 状态机。
- Main Agent、Orientation 或其他 Cognitive Organ 自动同步维护 `attention.md`。

## Acceptance

- `Current Attention` 进入 Loom 术语表，且不与 Opportunity、Daily、Memory 或 Active Segment 混同。
- Main Agent 完整保留 Current Attention，不再把它当可静默丢弃的普通 Turn-live 材料。
- Maintainer 只获得确认过的五个工具，Stable Facts 位于 system prompt，首轮 user Context 只给索引与运行信息。
- Maintainer 能依据 Workspace 与近期 Activity 原子更新 `attention.md`，或在无变化时保留原文件。
- 未读基线、未探索额外证据、越界读取、空白/相同/第二次替换及 provider 失败均不会留下错误写入。
- 类型检查、构建、全量测试与 `git diff --check` 通过。

## Implementation Result

- `Current Attention` 已进入 Loom glossary，明确为跨天自然带着的中短期觉知；`active_attention`、固定格式、过期状态机和即时任务前景均未进入实现。
- Context Planner 新增必需的 Turn-live material 等级。Main Agent 将完整 `attention.md` 放入该等级，不受 normal material budget 静默裁剪；连同当前 Input 无法放入 hard context 时明确失败。
- `CurrentAttentionMaintainer` 使用独立 Pi session、完整 Stable Facts 和索引式首轮 Context。它只获得 Workspace `read` / `ls` / `grep`、受限 `read_recent_activity` 与一次性 `replace_attention`。
- 更新前必须读现有 `attention.md` 并检查额外证据。完整替换采用原子 rename；无变化返回 `NO_CHANGE`，替换后 provider 或最终输出失败会恢复原文件。
- prompt 保留显式活线与隐式体感，说明 2-5 天只是通常尺度，并把 Daily `[attention]` candidate 定义为待核实线索。模型语言与叙事质量没有被 faux-provider 字符串测试冒充。

## Verification

在 Node `24.15.0` 下通过：

- `npm run typecheck`
- `npm run build`
- `npm test`：101 tests passed
- `git diff --check`

## Source References

- Xi `src/agents/now-maintainer.ts`
- Xi `src/agents/orientation.ts`
- Xi `docs/utility-agents.md`
- Loom [04 - Bind Agent Workspace Materials to Turns](04-bind-agent-workspace-materials-to-turns.md)
- Loom [12 - Bound the Recent Activity Bridge](12-bound-recent-activity-bridge.md)
- Loom [15 - Calibrate Orientation Framing](15-calibrate-orientation-framing.md)
