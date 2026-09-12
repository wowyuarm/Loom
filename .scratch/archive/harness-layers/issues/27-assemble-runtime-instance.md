# 27 - Assemble a Runtime Instance

Status: resolved
Type: implementation

## Problem

Loom 的深 Modules 已分别闭合，但真实调用方仍需自行了解 Runtime Store、Agent Workspace、Primary Agent Transcript、Pi runtime、Cognitive Organs、Interaction Route 与 Scheduler 的所有构造细节。Model Runtime Revision 也尚未成为 Turn 和 organ run 的准入条件；冷启动配置失败时，直接调用 Runtime 会先 claim pending Input，再把它变成失败 Turn。

本票建立一个 Runtime Instance 的首条完整装配纵切。它负责路径、生命周期与准入，不把内部 Module 的构造参数扩散成新的浅层大构造器，也不提前实现 daemon、workspace init 或全部 maintenance cadence。

## Confirmed Interface

- `openLoomInstance(...)` 打开一个 Instance Root，返回 `LoomInstance`。
- `LoomInstance` 只公开当前宿主需要的能力：接收 Input、推进一次持久生命周期、读取组合状态和关闭实例。
- `acceptInput` 在模型配置 blocked 时仍持久接收 Input；`runOnce` 在每次可能启动模型工作前刷新 Model Runtime Revision。blocked 时不 claim Main Agent Input 或 pending Cognitive Organ work，现有 delivery、恢复与无模型 Activity closure 仍可推进。
- 每个 Main Agent Turn 固定一份 revision；interaction / opportunity 分别选择 `main-interaction` / `main-background`。同 Turn 的 Tool Trace Compactor 使用同一 revision。Orientation 与 Life Recorder 各自在一次 run 开始时固定相应 role。
- 第一纵切装配 Main Agent、Tool Trace Compactor、Orientation、Activity lifecycle、Life Recorder、Scheduler、default Interaction Route 和可选 nmem recall。Attention / Thread / Memory maintenance、nmem reconcile、process driver 与其余 cadence 后置。

## Instance Root Layout

```text
<instance-root>/
  configuration/
    instance.yaml
    pi/
      auth.json
      models.json
      models-store.json
  workspace/
  runtime/
    runtime.db
  transcripts/
    main/
    organs/
  backups/
```

路径由 Assembly 内部拥有。Agent Workspace 是 Main Agent 的 `cwd`；Configuration、Runtime Store、Transcript、备份与 Integration 状态不会成为其普通私人文件。

## Workspace Admission

- `facts.json`、`identity.md`、`memory.md` 与 `attention.md` 必须在首个 Turn 前由实例材料提供；Assembly 不生成身份、关系、长期事实或当前注意力。
- Harness 提供版本化的 Interaction / Background Behavior 初始材料，仅在对应文件不存在时创建；已有内容不覆盖。
- `daily/`、`episodes/`、`threads/` 和未知私人目录继续惰性生长，不预造历史或封闭 Workspace schema。
- Harness System Guidance 固定在源码中，不进入 Workspace，也不能被 Individual 或 Cognitive Organ 改写。

## Configuration

- `instance.yaml` 新增可选 `interaction.defaultRoute`，值是不透明、非空的 Interaction Route reference。
- route 不含人的名字、关系含义、channel target 或凭据。没有 route 时 Main Agent 不获得 `message`；已持久 Effect 始终保留创建时的 route。
- Pi provider、模型与认证继续由 `configuration/pi/` 下的 Pi-owned 文件管理。

## Model-visible Semantics

Harness System Guidance 保留并通用化 Xi 已验证的核心：持续 AI Individual 的事实、证据与分层 Context、私人活动、主动与沉默、关系关切但不镜像、按需查证与 recall、`message` 的唯一外部可见性，以及 skills 只是做事方法。它不包含具体名字、称谓、时区、channel、关系历史或某个 Individual 的表达习惯。

两份初始 Behavior 只提供场景骨架：interaction 是关系中的真实互动而非默认任务；background 是 Individual 自己的时间且 Opportunity 不是命令。具体语言、称谓、声线、兴趣和关系方式仍由 Workspace 材料形成，并可由 Memory Reflector 基于证据演化。

## Test Seam

测试只穿过 `LoomInstance`：

- 冷启动 blocked 时仍接受 Input，`runOnce` 明确 deferred，Input 保持 pending；修正配置后同一实例继续完成该 Turn。
- 一个有效实例能从实际 Workspace、Configuration 与 Pi faux provider 完成 Main Agent Turn，并通过 Instance status 观察到 committed Runtime 结果。
- default route 使 `message.send` 形成持久 Effect；没有 route 时不暴露 `message`。
- 缺少 Individual-owned 必要材料时，在 provider 前失败；默认 Behavior 只补缺失文件且不覆盖已有内容。
- close 释放所有持久资源；测试不直接查询 SQLite、内部 Store 或 revision cache。

## Out of Scope

- daemon / forever loop、signal handling、CLI、workspace init 或分发格式；
- channel endpoint 配置格式与具体生产 Adapter；
- model health、candidate fallback、stream retry 或成本策略；
- Attention / Thread / Memory cadence、nmem Episode / Thread reconcile 与 nightly；
- soft segment split、after-chat continuation、生产 Xi 迁移、Git backup；
- 真实模型的主动性、关系感、语言与写作品味验收。

## Source References

- Xi source tickets 04, 06, 07, 08 and 09
- Loom Tickets 04, 13, 14, 19, 22, 23, 24, 25 and 26

## Result

- 新增 `openLoomInstance`，用 `acceptInput / runOnce / formOpportunity / status / close` 这一组小型 Interface 装配 Runtime、Main Agent、Context、Primary Agent Transcript、Tool Trace Compactor、Orientation、Activity lifecycle、Life Recorder、Scheduler、default Interaction Route 与 failure-soft `nmem_recall`。
- Instance Root 的 Configuration、Agent Workspace、Runtime Store、主/器官 Transcript 和 backups 已由 Assembly 统一定位。打开实例只补缺失的两份 Harness-owned Behavior 初始材料，不生成或覆盖 Individual-owned Identity、Stable Facts、Long-term Memory 与 Current Attention。
- Harness System Guidance 固定在源码中，并以已确认的通用语义保留持续 AI Individual、证据边界、私人活动、主动与沉默、关系关切但不镜像，以及 `message` 的唯一外部可见性。Interaction / Background Behavior 只提供场景骨架。
- `interaction.defaultRoute` 现在是严格校验的可选非空 route reference。有 route 时 Main Agent 获得 `message` 并把 route 固定进持久 Effect；无 route 时不暴露该工具。
- `openLoomInstance` 返回前即建立可观察的 model revision 状态。每次可能启动模型工作前刷新 revision；blocked 时 Input 保持 pending，Activity 可以无模型冻结，Recorder 不会被 claim，而已持久 Effect 的 Delivery 继续推进。配置修复后同一实例可恢复 pending Turn 或 Recorder work。
- Main Agent 按 interaction / opportunity 选择 model role，同 Turn 的 compactor 固定同一 revision；Orientation 与 Life Recorder 每次运行固定各自 role。Pi thinking level 随 selection 进入实际 session。

## Verification

- `npm run typecheck`
- `npm test` — 161 tests passed
- `git diff --check`
- 本地 OpenAI-compatible faux provider 已穿过公开 `LoomInstance` 验证 Main Agent、message Effect、blocked recovery、Life Recorder、Orientation 与实际 Pi request。
