# 装配·persona 模块

**Status:** active（设计收敛，尚无实现）

**last-checked:** 2026-09-21

## 覆盖的 FRAMEWORK 模块

对应 [FRAMEWORK §5](../../../active/loom-architecture/FRAMEWORK.md) 的 **装配·persona** 行。把前面四块数据（①②③④）黏成一个能启动、能重启续上、只跑一个 agent 的 Loom。

## 四件事

### 1. boot / reattach（机制已确认）

DSH `ctx.agents.resume({ resumeSessionId })` / `create({ sessionId })` 把存量 session 恢复成活 agent。agent-team 跑 N 个持久 member 用的就是这个（`persisted ? resume : create`），Loom 是 N=1。

```
  boot:
    读 ② currentSession 指针
      有  → ctx.agents.resume({ resumeSessionId })      续上那一个 agent
      无  → ctx.agents.create({ sessionId, meta })       首次，创建第一个 session
```

### 2. 单活锁（不单独造锁）

真正的锁是 DSH session-persistence 的**跨进程写租约**（persistence.md：“the cross-process write lease”，第二次 open 抛 `SessionAlreadyOwnedError`）。

```
  boot: agents.resume(...)
    成功          → 我是这个部署唯一的活 Individual → 起 channels 消费
    AlreadyOwned  → 另一个进程已经是活的 → 中止 boot，不起 channels
```

关键纪律：**channels 消费层必须在 agent 确认活起来之后才启动**，否则抢输的进程可能先收消息、写 ②、followup，却没有它的 agent。② 的并发写安全搭在租约上（只有持有 agent 的进程写 ②），不用给 ② 另加锁。

### 3. persona / identity（落在 DSH 真实槽上，且必须中立）

`system-prompt` 有一等的 deployment persona 槽：`PERSONA_PREFIX_SECTION`（`deployment:persona-prefix`）/ `PERSONA_SUFFIX_SECTION`。DSH 本就把“部署给的 persona”和“运行时 context provider”分开。

```
  中性 persona（连续 agent、你有这些器官、你能自发行动——只讲机制）
      → deployment:persona-prefix 段（部署/Loom 写）
  心智引导（记忆/注意力/线程怎么运作）
      → 额外 harness .section()，排在 persona 之后
  identity.md（“我是谁”）
      → context provider（材料层的 identity，动态）
  memory/threads/attention → 其余 context providers
```

**硬边界（Loom 核心原则落到装配层）**：deployment persona 必须**身份中立**——只描述连续 agent 的机制，绝不说“你是谁、你要好奇、你要主动”。所有“我是谁、我在乎什么”只在 agent 自己写的 identity.md 里。persona 段一旦写进人格/价值，就是 harness 替 Individual 定身份，违反“harness 只提供条件、不提供身份”。

这解掉了 FRAMEWORK §7 挂的“身份类分槽”：两个槽、两个作者（persona 是 harness 的中性框架，identity.md 是 agent 的自我），不打架。

### 4. Loom bundle = 应用本身

loom-next 就是这个 profile/bundle：

```
  自有 plugins：连续性(dsh-context-continuity) · 材料 · channels 消费 · 连续性 store(②) · persona 段
  复用 DSH：session · agent-loop · storage-sqlite · system-prompt · workspace/fs
            · agent-instructions(workspace/AGENTS.md) · approval · sandbox · compaction · skills
```

装配层贡献：**一个中性 persona 段 + 心智引导段 + 一个 Loom agent 配置**（`agentPreset` 管权限/工具范围，Loom 只有一个）。材料/工具/② 由各自 plugin 在 bundle 里贡献，不塞进 preset。

## 关于“主动、好奇、独立、以人为核心”这类色彩定位

结论：**不在 persona 层规定这些。** 它们是设计取向，不是给个体规定的人格（旧 Loom README/CONTEXT 也是这么落的：“以…为设计取向，但不内置某个具体个体”）。让机制促成，不靠 prompt 硬写。

- 好奇 / 独立 / 以人为核心：主要是**倾向**（identity.md，agent 自己写）+ **已具备的能力**（材料、threads、私人工作线）。
- **主动**：需要真实机制（pulse / 机会识别），是被 defer 的**主动性模块**卡着的能力。没有机制，写“你要主动”也没用。

这类设计取向具体怎么在 loom-next 兑现（是否采用某种器官/文档形态），到主动性模块再深入，本模块不预设。

## 完成条件

- boot 读 ② 指针 → resume-or-create 一个 agent；AlreadyOwned 则中止、不起 channels。
- 中性 persona 段 + 心智引导段就位，identity.md 走 context provider，两槽不重叠。
- Loom profile/bundle 能把自有 plugins + 复用 DSH 装配起来跑通第一根竖切片。
