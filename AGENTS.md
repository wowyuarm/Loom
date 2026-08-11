# Loom Repository Guidelines

## Project Overview

Loom 是面向长期关系主体的 Agent Harness。一个 Runtime Instance 只承载一个 Agent Individual；Harness 提供连续性、恢复、Workspace 和行动条件，不内置 Individual 的身份、关系或判断。

Loom 是独立项目。Xi 可以在某个新问题确实需要历史生产经验时作为只读参考，但不是 Loom 的入口、依赖、实现说明或验收标准。

## Read First

开始工程工作时，依次阅读：

1. `CONTEXT.md`
2. 与任务有关的 `docs/adr/`
3. 对应 `.scratch/` 中的 map、spec 或 active ticket（存在时）

恢复旧工作时，以 `.scratch/harness-layers/map.md` 的当前阶段和工作项为准；涉及既有决定时做一次定向 memory 搜索。同一段工作不反复搜索，也不从闭合 ticket 的历史来源重新推导当前设计。

## Engineering Rules

- 代码应自包含地说明模块职责、关键约束和可观察行为：优先依靠清晰结构、命名、类型、接口、错误与测试；注释只说明代码无法表达的理由。
- 文档不重复实现过程，但保留术语、取舍、导航、外部接入约束、运维说明和当前工作入口。
- 一个 commit 对应一个闭合且有实质内容的工作单元，通常是一张完成的 ticket 或一个已收束的研究结论，而不是一个文件或一小段文档变化。该单元形成的决策记录、实现、测试和必要文档应一起评估并同批提交；讨论中的状态、零散笔记和中间文档先留在工作区。纯研究只有在得出可复用结论时才单独提交。
- 不预先搭建空架构或为假想需求引入层级。新依赖、运行配置和目录结构必须随第一个实际使用它的模块进入，并说明其必要性。
- 新代码必须有与风险相称的实际验证；没有运行代码时，不伪造测试或命令。

## Repository Structure

```text
src/
  runtime/          Input、时间、Turn、Effect、Delivery、恢复和调度
  main-agent/       Pi 执行、Context、Transcript、message 和工具轨迹
  agents/           Loom 内置的 Cognitive Organs
  workspace/        Agent Workspace 的访问与器官写入恢复
  channels/         Interaction Channel 抽象：Weixin 与 Raft Adapter、集合与 surface 合并
  instance/          Instance 装配、布局、Process Driver 与初始化
  host/             单 Instance 的 live owner
  integrations/     Web、nmem Adapter（非 Channel 外部服务接入）
  attachments/      Instance 级 Attachment Store：不可变内容寻址持久面
  configuration/    Instance 配置、时间和模型 revision
test/               与 src/ 对应的 Node test 覆盖
docs/               ADR、架构概览、Cognitive Organs、工程约定和接入说明
.scratch/           当前工程协作的 map、spec 与 ticket
```

`README.md` 面向使用和部署；`CONTEXT.md` 定义稳定术语；ADR 只记录难以逆转的取舍。代码、测试和 ticket 应解释具体实现，不另写过程型文档。

## Build and Development Commands

需要 Node `>=24.15.0`。

```bash
npm run typecheck
npm test
npm run build
npm run test:fast
npm run test:runtime
npm run test:host

node dist/src/cli.js init [--root <instance-root>] --channel raft|weixin [--channel raft|weixin]
node dist/src/cli.js run [--root <instance-root>]
node dist/src/cli.js history [--root <instance-root>]
node dist/src/cli.js status [--root <instance-root>] [--json] [--since <ISO timestamp>]
```

CLI 默认 Instance Root 是 `~/.loom`。开发期 `npm run build && npm link` 后可使用 `loom` 命令；重新 build 后，已运行的 Host 仍要正常重启才能使用新产物。

## Code and Architecture

- TypeScript 使用严格 NodeNext 配置；保留本地 ESM import 的 `.js` 后缀。
- Runtime 持有唯一的 Runtime Store，并编排 Input、Turn、Effect、Delivery、调度和恢复。
- Main Agent 负责 Pi 执行、Context 和 Primary Agent Transcript；Cognitive Organs 是 Harness 内置、版本化的专职能力。
- Agent Workspace 属于 Individual；Runtime Store、Transcript、Instance Configuration 和附件原始内容各自保持所有权，不把它们混成同一份状态。
- Integration 默认关闭，只有 Instance Configuration 显式启用才装配、连接或向 Agent 暴露能力。不要预建通用 plugin loader、job runner、控制面或多 Instance Host。
- `message` 先形成持久 Effect，Delivery 只投递该 Effect；不能通过重新跑 Input 或模型调用来重试外部行动。

## Testing

- 修改代码后先跑与风险相称的测试：Main Agent、配置、Workspace 改动用 `npm run test:fast`；Runtime 改动用 `npm run test:runtime`；Channel、Host、Instance 或 Integration 改动用 `npm run test:host`。跨层改动可组合运行这些档位，覆盖改动实际触及的子系统。
- 全量 `npm run test`（连同 `npm run typecheck`）只在确有充分理由时跑，**不是**每完成一个单元就默认要跑的步骤。充分理由限定为：改动横切多个子系统，或该 task 的合同/验收/复审明确要求「全量无新回归」证据。默认目标是「最窄充分」：先跑改动所在档位，跑挂再向更全扩展；分层入口用于更快定位和反馈，不替代全量验证的必要场合。
- coding 与 review agent 都不默认重复跑全量。全量是合入/release 前的一次性确认，不是每轮迭代或每张 review 的固定步骤：复审时若改动只落在单层，跑对应档位即可；只有改动确实横跨多层、或验收写成需全量时，才跑全量。
- 测试通过公开接口观察行为，不检查私有 SQLite 状态或 prompt 字符串。
- 模型能力、语言和写作品味用真实实例观察，不用 faux provider 测试伪造质量结论。
- 不把生产或个人 Instance Root 当测试目录；使用测试创建的临时 root。

## Configuration and Secrets

- `configuration/pi/auth.json`、Weixin `auth.json`、`.env*` 和 Instance Root `.loom/` 都是私有运行材料，不能提交、复制进 ticket、测试输出或文档。
- `loom init` 只创建 Harness-owned scaffold；Individual-owned `facts.json`、Identity、Memory 和 Attention 必须由实例提供，不能由 Harness 代写。
- 运行配置的启用状态由 `configuration/instance.yaml` 决定；不要因为包里已有 Integration 实现就假定它可用。

## Workflow and Documentation

- 工程工作记录在 `.scratch/`。状态和文件约定见 [issue tracker](docs/agents/issue-tracker.md) 与 [triage labels](docs/agents/triage-labels.md)。
- 术语或长期边界真的改变时更新 `CONTEXT.md`；只有理由不明显且难以逆转的取舍才新增 ADR。
- 碰到新问题时先以 Loom 的当前 map 和代码为准。闭合 ticket 中的 Xi source reference 是历史证据，保留即可，不要批量维护或要求本机存在 Xi。

## Skill Workflow

Skills 按当前问题触发，不是一张 ticket 必须走完的流程，也不要为了使用 skill 预建 map、spec、ticket 或空架构。

1. 延续 Loom 工作时，先按本文件、`CONTEXT.md`、当前 map 和 active ticket 恢复阶段；涉及既有决定时用 `search-memory` 做一次定向搜索，同一段工作不要反复搜索。
2. 只有确实需要历史生产经验时才回读 Xi 代码或运行证据，并使用 Xi 的 `runtime` skill；Xi 只是只读 source reference，不是 Loom 的入口或验收标准。
3. 需要确定 Module 的 Interface 或 seam 时使用 `codebase-design`。优先让复杂度留在深 Module 内，只为真实变化点建立 Adapter；测试穿过同一个 Interface，不直接测试内部 Store 或 SQL。
4. 术语或长期边界真正确定时使用 `domain-modeling`：立即更新 `CONTEXT.md`；只有决定难以反转、理由不明显且确有取舍时才写 ADR。
5. 实现已确认的行为时使用 `tdd`。先由现有 ticket 或已确认决定确定测试 seam，再按“一条失败测试 -> 最小实现 -> 下一条行为”推进，不先横向写完所有测试或骨架。
6. 完成一个实质工作单元后，运行真实验证，检查代码、ticket、薄文档是否一致，再一起 commit。形成长期有用的新状态或教训时使用 `distill-memory`，写入前先搜索并优先更新已有记忆；commit、路径清单和详细状态留在项目文档。

## Cognitive Organ Prompts

- system prompt、tool description 和首轮 run context 都是 Harness 版本化的行为设计。改动模型可见语义前，先确认职责、判断方法、工具效果和失败边界。
- system prompt 定义角色和质量；首轮 user message 提供本次 evidence 与 Workspace 索引；tool description 说明动作效果和字段语义。三者不要重复。
- 通用化不等于压短：保留器官完成职责所需的方法与例子，去掉的只是具体 Individual 的姓名、关系称谓、路径、时区和偶然 Integration 前提。
- prompt 的机械合同由 faux provider 覆盖；语言跟随、叙事质量和判断质量由真实模型观察决定。

## Further Reading

- [README.md](README.md) — 使用、部署和 Instance Root 布局
- [CONTEXT.md](CONTEXT.md) - 术语与边界
- [Architecture](docs/architecture.md) - 模块关系与数据流
- [Cognitive Organs](docs/cognitive-organs.md) - 认知器官职责与调度
- [Harness layers map](.scratch/harness-layers/map.md) - 当前阶段、已闭合工作和下一步
- [ADR](docs/adr/) - 长期取舍
- [Channel docs](docs/channels/) - Weixin、Raft
- [Integration docs](docs/integrations/) - Web、nmem
- [Agent-guided operations](docs/operations/agent-guided-instance-operations.md) - 实例初始化、VPS 部署与多 Individual 运维
