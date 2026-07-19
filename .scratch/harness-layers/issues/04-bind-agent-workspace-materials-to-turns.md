# 04 - Bind Agent Workspace Materials to Turns

Status: resolved
Type: implementation

## Problem

Loom 已经能在每个 Turn 从 Runtime committed Context 重建 Pi session，但身份、长期记忆、行为材料和当前注意力仍由测试调用方作为普通 Context message 临时提供。真实 Agent Workspace 尚未成为材料来源，`systemPrompt` 也在创建 Agent Execution 时固定，无法反映 Workspace 在 Turn 之间的演化。

如果直接把这些材料继续当作普通 user message，Identity、Memory 与 Behavior 会失去 Xi 已验证的 system-level 语义，也可能被 Planner 当作可裁剪的对话历史。另一方面，若把 Workspace、Transcript、Runtime Store 和 Pi 配置继续放在同一个 `cwd` 下，又会重新制造 Xi `XI_HOME` 的混合所有权。

## Result

本票建立 Agent Workspace 的首个真实合同，并把它接入主 Agent Turn：

- 主 Agent 的 `cwd` 是 Agent Workspace root；Transcript、Runtime Store、Pi 配置与凭据由调用方从 Workspace 外部传入。
- 每个新 Turn 从固定的中性路径读取 Identity、Long-term Memory、两份 Behavior 与 Current Attention；Workspace 其他文件和目录保持自由，不参与 schema 校验。
- Harness System Guidance 继续由 Loom 源码或调用方提供，不成为 Workspace 文件。
- 每个 Turn 按 `Harness Guidance -> Identity -> selected Behavior -> Long-term Memory` 合成 system prompt。该顺序保留 Xi 当前实际层级；本票只使用结构标签，不写正式 Guidance 或材料模板。
- Current Attention 作为 Turn-live Context material；window-frozen seed、committed trace 与当前 Input 继续沿用 ticket 03 的节奏。
- interaction Turn 选择 Interaction Behavior，opportunity Turn 选择 Background Behavior。同 Turn steering 复用已经物化的 system prompt，不重新读取 Workspace 或切换 Behavior。
- 任一必要材料缺失或为空时，在 provider 调用前明确失败；本票不自动创建 Workspace、不补模板，也不生成 Identity。

## Workspace Material Paths

首版固定小型必要锚点，不提供任意路径映射：

```text
<workspace>/
  identity.md
  memory.md
  behavior/
    interaction.md
    background.md
  attention.md
```

`daily/`、`episodes/`、`threads/`、`skills/` 及未定义私人材料不属于本票的必需目录。它们在真实活动或对应能力进入时再创建；未定义材料不会被 Workspace Module 扫描、拒绝或接管。

## Interface And Test Seam

Agent Workspace 是一个深 Module。调用方只需给出 Workspace root，并按 Input kind 请求一份 Turn snapshot；调用方不需要知道固定路径、并行读取、完整性校验或 Behavior 选择规则。

验收使用两个公开 seam：

1. **Agent Workspace Interface**：给定真实临时目录与 Input kind，读取完整 snapshot；验证必要材料、Behavior 选择及明确错误。
2. **Agent Execution Interface**：运行真实 Pi faux-provider Turn，观察 provider 收到的最终 system prompt 与 Context messages；不测试 ResourceLoader 内部调用顺序。

## Acceptance

- interaction Turn 的最终 system prompt 包含 Harness Guidance、Identity、Interaction Behavior 与 Long-term Memory，不包含 Background Behavior。
- opportunity Turn 选择 Background Behavior；同 Turn 后续 interaction steering 仍使用该 Turn 已冻结的 Background Behavior。
- 修改 Identity、Memory、Behavior 或 Attention 后，下一个新 Turn 读取新版本；正在运行的 Turn 不受影响。
- Current Attention 出现在 Turn-live Context，不进入 system prompt、不写入 Primary Agent Transcript。
- window-frozen seed 仍跨 Turn 保持不变，committed trace 与当前 Input 的 ticket 03 行为不回归。
- 缺失或空的任一必要材料会在 provider 前失败，Input 不会被标记 included，也不会产生伪造 transcript evidence。
- Context Planner 使用 Pi session 最终实际的 system prompt 估算固定成本，而不是只估算调用方传入的 Harness Guidance。
- Agent Workspace 内存在未定义文件或目录不会导致校验失败。
- 现有 Agent Execution、Transcript、Context 与 Runtime 测试继续通过。

## Out Of Scope

- Harness System Guidance、Identity、Memory、Behavior 或 Attention 的正式文字与默认模板。
- workspace init、模板分发、Individual package、Xi 生产状态迁移或兼容导入。
- core/workspace/extension skills 的发现、刷新与重名拒绝。
- Cognitive Organs 的 prompt、调度、写入责任、备份、校验与回滚。
- daily、episodes、threads、window closure、recent bridge、tool-trace compaction 或逻辑日。
- Instance Root 的完整目录装配、Configuration、模型 revision、credentials 或 Integration。

## Implementation Result

- `AgentWorkspace` 以一个 root 和一个 `loadTurnSnapshot(kind)` Interface 隐藏固定路径、完整性校验与 Behavior 选择。五份必要材料每 Turn 全部读取；缺失或只有空白会给出稳定错误，未知文件与目录不参与校验。
- `PiAgentExecutionOptions` 现在显式接收 Agent Workspace 与 Harness System Guidance。主 Agent 的 `cwd` 指向 Workspace；transcript、Pi `agentDir` 与 `ModelRuntime` 继续由调用方从外部装配。
- 每个 Turn 先取得 Workspace snapshot，再以结构标签组装 Harness Guidance、Identity、selected Behavior 与 Long-term Memory。Pi loader 每 Turn 新建并使用完整 prompt override；自动 context、append prompt、skills 与 extensions 在本票路径关闭，Workspace 内 `.pi` 不成为 Pi project configuration 来源。
- Current Attention 作为首个 Turn-live Context message 参与 Planner，但不进入 system prompt、Primary Agent Transcript 或 committed trace。原有 window-frozen seed、committed trace 与当前 Input 物化顺序保持不变。
- Planner 在 Pi extensions 绑定后读取 `session.systemPrompt`，因此固定成本包含 Pi 实际加入的 system 内容，而不只包含调用方传入的 Guidance。
- opportunity Turn 使用 Background Behavior；同 Turn steering 复用已建立的 Pi session。Workspace 改动只在下一 Turn 的新 snapshot 与新 loader 中可见。

## Verification

在 Node `24.15.0` 下通过：

- `npm run typecheck`
- `npm run build`
- `npm test`：37 tests passed
- `git diff --check`

## Source References

- Xi `6608fde` `src/harness/agent.ts`
- Xi `6608fde` `src/harness/windowed-context.ts`
- Xi `6608fde` `src/shared/paths.ts`
- Xi `6608fde` `src/workspace/layout.ts`
- Xi [04 - Runtime Instance, Workspace, and Individual](../../../../Xi/.scratch/harness-generalization/issues/04-define-workspace-and-instance-semantics.md)
- Xi [05 - Harness Capability Composition](../../../../Xi/.scratch/harness-generalization/issues/05-define-harness-capability-composition.md)
- Xi [11 - Generic Language and Behavioral Quality](../../../../Xi/.scratch/harness-generalization/issues/11-specify-generic-language-and-behavioral-quality-migration.md)
- Loom [03 - Materialize Context Windows per Turn](03-materialize-context-windows-per-turn.md)
