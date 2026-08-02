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

## Repository Structure

```text
src/
  runtime/          Input、时间、Turn、Effect、Delivery、恢复和调度
  main-agent/       Pi 执行、Context、Transcript、message 和工具轨迹
  agents/           Loom 内置的 Cognitive Organs
  workspace/        Agent Workspace 的访问与器官写入恢复
  instance/          Instance 装配、布局、Process Driver 与初始化
  host/             单 Instance 的 live owner
  integrations/     Local、Weixin、nmem 和附件 Adapter
  configuration/    Instance 配置、时间和模型 revision
test/               与 src/ 对应的 Node test 覆盖
docs/               ADR、工程约定和接入说明
.scratch/           当前工程协作的 map、spec 与 ticket
```

`README.md` 面向使用和部署；`CONTEXT.md` 定义稳定术语；ADR 只记录难以逆转的取舍。代码、测试和 ticket 应解释具体实现，不另写过程型文档。

## Build and Development Commands

需要 Node `>=24.15.0`。

```bash
npm run typecheck
npm test
npm run build

node dist/src/cli.js init [--root <instance-root>]
node dist/src/cli.js run [--root <instance-root>]
node dist/src/cli.js chat [--root <instance-root>] <text>
node dist/src/cli.js history [--root <instance-root>]
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

- 修改代码后先跑与风险相称的测试；完成一个工作单元时跑 `npm run typecheck` 和 `npm test`。
- 测试通过公开接口观察行为，不检查私有 SQLite 状态或 prompt 字符串。
- 模型能力、语言和写作品味用真实实例观察，不用 faux provider 测试伪造质量结论。
- 不把生产或个人 Instance Root 当测试目录；使用测试创建的临时 root。

## Configuration and Secrets

- `configuration/pi/auth.json`、Weixin `auth.json`、`.env*` 和 Instance Root `.loom/` 都是私有运行材料，不能提交、复制进 ticket、测试输出或文档。
- `loom init` 只创建 Harness-owned scaffold；Individual-owned `facts.json`、Identity、Memory 和 Attention 必须由实例提供，不能由 Harness 代写。
- 运行配置的启用状态由 `configuration/instance.yaml` 决定；不要因为包里已有 Integration 实现就假定它可用。

## Workflow and Documentation

- 一个 commit 对应一个闭合、有实质内容的工作单元。相关决定、实现、测试和必要文档一起评估；不做按文件切分的零散提交。
- 工程工作记录在 `.scratch/`。状态和文件约定见 [issue tracker](docs/agents/issue-tracker.md) 与 [triage labels](docs/agents/triage-labels.md)。
- 术语或长期边界真的改变时更新 `CONTEXT.md`；只有理由不明显且难以逆转的取舍才新增 ADR。
- 碰到新问题时先以 Loom 的当前 map 和代码为准。闭合 ticket 中的 Xi source reference 是历史证据，保留即可，不要批量维护或要求本机存在 Xi。

## Cognitive Organ Prompts

- system prompt、tool description 和首轮 run context 都是 Harness 版本化的行为设计。改动模型可见语义前，先确认职责、判断方法、工具效果和失败边界。
- system prompt 定义角色和质量；首轮 user message 提供本次 evidence 与 Workspace 索引；tool description 说明动作效果和字段语义。三者不要重复。
- 通用化不等于压短：保留器官完成职责所需的方法与例子，去掉的只是具体 Individual 的姓名、关系称谓、路径、时区和偶然 Integration 前提。
- prompt 的机械合同由 faux provider 覆盖；语言跟随、叙事质量和判断质量由真实模型观察决定。

## Further Reading

- [README.md](README.md) — 使用、部署和 Instance Root 布局
- [CONTEXT.md](CONTEXT.md) — 术语与边界
- [Harness layers map](.scratch/harness-layers/map.md) — 当前阶段、已闭合工作和下一步
- [ADR](docs/adr/) — 长期取舍
- [Integration docs](docs/integrations/) — Local 与 Weixin
