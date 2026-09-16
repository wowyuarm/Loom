# Loom Repository Guidelines

## Scope and authority

Loom 是面向长期关系主体的 Agent Harness。一个 Runtime Instance 只承载一个 Agent Individual；Harness 提供连续时间、Workspace、认知器官和可靠的对外行动条件，但不内置 Individual 的身份、关系或判断。

Use this authority order:

1. **Current behavior:** 代码、测试和真实运行状态。当文字与代码不一致时，以代码为准。
2. **Stable design:** `README.md`、`CONTEXT.md`、`docs/` 和已接受的 ADR。
3. **Work in progress:** 任务合同和明确引用的 `.scratch/<topic>/` 记录。
4. **Collaboration history:** 讨论面、评审、部署和验收记录。

`.scratch/` 是某个主题当时的研究和决策记录，不是持续维护的第二套产品文档。正在推进的主题放 `.scratch/<topic>/`，收口后移进 `.scratch/archive/<topic>/`；后续演化不回写旧的历史判断，稳定结论进入正式文档，旧记录保留作历史或按主题清理。新主题按真实代码边界建立，不能预建空目录。工作规则见 [`.scratch/AGENTS.md`](.scratch/AGENTS.md)。

## Reading guidance

- Start from the task: 先读任务合同和它明确引用的代码、测试、工作记录，再按缺口展开；不要因为文件存在就通读整个仓库。
- `README.md` 只在需要项目定位和文档入口时读，`CONTEXT.md` 只在任务触及稳定术语和边界时读；归档记录和旧讨论默认不读，除非任务需要追溯。
- `docs/agents/` 的 workflow 文档按问题取用，不是每张任务的必经流水线：规划、研究、问题收敛见 [planning-workflow](docs/agents/planning-workflow.md)；实现、验证、交接见 [execution-workflow](docs/agents/execution-workflow.md)；TypeScript 见 [typescript-conventions](docs/agents/typescript-conventions.md)；测试选择与证据见 [testing-policy](docs/agents/testing-policy.md)；生命周期、并发、进程或文件删除见 [defensive-patterns](docs/agents/defensive-patterns.md)；问题记录格式见 [issue-tracker](docs/agents/issue-tracker.md)；任务状态见 [triage-labels](docs/agents/triage-labels.md)。
- Skills 也是按问题选择的方法，不是每张任务必须走完的流水线；Loom 的任务合同和当前协作约定优先于通用 skill 的默认流程。

## Guardrails

- 任务范围、依赖、完成证据和授权不清时，先指出缺口，不把猜测写成代码。
- 修改共享代码前使用独立 worktree；不得覆盖其他人的未合入改动。
- 不提交凭据、个人 Instance Root、运行数据库或其他私有材料。
- 实现、合并、部署、迁移和产品验收是不同动作；没有明确授权不得越过下一道边界。
- 不过度防御或过度设计。只处理已经存在、边界上合理可预见，或一旦发生会造成明显损失的问题；能用现有结构直接解决，就不增加抽象、配置、兼容层、回退路径或通用框架。

## Conventions

- 代码风格见 [typescript-conventions](docs/agents/typescript-conventions.md)：命名、类型和结构自解释，注释只写代码看不出的约束、原因和安全条件。
- 非平凡改动若改变公开合同或工作流，同步更新受影响的正式文档和测试；不为迎合新代码回写已归档的 `.scratch/` 材料。
- 一个提交对应一个闭合工作单元。交付时说明提交、验证结果、剩余边界和下一位动作。
- commit message 使用简短的一行英语叙述，格式为全小写 `type(scope): 描述`（如 `feat(runtime): …`、`fix(thread-maintainer): …`、`docs: …`），描述小写开头；type 取 feat、fix、docs、test、refactor、chore、scratch，scope 缺省可省略。
- 测试是行为证据，不是产品合同本身；旧测试与已确认行为冲突时修正测试，不为通过测试扭曲正确逻辑。

## Checks

- 代码改动必须运行与风险相称的真实验证；没有运行就不要声称通过。先跑覆盖改动面的最小检查，再按风险扩大；测试取舍见 [testing-policy](docs/agents/testing-policy.md)。

## Repository map

```text
src/              Runtime、Main Agent、Cognitive Organs、Workspace、Channels、Instance、Host、Integrations
test/             与 src 对应的行为测试
docs/             稳定术语、架构、ADR、接入和 Agent 工作约定
.scratch/         主题研究、当时的设计和本地实施票
```

模块职责、测试入口和运行操作按需从 `docs/` 加载；不要把易漂移的命令、实现细节或个人材料复制进本文件。
