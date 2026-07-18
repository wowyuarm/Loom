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
- 一个 commit 只承担一个可解释、可验证的变化；不要预先搭建空架构或为了假想需求提前引入层级。
- 新依赖、运行配置和目录结构必须随第一个实际使用它的模块进入，并说明其必要性。
- 新代码必须有与风险相称的实际验证；没有运行代码时，不伪造测试或命令。

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
