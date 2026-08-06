# 01 - Codebase review refactor candidates

Type: refactor
Status: triaged
Blocked by: 无

Triage result: see `../triage.md`. The original candidate statements remain below as the review input; the triage result is authoritative where they differ.

## 背景

2026-08-06 对 Loom codebase 做了一次以"过度防御 + 不留兼容层/最简实现/优先成熟库/不重复造轮子/着眼长期"为主旨的论审。覆盖 Runtime、Host、Instance、Configuration、Workspace、CLI 核心路径，并用子代理扫了 Cognitive Organs、Main Agent、Integrations。

总体结论：**过度防御零散且多为低危**；真正突出的是**重复实现通用功能**贯穿全仓，加两处废弃路径残留和一处开发期 Integration 的兼容迁移。

详细证据（file:line + 代码片段）见 `../research/findings.md`，截至 2026-08-06 工作区状态。本 issue 正文用域概念与模块/符号名描述，不依赖行号。

本 issue 不与 `.scratch/design-simplification/` 重叠--后者是架构/设计层简化（已 paused），明确排除"按代码目录找清理项"。候选 3 与 design-simplification 的 Technical closure 1 重叠，已在条目内标注。

## 候选清单

### 1. withoutImagePixels 双实现且行为分歧

Main Agent 的 tool-trace 与 pi-execution 各有一份同名 `withoutImagePixels`：一处递归数组和对象，一处不递归。`expand_tool_result` 走不递归版本，嵌套在数组里的 image block 不会被剥离像素，可能把完整 base64 重新注入上下文/转录。重复实现 + 行为分叉导致的实质缺陷。

**动作**：抽成单一共享函数，采用递归版本，删除不递归副本。
**严重度**：medium-high

### 2. 共享 util 模块缺失，通用 helper 散落重抄

仓内无 shared/util 模块，`isObject`（12 份）、`isMissing`/`isMissingFile`（9 份）、`errorMessage`（7 份定义 + 23 处内联）、`validateIso`/`isIsoTimestamp`（6 份）、`nonEmpty`（5 份）、`fileExists`（3 份）逐字重抄，命名还不统一。改一处逻辑要动十几处。

**动作**：落 `src/shared/`（guards / io / errors），收敛现有实现。属 wide refactor（blast radius 横跨全仓），按 expand–contract 推进：先建共享模块，逐包迁移调用点，最后删各处副本。
**严重度**：medium

### 3. 三器官 finalAssistantText 末行解析废弃路径

Memory Reflector、Attention Maintainer、Thread Maintainer 各有 `finalAssistantText` 解析模型末行 `UPDATED`/`NO_CHANGE` 约定，但调用点丢弃返回值；结果实际由写操作标志（`changedMaterials` / `replaced` / `transaction.mutated`）决定。prompt 仍要求模型输出该约定，代码解析了但不用。

**与 design-simplification 的关系**：已被 `.scratch/design-simplification/decisions.md` Technical closure 1 决策（derive outcome from durable mutations, remove UPDATED/NO_CHANGE gate），implementation paused。

**动作**：不单独推进；恢复 design-simplification 实施时一并清理末行解析（保留 `finalAssistantText` 里的 `stopReason` 检查）和对应 prompt 约定。在此记录代码层入口供对齐。
**严重度**：medium

### 4. raft-channel 保留旧 state 文件兼容迁移

Raft Channel 构造时用 `PRAGMA table_info` 探测 `delivery_order` 列并 `ALTER TABLE`，启动时从旧 `refs` 表回填 `known_destinations`。无 `PRAGMA user_version` 的探测式兼容迁移，服务"旧版本创建的 state 文件"。与 Runtime Store 的 `user_version` 结构化迁移不同。Raft Integration 尚未闭合（`.scratch/raft-channel/` 仍是当前主动工程），开发期 state schema 不稳定。

**动作**：按"不留迁移方案"，旧 state 直接作废重建；`CREATE TABLE` 已含 `delivery_order`，删探测 ALTER 与回填。Raft 未闭合，现在删零成本。
**严重度**：medium

### 5. nmem 退避双实现且分歧

threads 与 episodes 各写一份指数退避 `retryDelayMs`，`attempt=0` 时 threads 给 30s、episodes 给 15s。都 cap 60min，无功能 bug，但行为已分叉。

**动作**：抽共享 `retryDelayMs`，统一策略（随候选 2 的 shared 模块）。
**严重度**：low-medium

### 6. atomicWrite / temp+rename 重复且语义分歧

五处各自实现临时文件 + rename，只有 Workspace Mutation 的 `durableWrite` 带 fsync + 目录同步，其余四份没有。同一"原子写"工具各写一遍，且安全语义不一致。

**动作**：从 Workspace Mutation 导出共享原子写工具（含 fsync），其余四处改用。器官写入路径在 Workspace 内，安全要求一致，统一到带 fsync 版本。
**严重度**：low

### 7. nmem client 构造 / connectionHash / classify 三份重复

threads、episodes、working-memory 各自逐字重复 `NmemClient` 构造、connectionHash 计算、`classify`。

**动作**：收敛为共享工厂（随候选 2）。
**严重度**：low

### 8. life-recorder 手写 YAML frontmatter

Life Recorder 用模板字符串 + `JSON.stringify` 拼 episode frontmatter，而 nmem episodes 用 `yaml.parse` 读回。写入侧未用同一库，两侧对转义/格式有隐性约定。

**动作**：改用 `yaml.stringify`，与读取侧一致。
**严重度**：low

### 9. 过度防御零散项

单点冗余，非系统性，建议随相关模块重构顺手清，不单独立项：pi-execution 死守卫（`tool_execution_start` 末尾 return 后无代码）、tool-trace 对 structuredClone 索引失配静默 return、orientation/life-recorder 对 find 谓词已保证条件重复校验（类型收窄）、tool-trace-compactor 冗余终检、memory-reflector `validateCurrentMaterials` 二次验证非空、activity 不可达 `?? new Date(0)` 回退、raft-channel 多重回退链、raft-cli-remote handle 大小写盲目重试、weixin-adapter 检查不会发生的输入并静默丢消息。

**严重度**：low

### 10. 配置缺失返回默认而非报错

`loadInstanceConfiguration` 在配置文件缺失时返回 `defaultConfiguration`（所有 integration 关闭、机器时区、默认 schedule）而非报错。正常流程下 `loom init` 会写配置，但"配置缺失静默用默认"可能掩盖问题。

**动作**：确认是否有合理场景（如初始化前探查）；若无，改显式报错。
**严重度**：low

## 优先级

1. **候选 1**（withoutImagePixels）- 重复 + 潜在 bug，改动局部，收益最高。
2. **候选 2**（shared util）- 主线收益，wide refactor 按 expand–contract；顺带归并 5、7。
3. **候选 3**（finalAssistantText）- 不单独推进，归并到 design-simplification 恢复工作。
4. **候选 4**（raft 兼容迁移）- Raft 未闭合，现在删零成本。
5. **候选 6**（atomicWrite）- 随 shared util，统一到带 fsync 版本。
6. **候选 8、9、10** - 低危，随相关模块重构顺手清。

## Out of Scope

以下看似"重防御"但经核对对应真实场景，不在本 issue 范围：

- Model Runtime Revision 不持久化回退配置（`#active`/`#status` 纯内存态，失败 degraded/blocked，兑现"不持久化最后成功配置"决策）。
- Runtime 的 `reconcile*` lease 恢复（fencing token 乐观锁，处理崩溃后遗留 running 状态）。
- Workspace Mutation 的 before-image + journal manifest + fsync 目录同步（crash-safe）。
- Configuration 的 `assertOnlyKeys`（fail-fast 拒绝未知字段）。
- 各 Integration 网络重试/降级、status-socket unavailable 处理（边界合理处理）。

## Comments

待 triage。
