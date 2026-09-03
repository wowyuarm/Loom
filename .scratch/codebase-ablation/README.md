# Codebase Ablation

对 Loom codebase 做全方位消融实验：把某个组件从系统中移除或废掉，测量其余部分的编译、测试与行为受损程度，以此回答“每个模块/器官/文件对系统承重多少、耦合多深”。这是研究记录，不是当前行为的权威来源。

## 研究问题

1. 哪些模块是结构性承重墙（删掉后大半系统无法编译）？
2. 哪些组件在运行期被隐性依赖（删掉后自身测试之外的行为测试失败）？
3. Cognitive Organs 各自的行为爆炸半径有多大？
4. 文件级耦合热点在哪里（高扇入文件、大崩溃集）？

## 方法

三种消融手段，按粒度递进：

- **删除消融（deletion ablation）**：删除目标模块及其反向依赖闭包（src 与 test 一起算），剩余代码必须通过 `tsc` 编译，然后运行幸存测试。失败 = 动态耦合或共享 fixture 受损。
- **Stub 消融（behavioral ablation）**：保留类型与导出，把入口函数改为立即 throw，全量编译、全量跑测试。任何真正触达该组件的测试都会失败——这是行为期爆炸半径的直接测量。
- **静态耦合图谱（static coupling map）**：解析全部 import，对每个文件算直接扇入与反向依赖闭包大小，不做任何构建。

基线（2026-09-03，main @ 5aef85dd）：全量 586 测试，585 过、1 败。已知基线失败：`test/main-agent/pi-execution.test.ts` "binds interaction Workspace materials to their system and Context levels"（transcript 断言中的尾随换行差异，重跑稳定复现，非 flake）。所有轮次结果以“超出该基线的失败”计增量。

消融在 `/tmp/loom-ablation/` 下的独立 git worktree 中执行（node_modules 软链回主仓），不污染工作区。harness 脚本见 `harness/`。

## 轮次

- Round 1 — 模块级删除消融（14 个目标：10 个顶层模块 + raft/weixin/nmem/web 细分）：`research/round1-module-deletion.md`
- Round 2 — 器官级 stub 消融（6 个 Cognitive Organ 入口工厂）：`research/round2-organ-stub.md`
- Round 3 — 全文件级静态耦合图谱（~78 个 src 文件）：`research/round3-file-coupling.md`

## 结论

三轮实验(16 次删除消融 + 6 次 stub 消融 + 全库静态图谱,2026-09-03)的主要结论:

1. **静态边界即行为边界**:16 个模块/文件级删除消融中,静态 import 闭包完整解释了全部测试耦合——扣除 CLI 入口消亡与基线已知失败后,幸存测试零失败。没有绕过 import 图的共享状态或隐藏桥接。
2. **承重结构三层分明**:`configuration`(闭包 87/132 文件)、`runtime`(84)、`operational-events.ts`(88,单文件)是底座;`workspace`/`channels`/`agents`/`main-agent`/`attachments`/`integrations` 居中;`host`/`instance` 是几乎无反向依赖的纯组合层。
3. **`operational-events.ts` 是文档外的隐性枢纽**(闭包全库第一、扇入第二),建议架构文档给它一个正式位置。
4. **行为期爆炸半径与静态扇入脱节**:Tool Trace Compactor 静态扇入仅 2,但因内联于每次 context 组装,stub 后 23 个测试失败、横跨 4 个区域,是全库动态足迹最宽的组件。静态图谱要配合 stub 消融才能看清。
5. **Instance 是器官系统的唯一集成面**:六个器官 stub 都命中 `loom-instance.test.ts`;四个写入型器官对系统的行为依赖仅有装配点 1 处,器官未向材料层(config/workspace/attachments)和集成层(nmem/web)渗透。
6. **附带发现(已修复)**:实验时的基线失败 `test/main-agent/pi-execution.test.ts` "binds interaction Workspace materials…" 已根因定位——Pi SDK `buildSystemPrompt` 的 customPrompt 分支在 cwd 行后追加尾随 `\n`,0.84.2 升级同一提交写入的测试预期漏算了它;已按 SDK 实际行为修正测试预期(commit `6a00a12`),修复后独立 worktree 并行全量 588/588 × 2 零失败。实验中一次性的 "requires a message decision…" 负载翻转未再复现,记为观察项;另确认同一 checkout 上并发跑两个 build 会因 `cp core-skills` 竞态产生嵌套目录(自伤,非产品缺陷)。

完整数据:`results/`(JSON)· 分轮记录:`research/round{1,2,3}-*.md`
