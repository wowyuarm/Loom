# Loom 整体框架

**Status:** 框架草案，供逐模块展开。落地后稳定结论迁入 `docs/`。
**last-checked:** 2026-09-21

本文是全局骨架：Loom 由哪些模块构成、每份数据谁写、哪些复用 DSH、哪些自实现。每个模块的详细设计各自一篇（见 §8）。

---

## 1. 范围

Loom 是一个跑在 DSH 上的 agent 部署，一个部署只跑一个长期 agent。DSH 提供模型执行、session、工具、文件访问等基础设施。Loom 在其上补三样 DSH 没有的东西：

1. 让 agent 跨 session 连续运行（session 会满、会 rollover）；
2. 记录对外动作在世界里的真实状态（发出去了没、对方收到没）；
3. 让 agent 维护自己的长期材料（identity / attention / memory / threads）。

Loom 不内置 agent 的身份内容，只提供运行条件、数据所有权和约束。

## 2. 两类数据

Loom 的数据分两类，处理方式不同：

```
  自动记录    session log、收到的 Input、对外 Effect 的状态
              系统自动写下，agent 不出力，逐字、append-only
  agent 维护  identity / attention / memory / threads
              agent 用工具主动写，少量、可重写
```

划这条线，是为了不把"实际发生了什么"和"agent 写下的理解"混进同一份数据。召回历史查自动记录（session search），需要长期结论读 agent 维护的材料。

## 3. 数据所有权

五份数据，每份只有一个写入者，其它模块引用、不复制：

| # | 数据 | 写入者 | 内容 |
| --- | --- | --- | --- |
| ① | 外部世界 | channel | 收到的 Input、尝试的 Delivery |
| ② | 连续性 store | Loom continuity | Input 已接受、Effect、Delivery 状态、Activity、恢复 |
| ③ | workspace 材料 | agent（经工具/裸 fs） | identity / attention / memory / threads |
| ④ | 模型执行 | DSH session | 模型看到/做过什么、surface、compaction |
| ⑤ | 只读投影 | 无（派生） | GUI/status，从 ①-④ 重建 |

一条贯穿的约束：**模型输出不等于世界结果。** 对外动作先在 ② 落一条 Effect，Delivery 是 ① 里一次独立的尝试，结果未知时不盲重发；④ 里的 assistant 文本不能当作 ① 的世界结果。

## 4. 运行时分层

依赖从下往上：

```
  装配层     Loom profile + bundle · 中性 persona · 醒来 bundle 注入 · 单活锁
  Loom 域    连续性 store（②） · 材料/记忆（③） · channels（①） · 主动性（后续）
  连续性     @wowyuarm/dsh-context-continuity（epoch / rollover / checkpoint / 召回）
  DSH infra  agent-loop · session（④） · system-prompt · tools/fs/approval/sandbox · compaction · skills
  反射        jev（快模型）横切：召回重排 / 写入路由 / 机会——只提议、不改状态
```

## 5. 模块分解

每一行是后面要单独展开、落一篇 subsystem 文档的模块。加粗的是 Loom 自实现的部分，其余复用 DSH。

| 模块 | 数据 | DSH 姿态 | 拥有什么 |
| --- | --- | --- | --- |
| 模型执行 | ④ | 复用 `agent-loop` | 模型 turn/step 循环 |
| session 记录 | ④ | 复用 `session` | append-only 日志 |
| 连续性（epoch/召回） | ④+② | 复用 `dsh-context-continuity` | rollover / checkpoint / timeline / search |
| **连续性 store** | ② | **自实现**（复用 `storage-domain`） | v1：currentSession 指针 + Input 去重账本（Effect/Delivery/Activity 推后） |
| **材料·记忆** | ③ | **自实现**（投影自写 `context()` provider） | identity/attention/memory/threads + memory 工具 + 投影 + 预算 |
| 醒来 bundle 装配 | ③→④ | 复用 `system-prompt` | 常驻投影顺序（每材料一个 context() provider） |
| **channels** | ① | **多半自实现** | Input 接收/去重/接受、Effect→Delivery 三态、幂等 |
| Workspace/fs · approval · sandbox | ③/世界 | 复用 + Loom policy | 文件与电脑访问的授权边界 |
| compaction | ④ | 复用（经 context-continuity） | surface 压缩 |
| **主动性**（后续） | 跨 ② | **自实现** + jev | pulse / 机会 / 节律 |
| **装配·persona** | — | Loom profile/bundle | 中性 persona 段 + 心智引导段 + 一个 agent 配置；boot resume/create；单活靠跨进程租约 |
| 投影（GUI/status） | ⑤ | 复用 DSH web / 自建 view | 只读重建 |
| jev 反射 | 横切 | 可插入端口 | 召回重排（先）、写入路由/机会（后） |

## 6. 第一个切片的边界

先做一条最窄的完整路径，不一次铺开：

```
  切片内：一个 agent + 一个 channel，能收一条 Input、执行、写材料、跨 rollover 连续运行
    ④ 记录       session + context-continuity（复用）
    ③ 材料       identity/attention/memory/threads + memory 工具 + 醒来 bundle 投影（自实现，核心）
    ② 连续性     v1 只要：currentSession 指针 + Input 去重账本（Activity/Effect/Delivery 推后）
    ① channel    一个真实传输（telegram 第一个）走完整 ingress：去重 → 接受 → followup
    反射         jev 先只接召回重排（可选）
  切片外（后续工作项）：主动性、多 channel、完整 Effect/Delivery 三态、独立投影 view
```

## 7. 开放问题（已收敛的已删）

- **channel 的 Effect/Delivery 三态**：delivered / not-sent / unknown 怎么落、恢复怎么 reconcile。（切片外）
- **主动性**：pulse / 机会识别 / 节律，以及“主动、好奇、独立、以人为核心”这类设计取向具体怎么在 loom-next 兑现（是否采用某种器官/文档形态）。专开一个模块深入。
- **eval seam（现在就要定死）**：为了能评测连续性/主动性，harness 必须能被脚本驱动：**时间可注入**（不到处 Date.now）与 **Instance Root 可一致性快照/恢复**（sqlite ② + session log）。不定，第二层评测做不了。详见 [`verification-and-eval.md`](verification-and-eval.md)。

## 8. 如何展开

每个模块按固定框架讨论，讨论清了直接落地：

```
  模块：<名字>
  ├─ Loom 需要它做什么
  ├─ 候选 DSH plugin：读它真实契约
  ├─ 判定：复用 / 复用+扩展 / 参考自实现 / 纯自实现
  ├─ 若自实现：唯一写入者、持久面、service/event、模型可见投影、恢复、依赖
  └─ 落点：哪个包、贡献什么 service/event/tool
```

各模块详细设计：

- **DSH 集成地图**（每个模块对应的真实 DSH ctx API/service/event）→ [`dsh-integration-map.md`](dsh-integration-map.md)

- **材料·记忆 + 连续性召回** → [`../../archive/2026-10/continuity-and-memory/`](../../archive/2026-10/continuity-and-memory/README.md)（已落地归档）
- **channels（①）** → [`../../archive/2026-10/channels/`](../../archive/2026-10/channels/README.md)（已落地归档）
- **连续性 store（②）** → [`../../archive/2026-10/runtime-state/`](../../archive/2026-10/runtime-state/README.md)（已落地归档）
- **装配·persona** → [`../../archive/2026-10/assembly-persona/`](../../archive/2026-10/assembly-persona/README.md)（已落地归档）
- 其余模块（主动性、投影等）随讨论逐篇补入。

> 2026-10-12 归档：上述四项与 effect-delivery 已由源码落地（`src/`），当前行为以源码与 `docs/` 为准，这些材料只代表当时的设计上下文。
