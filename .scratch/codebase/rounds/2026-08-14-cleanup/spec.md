# Loom Codebase Cleanup Round 2026-08-14

Status: ready-for-agent

Baseline: `01a3f8a` · 证据：`research/ponytail-audit.md` · 深化候选（不在本 spec 内）：`research/deepening-candidates.md`

## Problem Statement

Loom 经过多轮建设后积累了一批不在任何行为路径上的表面积：未被引用的验证脚本、零调用方的死方法、零导入方的孤儿类型导出、被解析但从不消费的配置路径，以及几处纯复制的小段实现。维护者阅读代码时要为这些死面消耗注意力，改契约时不确定「这里还有人用吗」；执行 Agent 也要为不存在的消费者保留兼容。清理的目标不是改行为，而是让代码表面积收缩到真实使用。

## Solution

执行一轮经逐条复核的裁剪清单：删除死代码与孤儿导出，折叠空 interface 与重复映射，把被误分类的运行时依赖归位。所有裁剪不改变任何公开行为的语义；删除项都经过「零调用方/零导入方」验证。清单共 14 条裁剪 + 1 条依赖归类修正 + 第二轮 9 条 conventions 修正，净约 -240 行；被审查后拒绝的候选（行为不等价或 borderline）记录在审计证据里，不在本 spec 执行。

## User Stories

1. As a Loom maintainer, I want dead methods and orphan type exports removed, so that reading a module only shows what actually runs.
2. As a Loom maintainer, I want duplicated row-mapping and missing-material handling to have one source, so that a fix in one place cannot silently diverge from the other.
3. As an implementation agent, I want the Configuration parse surface to contain only consumed fields, so that adding or changing a key never has to guess which parse path is authoritative.
4. As an operator, I want `loom` production installs to resolve every runtime import, so that a dependency-pruned install does not fail at startup.
5. As a maintainer, I want the unreferenced verification script removed, so that the scripts directory only contains entry points someone can actually invoke.
6. As a test author, I want tests to target only behaviours that production code exercises, so that deleting a dead production path does not leave tests that assert on nothing real.
7. As a future reviewer, I want rejected audit candidates recorded with their reasons, so that the next cleanup round does not re-derive them.

## Implementation Decisions

- Delete the unreferenced verification script（已确认删除，不进 scratch 归档）。
- Delete `CognitiveOrganExecution` 的 `nextDue` 方法及其专属测试块；Cognitive Organ retry 节奏继续由 attempt/lease 路径决定，本清理不引入任何替代调度语义。
- Remove the Configuration 侧 workspaceMirror 解析链路（interface、parser、allowed-keys 条目与组装字段）；同时把白名单校验（四个允许字段、未知字段拒绝）移入镜像脚本，保持文档承诺的 fail-fast 合同不变——不能删除校验而不补位。instance.yaml 的 workspaceMirror 键继续由镜像脚本解析。
- Delete the unused Orientation 默认常量。
- Remove or un-export the orphan type surfaces in Attention Maintainer and Memory Reflector；规范类型继续由 Runtime 的公共类型模块提供。
- Remove the empty Pi execution result interface and use its base type directly.
- Un-export the Pi context message alias and the Orientation options interface；它们的内部使用不变。
- Delete the dead Life Recorder type alias.
- Collapse the empty Weixin configured-options interface to its base；Raft 的同名 configured options 有真实差异字段，保持不变。
- 让 Cognitive Organ 的当前工作读取委托给已有的单行记录映射，而不是重编码一份。
- 把 Memory Reflector 工具包装里两个相同的 missing-material 分支收敛为一个局部 helper。
- 内联单调用点的错误消息辅助函数。
- 把 nmem 启用判定在构造时计算一次，替换三处重复判定。
- 把 typebox 从 devDependencies 移入 dependencies；不升级版本。

第二轮（conventions lens，依据 docs/agents/typescript-conventions.md / testing-policy.md / defensive-patterns.md，证据见 research/conventions-audit.md）：

- 删除 Memory Reflector 的冗余非空复核循环（loadBaseline 已抛完所有可能）。
- 简化 Orientation 对 find 谓词已收窄值的重复校验。
- tool-trace 的 expanded-interaction 替换在静态不可能状态上静默 return——统一为与 raw 路径一致的 throw。
- 移除 activity bridge 的不可达 fallback，改用非空断言表达静态保证。
- 删除 Tool Trace Compactor 的冗余终检。
- 给 Channel surface 合并处吞掉异常的一处 catch 补注释（吞掉的具体失败与为何不影响权威状态）。
- 给 Weixin ingress 的丢弃条件补注释（wire 边界过滤策略：非 peer / 非 user / 非 finished / 无内容的 incoming 不构成 Input）。
- 删除 system-guidance 测试的 8 个自引用断言；若保留指引覆盖，改为经真实装配断言一次。
- Cognitive Organ Runtime 测试的 DB 复读与 status 投影去重，只保留 DB 特有的 model_revision 断言。

## Testing Decisions

- 好测试只观察外部行为；本轮是删除型改动，测试面就是删除前后的现有分层入口：
  - `npm run test:fast`（agents / main-agent / workspace / configuration / channels 解析）
  - `npm run test:runtime`（runtime，含 cognitive-organ-execution）
  - `npm run test:host`（channels / cli / host / instance / integrations）
- 类型与脚本删除不引入新测试；删除 nextDue 时同时删除其专属测试块。
- Configuration 解析测试中 workspaceMirror 相关断言随解析链路一起移除，其余键的断言保持。
- 第二轮的测试条目同样落入现有分层入口；不新增测试，除非为 system-guidance 补一条真实装配断言。
- 完成证据：typecheck 通过 + 上述分层测试通过 + git diff 只含清单内条目。
- 先例：上一轮 design-simplification 的实现验证同样以「typecheck + 分层测试 + diff 检查」为完成证据，不伪造测试。

## Out of Scope

- 深化候选（Runtime 器官 driver、调度快照、器官 session helper、Thread Maintainer 写路径、withoutImagePixels 合并、tool-trace 拆分等）——另见 deepening-candidates，不并入本 spec。
- 全仓 generic-utils sweep 与共享 atomic-write util——triage 已拒绝，维持。
- Scheduler interface / createScheduler 工厂与 nextRunId 测试 seam——borderline 项，不在本轮盲裁，留后续 grilling。
- 任何 Store 抽象、通用框架、行为语义改变与性能改动。
- 生产部署与实例迁移。

## Further Notes

- 每一条裁剪都已在审计证据中附 file:line 与复核结论；执行时若发现某条与当前工作区不符（例如出现了新调用方），停止该条并升级，不猜测。
- 执行 Agent 使用独立 worktree；一个提交对应本 spec 的闭合工作单元；交付报告包含提交、验证结果、剩余边界与下一位动作。
- **开放问题（待 YuCreate 决定）**：workspaceMirror 的 intervalMinutes 字段目前没有任何消费者——TS 解析校验它、mirror.mjs 不读它、轮询节奏由 systemd timer 硬编码 30 分钟（docs/integrations/workspace-mirror.md）。白名单校验移入 mirror.mjs 时，该字段要么随文档一起删除（timer 节奏由 operator 管理），要么在文档注明它只是约定值。执行前先确认，不猜测。
- 本 spec 由 2026-08-14 cleanup round 产生；后续清理另开新 round，不回写本文件。
