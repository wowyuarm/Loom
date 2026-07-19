# Loom Repository Guidelines

## Project

Loom 是一个 Agent Harness，不承载多个 Agent Individual。每个 Runtime Instance 只承载一个 Individual；Harness 提供长期存在的条件，Individual 形成自己的身份、关系和判断。

## Read First

开始工程工作时依次阅读：

1. `AGENTS.md`
2. `CONTEXT.md`
3. 与任务有关的 `docs/adr/`
4. 对应 `.scratch/` 中的 map、spec 或 ticket（存在时）

## Engineering Rules

- 代码应自包含地说明模块职责、关键约束和可观察行为：优先依靠清晰结构、命名、类型、接口、错误与测试；注释只说明代码无法表达的理由。
- 文档不重复实现过程，但保留术语、取舍、导航、外部接入约束、运维说明和当前工作入口。
- 一个 commit 对应一个闭合且有实质内容的工作单元，通常是一张完成的 ticket 或一个已收束的研究结论，而不是一个文件或一小段文档变化。该单元形成的决策记录、实现、测试和必要文档应一起评估并同批提交；讨论中的状态、零散笔记和中间文档先留在工作区。纯研究只有在得出可复用结论时才单独提交。
- 新依赖、运行配置和目录结构必须随第一个实际使用它的模块进入，并说明其必要性。
- 新代码必须有与风险相称的实际验证；没有运行代码时，不伪造测试或命令。

## Skill Workflow

Skills 按当前问题触发，不是一张 ticket 必须走完的流程，也不要为了使用 skill 预建 map、spec、ticket 或空架构。

1. 延续 Loom 工作时，先按 Xi 的 `docs/loom-reconstruction-guide.md` 恢复阶段和 source entry；涉及既有决定时用 `search-memory` 做一次定向搜索，同一段工作不要反复搜索。
2. 回读 Xi 代码或运行证据时使用 Xi 的 `runtime` skill，把 Xi 当作只读 source reference；先确认现有事实，再决定 Loom 取舍。
3. 需要确定 Module 的 Interface 或 seam 时使用 `codebase-design`。优先让复杂度留在深 Module 内，只为真实变化点建立 Adapter；测试穿过同一个 Interface，不直接测试内部 Store 或 SQL。
4. 术语或长期边界真正确定时使用 `domain-modeling`：立即更新 `CONTEXT.md`；只有决定难以反转、理由不明显且确有取舍时才写 ADR。
5. 实现已确认的行为时使用 `tdd`。先由现有 ticket 或已确认决定确定测试 seam，再按“一条失败测试 -> 最小实现 -> 下一条行为”推进，不先横向写完所有测试或骨架。
6. 完成一个实质工作单元后，运行真实验证，检查代码、ticket、薄文档是否一致，再一起 commit。形成长期有用的新状态或教训时使用 `distill-memory`，写入前先搜索并优先更新已有记忆；commit、路径清单和详细状态留在项目文档。

## Cognitive Organ Prompts

- Cognitive Organ 的 system prompt、tool description 和首轮 run context 都是 Harness 版本化的行为设计。改动这些模型可见语义前，先对照 source implementation 中已经验证的职责、判断方法和失败经验，与用户确认需要保留、泛化或删除的部分。
- 通用化不等于压短。保留器官完成职责所需的工作方法、质量边界和有效示例；删除的应是具体 Individual 的姓名、关系称谓、固定路径、固定时区和偶然 Integration 前提。
- system prompt 定义角色、方法、判断和输出质量；首轮 user message 提供本次运行的证据与 Workspace 索引；tool description 说明每个动作的实际效果和字段语义。不要让三者互相重复，也不要用工具 schema 代替工作方法。
- faux provider 测试只验证最终 Context、工具面、读写保护和持久化等机械合同。语言跟随、叙事质量和判断质量属于真实模型评估，不用 prompt 字符串断言或脚本输出冒充。

## Git

- 使用简短英语 Conventional Commit message。
- 默认只提交当前工作产生的文件，不把无关改动混入提交。
- 不重写或回退其他人的工作。

## Agent skills

### Issue tracker

工程需求、方案和任务使用仓库内 `.scratch/` 的本地 Markdown 文件。见 `docs/agents/issue-tracker.md`。

### Triage labels

任务使用五个标准状态：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

这是单一领域上下文；术语在 `CONTEXT.md`，长期取舍在 `docs/adr/`。见 `docs/agents/domain.md`。
