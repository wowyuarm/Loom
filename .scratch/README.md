# 工作资料目录索引

`.scratch/` 保存跨会话工作项的设计快照、研究、实施 tickets、原型和可复查的里程碑证据。它不定义当前产品行为、公开 API 或架构边界；这些以源码和测试为准（源码落地之前，`active/` 是进行中设计的主要依据）。

**怎么在这里工作（工作项结构、ticket 骨架、生命周期）见 [AGENTS.md](AGENTS.md)。**

## 目录

```text
.scratch/
├── active/                 # 尚未结束的工作项
├── archive/YYYY-MM/<work>/ # 已完成工作项的历史资料
└── local/                  # Git 忽略的私人草稿和临时输出
```

## 当前工作项入口

本节只列尚未结束的工作项；已结束的见下节。

- [loom-architecture](active/loom-architecture/FRAMEWORK.md)：全局骨架——模块分解、数据所有权、DSH 复用判定、第一个切片边界。各模块在其下逐一展开。
- [workspace — 初始化缺口](active/workspace/initialization-gaps.md)：Instance Root 的 provisioning 层仍是缺口（workspace 层已落地）。取舍已收进 [ADR 0001](../docs/adr/0001-no-provisioning-primitive.md)。

## 已归档

这些工作项已由源码落地，**当前行为以 `src/` 与 `docs/` 为准**；下面的材料只代表当时的设计上下文，不覆盖落地行为（[AGENTS.md](AGENTS.md) 的归档规则）。

- [continuity-and-memory](archive/2026-10/continuity-and-memory/README.md)：材料/记忆与连续性召回的设计。
- [channels](archive/2026-10/channels/README.md)：独立的 dsh-channel-gateway 方案 + Loom 消费层。
- [runtime-state](archive/2026-10/runtime-state/README.md)：连续性 store，v1 = 指针 + 去重账本。
- [effect-delivery](archive/2026-10/effect-delivery/README.md)：出站 Effect/Delivery 账本。
- [assembly-persona](archive/2026-10/assembly-persona/README.md)：boot/reattach、单活锁、中性 persona vs identity、Loom bundle。
- [dsh-alignment](archive/2026-10/dsh-alignment/README.md)：逐模块对照 DSH——分层与接缝地图、已确认的判断错误；B 工作项（检索 + 回返/checkpoint）由 `8eced7c` 实装。
- [workspace — 结构设计](archive/2026-10/workspace/README.md)：Instance Root 结构与两区边界。已落地，且其中"材料放 Workspace 根""靠 `agent-instructions` 注入 AGENTS.md"两处结论已被当前实现推翻——照原样保留，不回写。
- [proactivity](archive/2026-10/proactivity/README.md)：活动锚定的自主检查（`pulse`）与对话后检查（after-interaction）两轨并存的设计与研究；pulse 已实现；早先的 dry-run 只记录开关已由 `8586b62` 从源码移除，现在装上即真唤醒，能力页见 `docs/subsystems/pulse.md`。归档含系统研究、Jev 实验与实施票。
- [context-management](archive/2026-10/context-management/README.md)：长期 context 管理的**研究**（不是已落地设计）。注意区分：栈里已有按字符数、overflow 时触发的工具裁剪（`tool-result-pruner`），本项要的是按 token 水位主动触发的那一档——后者未实现。归档理由是它已从"进行中工作"转为可重开的研究材料，不是因为做完了。

注：`dsh-alignment` 里的"更后候选"（`tool-ask-user`、`ctx.commands`、`ctx.webhookRuntime`）已移入 proactivity DESIGN §9.11；`restrict` 那条防走错方向的结论已进 `docs/dsh-platform.md` 的接缝表。两样都没有随归档消失。
