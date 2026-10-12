# runtime-state（② 连续性 store）模块

**Status:** v1 已实现并通过测试（`src/runtime-state/`, `tests/runtime-state.spec.ts`）。

**last-checked:** 2026-09-23

## 它是什么

一个部署的**持久本地状态**，存 session log 和 workspace 文件之外、必须扛过重启的少量事实。v1 就两样：

- **currentSession 指针**：agent 当前是哪个 session；rollover commit 时更新，boot 时读它 resume 活 agent。
- **acceptedInput 去重账本**：已持久接受的外部 Input（按 channel + providerMessageId），避免重投递被处理两次。

（原叫“连续性 store”，太抽象；按功能改名 `runtime-state`，服务 `ctx.loomState`。）

## 实现说明

- 装在 `dsh-storage` + `dsh-storage-sqlite`（后端名 `sqlite`）+ `dsh-storage-domain` 之上；domain 名 `loom_runtime_state`（domain/table 名须匹配 `/^[a-z][a-z0-9_]*$/`，故用下划线）。
- 服务 `ctx.loomState`：`getCurrentSession/setCurrentSession/isAccepted/recordAccepted`。
- 去重键用 `JSON.stringify([channel, providerMessageId])`——**不能用 NUL 分隔符**：sqlite 在 NUL 处截断键，导致重启后去重失效（durability 测试抓到过）。
- `acceptedAt` 由调用方在接受时提供，store 不读时钟（可注入时间 seam）。
- domain.close 的 effect 释放器要 `await`，否则重启前 sqlite 可能没 flush 干净。
- 测试覆盖：指针缺省/round-trip、去重（跨 channel/id 独立）、幂等、跨重启恢复（真实 sqlite 文件）。

## 覆盖的 FRAMEWORK 模块

对应 [FRAMEWORK §5](../../../active/loom-architecture/FRAMEWORK.md) 的 **连续性 store（②）** 行。是第一根竖切片里最后一块自实现的数据，① channels 与连续性模块的交汇点。

## 判定：复用 DSH `storage-domain`

读过 DSH `storage` 契约（`docs/subsystems/storage.md`）：

- `defineDomain(spec)` 声明一个域：name、version、tables（zod schema，带类型）、可选 `global` 单例槽、layout、版本兼容、坏记录处理。
- 后端两种：`json`（整文件、可读）、`sqlite`（一行一文档，频繁更新）。
- 每次调用原子、resolve 即 durable；带版本化崩溃恢复。

不自建 SQLite。原子 KV + 崩溃恢复 + 版本化正是 harness 该提供的机械保障，`storage-domain`（sqlite 后端）已经给了，自建是重造。旧 Loom 直接用 SQLite，DSH 上由 `storage-domain` 包成带类型/版本/原子的契约。

## v1 形状（砍到最小）

```
  domain "loom-continuity"（sqlite 后端）
    global  currentSession { sessionId, parentLineage? }
            ← 指针；连续性模块在 rollover commit 时 setGlobal 原子更新
    table   acceptedInput  key (channel, providerMessageId)
                           → { actor, place, visibility, route, acceptedAt }
            ← channels 消费层在接受时 putRecord；loadAll 做去重
```

Activity 也砍掉：第一个切片没有主动性、没有多活动协调，“我现在在干什么”由 session log + attention 承载。Effect/Delivery 三态推到切片外（有出站 channel 再上）。所以 v1 = **指针 + 去重账本**。

## 单一写入者

```
  currentSession 指针   ← 连续性模块（rollover commit，在 executeTransition 里）
  acceptedInput 账本    ← channels 消费层（accept 时）
```

各写各的，不交叉。

## 一致性 / 恢复

- **接受屏障**：`putRecord(acceptedInput)` resolve（durable）先于 `agent.followup`。storage-domain 保证每次调用原子且 resolve 即持久，正好满足。agent 执行失败，Input 不丢。
- **rollover 原子性**：`setCurrentSession` 是连续性模块 `executeTransition` 实现里的一步，放在“激活 successor”处。`dsh-context-continuity` 的 executeTransition 契约保证“rejects to leave the previous generation recoverable”——任一步失败整个 transition reject，指针仍指旧 session，一致。指针↔rollover 的原子性是白得的，因为 commit 的 body 本就是 Loom 写的。
- **去重跨重启**：账本持久，重启后 `loadAll` 仍查得到已接受。

## 落点

一个小 Loom plugin：boot 时 `defineDomain` + open 域，持有 domain handle，暴露 typed 服务给消费者注入（不让每个消费者各自 open，符合 DSH“一个 owner 持有、其他 inject、owner 负责 close”）。

```
  loom-continuity plugin
    open domain → 暴露 ctx.loomState:
      getCurrentSession() / setCurrentSession(...)      ← 连续性模块用
      isAccepted(channel, msgId) / recordAccepted(...)  ← channels 消费层用
```

## 依赖

- DSH `storage-domain`（`ctx.storageDomain`）+ `storage-sqlite` 后端（在 Loom bundle 里注册）。
- 被连续性模块（写指针）和 channels 消费层（写账本）注入。

## 完成条件

- 域声明 + open + typed 服务就位；sqlite 后端在 bundle 注册。
- 接受屏障：Input 接受先于 `agent.followup`，跨重启去重不重复处理。
- rollover 指针在 `executeTransition` 里原子更新，重启后据它 resume 那一个 agent。
