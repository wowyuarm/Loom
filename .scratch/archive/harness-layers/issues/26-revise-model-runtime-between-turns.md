# 26 — Revise Model Runtime Between Turns

Type: implementation
Status: resolved
Blocked by: None

## Problem

Loom 目前由调用方在创建 Main Agent 与 Cognitive Organ 时固定传入一个 Pi `ModelRuntime` 和一个具体 model。运行期间修改 Instance Configuration、Pi `models.json` 或认证材料不会影响后续运行；若直接对正在使用的 `ModelRuntime` 调用 `reloadConfig()`，坏配置又会先改变这个对象，无法保证当前 Turn 与上一有效配置不受影响。

这一票需要建立 Model Runtime Revision：在模型运行之外构造并验证一份新的 Pi runtime 与 role selections，成功后才原子切换。它不重新抽象 provider、认证或模型目录，也不提前实现 Instance Assembly、process driver 或模型健康策略。

## Confirmed Interface

- Instance Configuration 的 `models` 分支只表达 Harness model role 的候选顺序与 Pi thinking level。provider、模型定义、认证与 OAuth 仍由 Pi 管理。
- `models.default` 是所有 model role 的基线；具体 role 可以完整覆盖它。当前 role 是：
  - `main-interaction`
  - `main-background`
  - `tool-trace-compactor`
  - `orientation`
  - `life-recorder`
  - `attention-maintainer`
  - `thread-maintainer`
  - `memory-reflector`
- 每个 role policy 是一个非空候选数组；每个 candidate 明确给出 `provider`、`model` 与可选 `thinkingLevel`。缺省 role 继承 `default`，不做字段级合并。
- `ModelRuntimeRevisions` 的公开 Interface 是 `refresh()`、`current()` 与 `status()`：
  - `refresh()` 读取当前 Instance model policy 与 Pi-owned 配置状态，构造新的 `ModelRuntime`，并验证每个 role 的全部候选都存在且具有已配置认证；
  - 成功后一次切换整个 revision；当前调用方持有的旧 revision 对象保持有效；
  - `current()` 返回最近成功 revision；尚无成功 revision 时明确失败；
  - `status()` 暴露 `active`、`degraded` 或 `blocked`，只包含非敏感 fingerprint、时间和错误类别。
- Pi-owned `auth.json` 和 `models.json` 的内容不由 Loom 解析或保存。Loom 只用文件 identity / metadata 发现变化，具体读取、provider composition 与认证解析交给新建的 Pi `ModelRuntime`。
- 同一失败 source fingerprint 不重复建立候选或刷出多份失败；source 发生变化后才再次尝试。进程内已有 revision 时失败为 degraded；冷启动没有 revision 时失败为 blocked。

## Revision Consumption Contract

- Instance Assembly 在每次新的 Main Agent Turn 准入前调用 `refresh()`，成功或 degraded 时把 `current()` 返回的同一 revision 固定给整个 Turn。steering 继续使用该 revision。
- Main Agent 根据首个 Input 选择 `main-interaction` 或 `main-background`。Turn 内需要 Tool Trace Compactor 时，从同一 revision 取 `tool-trace-compactor`，不能再次刷新。
- Orientation、Life Recorder、Attention Maintainer、Thread Maintainer 与 Memory Reflector 在各自一次新运行开始前刷新并固定相应 role；运行中不切换。
- Assembly / process driver 负责在 blocked 时不让 Runtime claim 新 Turn，因此 pending Input 保留。具体接线属于下一票；本票不把配置状态塞进 Runtime Store，也不改变 Runtime 的通用 Agent Execution Interface。

## Failure Boundary

- Instance model policy 无效、Pi 配置错误、candidate 不存在或认证缺失属于 revision failure。
- provider 临时不可用、限流、单次 stream failure 与运行中 OAuth refresh 不使当前 revision 失效；它们属于模型调用与候选 fallback 的运行健康问题。
- revision fingerprint 不包含文件正文、密钥、token 或原始异常。错误信息经过分类后暴露；详细 Pi 配置仍只在 Pi-owned 文件中。
- 不保存跨重启的 last-known-good 配置副本。重启后必须从磁盘上的当前期望配置重新建立 revision。

## Test Seams

- Instance Configuration Interface：role policy 解析、default 继承、未知字段与非法 candidate 拒绝。
- Model Runtime Revisions Interface：首次建立、source 改变后的原子切换、坏配置保留旧 revision、同一失败聚合、冷启动 blocked，以及 role selection 的 model / thinking level。
- 测试使用真实 Pi `ModelRuntime` 与隔离的假 provider 配置；只穿过公开 Interface，不读取内部缓存，不断言密钥或实现私有状态。

## Out of Scope

- Instance Root 和所有 Module 的完整装配。
- Runtime / Scheduler 的 blocked gate 与 process loop。
- model health、stream retry、candidate fallback 和成本 / 延迟策略。
- route、channel 与 Integration 配置。
- prompt、tool description 或任何模型可见 Context 变化。

## Source References

- Xi source ticket 06 — Instance Configuration Boundary
- Xi `src/harness/agent.ts`
- Xi `src/shared/model-config.ts`
- Loom tickets 02, 08, 14, 22 and 25
- Pi SDK `ModelRuntime` and `createAgentSession` interfaces in `0.81.1`

## Result

- Instance Configuration 现在以一个 `default` candidate list 加完整 role override 表达模型政策；当前 Main Agent 两种运行场景与六个 Cognitive Organ role 都在同一严格 schema 中，未知 role、空 candidates、非法字段和 thinking level 会在装配前拒绝。
- 新增 `ModelRuntimeRevisions.refresh / current / status`。它为每份 source 建立新的 Pi `ModelRuntime`，验证全部 role candidates 的模型与认证，成功后才切换整个 revision；已持有的旧 revision 不变化。
- Instance、Pi model config、模型存在性和认证失败分别形成可观察 failure kind。已有 revision 时状态为 degraded 并继续提供旧 revision；冷启动时状态为 blocked；同一 source fingerprint 不重复尝试或刷新失败时间。
- fingerprint 只来自 Instance Configuration、Pi `auth.json` 与 `models.json` 的文件 identity / metadata，不读取、复制或持久保存凭据正文。Pi runtime 创建关闭网络 catalog refresh，因此不可达 provider 不会在配置阶段被误判。
- Pi 三个 package 一起精确升级到 `0.81.1`。全部现有 Main Agent 与 Cognitive Organ 测试继续通过，没有修改 prompt、tool description 或模型可见 Context。
- 这一票只闭合 revision Module 与后续消费合同。Instance Assembly 仍需在 Main Agent Turn 准入和每个 Cognitive Organ run 前刷新，并在 blocked 时阻止 Runtime claim pending Input。

## Verification

- `npm run typecheck`
- `npm test` — 150 tests passed
- `npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth=0`
- `git diff --check`

`npm audit` 仍报告 Pi 自己嵌套依赖树中的 `protobufjs@7.6.4` 有一个 moderate DoS advisory；同一版本已存在于升级前 lockfile，Loom 不使用其 `.proto` 解析入口，且普通 `npm audit fix` / dedupe 无法越过 Pi 的嵌套解析。没有伪造 override 或手改第三方 lock，等待 Pi 上游依赖树更新。
