# Loom Repository Guidelines

## Project

Loom 是面向长期关系主体的 Agent Harness。一个 Runtime Instance 只承载一个 Agent Individual；Harness 提供连续时间、Workspace、认知器官和可靠的对外行动条件，但不内置 Individual 的身份、关系或判断。

## Read first

所有在本仓库工作的 Agent 先读：

1. 本文件；
2. `README.md`，了解项目定位和文档入口；
3. `CONTEXT.md`，了解稳定术语和边界；
4. 与当前任务直接相关的 `docs/`；
5. 任务明确引用的代码、测试和工作记录。

按需要继续阅读：

- 规划、研究、问题收敛：[`docs/agents/planning-workflow.md`](docs/agents/planning-workflow.md)
- 实现、验证、交接：[`docs/agents/execution-workflow.md`](docs/agents/execution-workflow.md)
- TypeScript 实现：[`docs/agents/typescript-conventions.md`](docs/agents/typescript-conventions.md)
- 测试选择与证据：[`docs/agents/testing-policy.md`](docs/agents/testing-policy.md)
- 生命周期、并发、进程或文件删除：[`docs/agents/defensive-patterns.md`](docs/agents/defensive-patterns.md)
- 本地问题记录格式：[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- 任务状态：[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)

不要因为文件存在就通读整个仓库。先看入口和当前状态，再按问题展开。归档记录和旧讨论默认不读，除非任务需要追溯。

## What is authoritative

- 当前行为：代码、测试和真实运行状态。
- 稳定设计：`README.md`、`CONTEXT.md`、`docs/` 和已接受的 ADR。
- 进行中的设计：任务合同和明确引用的 `.scratch/<topic>/` 记录。
- 协作过程：讨论面、评审、部署和验收记录。

`.scratch/` 是某个主题当时的研究和决策记录，不是持续维护的第二套产品文档。后续演化不回写旧的历史判断；稳定结论进入正式文档，旧记录保留作历史或按主题清理。新主题按真实代码边界建立，不能预建空目录。

## Universal engineering rules

- 任务范围、依赖、完成证据和授权不清时，先指出缺口，不把猜测写成代码。
- 修改共享代码前使用独立 worktree；不得覆盖其他人的未合入改动。
- 一个提交对应一个闭合工作单元。交付时说明提交、验证结果、剩余边界和下一位动作。
- commit message 使用简短的一行英语叙述即可。
- 代码改动必须运行与风险相称的真实验证；没有运行就不要声称通过。
- 测试是行为证据，不是产品合同本身；旧测试与已确认行为冲突时修正测试，不为通过测试扭曲正确逻辑。
- 不提交凭据、个人 Instance Root、运行数据库或其他私有材料。
- 实现、合并、部署、迁移和产品验收是不同动作；没有明确授权不得越过下一道边界。
- 不过度防御或过度设计。只处理已经存在、边界上合理可预见，或一旦发生会造成明显损失的问题；能用现有结构直接解决，就不增加抽象、配置、兼容层、回退路径或通用框架。

## Skills

Skills 是按问题选择的方法，不是每张任务必须走完的流水线。Matt Pocock skills 的使用条件和产出见两个 workflow 文档；Loom 的任务合同和当前协作约定优先于通用 skill 的默认流程。

## Repository map

```text
src/              Runtime、Main Agent、Cognitive Organs、Workspace、Channels、Instance、Host、Integrations
test/             与 src 对应的行为测试
docs/             稳定术语、架构、ADR、接入和 Agent 工作约定
.scratch/         主题研究、当时的设计和本地实施票
```

模块职责、测试入口和运行操作按需从 `docs/` 加载；不要把易漂移的命令、实现细节或个人材料复制进本文件。
