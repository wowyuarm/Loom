# Round 3 — 全文件级静态耦合图谱

日期:2026-09-03 · 基线:main @ 5aef85dd · 方法:纯静态 import 图谱,不做构建。
数据:`results/coupling-map.json` · 脚本:`harness/couple-map.mjs`

## 度量定义

- **fanIn(src/test)**:除自身子树外,直接 import 目标文件的 src / test 文件数。
- **closureSize**:目标文件 + 全部(传递)import 它的 src∪test 文件数——删除消融中会一起消失的文件数。全库共 132 个 TS 文件(82 src + 50 test)。

## 模块级(按闭包排序)

| 模块 | 文件数 | 直接扇入 src/test | 闭包 (src/test) |
| --- | --- | --- | --- |
| configuration | 4 | 7 / 9 | **87** (50/37) |
| runtime | 7 | 34 / 26 | **84** (48/36) |
| workspace | 4 | 16 / 15 | 56 (29/27) |
| channels | 14 | 9 / 7 | 43 (26/17) |
| agents | 11 | 4 / 10 | 42 (23/19) |
| main-agent | 13 | 2 / 6 | 32 (20/12) |
| integrations | 10 | 4 / 6 | 30 (18/12) |
| attachments | 3 | 10 / 4 | 28 (18/10) |
| instance | 9 | 3 / 6 | 21 (13/8) |
| host | 3 | 1 / 4 | 8 (4/4) |

## 文件级热点

| 文件 | 闭包 | 直接扇入 src | 说明 |
| --- | --- | --- | --- |
| `src/operational-events.ts` | **88** | 18 | 顶层单文件,全场最大闭包 + 第二大直接扇入 |
| `src/runtime/index.ts` | 76 | **34** | 全场最大直接扇入(runtime 的 barrel) |
| `src/configuration/time-policy.ts` | 87 | 2 | 栈底位置使其闭包巨大 |
| `src/workspace/agent-workspace.ts` | 39 | 13 | Workspace 核心类型/实现 |
| `src/channels/surface.ts` | 40 | 11 | Channel Agent Surface 合并面 |
| `src/attachments/index.ts` | 26 | 10 | Attachment 类型入口 |
| `src/workspace/workspace-mutation.ts` | 42 | 8 | 器官写入恢复协议 |
| `src/agents/session/index.ts` | 37 | 7 | Organ Session 共享执行器 |
| `src/continuity-guidance.ts` | 27 | 6 | Harness 级 guidance 常量 |

## 解读

1. **双承重墙**:configuration(闭包 87/132)与 runtime(84/132)处于依赖图栈底,任何对它们接口的破坏性改动会波及全库 2/3 以上的文件;其中 `runtime/index.ts` 的直接扇入 34 是全库最高,说明 runtime 的对外接口集中从一个 barrel 导出。
2. **`operational-events.ts` 是隐性枢纽**:一个不属于任何 docs 模块叙事的顶层文件,闭包 88 超过 configuration、直接扇入 18 仅次于 runtime barrel——几乎每个模块都靠它上报操作事件。它值得在架构文档的模块图中获得一个名字。
3. **栈顶清晰**:host(闭包 8)与 instance(21)几乎无人反向依赖,是纯组合层;删除它们对静态图谱损伤最小,符合"Host/Process Driver 是可替换宿主入口"的设计意图。
4. **channels 的不对称**:srcFanIn 9 但闭包 43——runtime/main-agent 类型透过 `channels/surface.ts`(扇入 11)渗入,Channel 是"被框架调用"而非"调用框架",合并逻辑集中在 Host。
