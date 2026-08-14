# Loom

Loom 是面向长期协作或关系主体的 Agent Harness。一个 Runtime Instance 只承载一个 Agent Individual；Harness 提供连续性、Workspace、认知器官和可靠的对外行动条件，不内置具体个体的身份、关系或关切。

Loom 提供一个主动、好奇、独立且以人为中心的运行环境。它来自真实运行经验的通用化，仍处于持续演进中。

## 使用 Loom

安装、初始化、配置、运行和运维请交给具备主机操作权限的 Claude Code、Codex 或其他 coding agent 执行。开始前让 Agent 阅读 [`AGENTS.md`](AGENTS.md)，再按目标加载对应操作文档；不要把命令、凭据或个人 Instance 材料复制到本 README。

- [实例操作入口](docs/operations/agent-guided-instance-operations.md)
- [实例生命周期](docs/operations/reference/instance-lifecycle.md)
- [配置和凭据](docs/operations/reference/configuration-and-credentials.md)

## 文档体系

- [`CONTEXT.md`](CONTEXT.md)：稳定术语和边界
- [`docs/architecture.md`](docs/architecture.md)：模块关系与数据流
- [`docs/adr/`](docs/adr/)：难以逆转的长期取舍
- [`docs/cognitive-organs.md`](docs/cognitive-organs.md)：认知器官职责与调度
- [`docs/agents/`](docs/agents/)：规划、执行、任务记录和文档读取约定
- [`.scratch/`](.scratch/README.md)：主题在推进期间的研究和当时决策记录，不是正式文档的替代品

## Skills

Loom 使用 Matt Pocock 的 skills 方法作为可选择的工作方法。选择依据、触发条件和交付边界见 [`docs/agents/planning-workflow.md`](docs/agents/planning-workflow.md) 与 [`docs/agents/execution-workflow.md`](docs/agents/execution-workflow.md)。Skills 源码：[mattpocock/skills](https://github.com/mattpocock/skills)。

## 当前边界

Loom 面向单 Instance、前台 Host 和可选 Interaction Channel/Integration 的运行。它不替 Individual 生成身份，不默认安装 OS 服务，也不预建通用运维、评估或插件平台。具体能力和限制以 `CONTEXT.md`、架构文档、代码与测试为准。
