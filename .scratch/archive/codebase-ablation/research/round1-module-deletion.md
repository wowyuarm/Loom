# Round 1 — 模块级删除消融

日期:2026-09-03 · 基线:main @ 5aef85dd,全量 586 测试(585 过 / 1 已知失败)。
方法:删除目标 + 其反向依赖闭包(src∪test,由静态 import 图计算),`tsc` 编译剩余代码,运行幸存测试。
数据:`results/r1__*.json`(16 份)· 脚本:`harness/ablate-delete.mjs` + `harness/run-round1.sh`

## 结果总表(按闭包排序)

| 目标 | 删除 src/test | 幸存测试 | 原始失败 | 真实增量失败 |
| --- | --- | --- | --- | --- |
| operational-events.ts | 51 / 37 | 70 | 1 | **0** |
| configuration | 50 / 37 | 63 | 1 | **0** |
| runtime | 48 / 36 | 73 | 1 | **0** |
| workspace | 29 / 27 | 300 | 1 | **0** |
| channels | 26 / 17 | 331 | 1 | **0** |
| agents | 23 / 19 | 343 | 1 | **0** |
| main-agent | 20 / 12 | 417 | 1 | **0** |
| integrations | 18 / 12 | 409 | 1 | **0** |
| attachments | 18 / 10 | 424 | 1 | **0** |
| integrations/nmem | 17 / 11 | 411 | 1 | **0** |
| continuity-guidance.ts | 15 / 12 | 461 | 2 | **0** |
| instance | 13 / 8 | 494 | 2 | **0** |
| integrations/web | 7 / 7 | 511 | 2 | **0** |
| channels/weixin | 6 / 4 | 542 | 2 | **0** |
| channels/raft | 9 / 7 | 486 | 2 | **0** |
| host | 4 / 4 | 552 | 2–3 | **0** |

“真实增量失败”扣除了两类已解释失败:

1. **CLI 入口消亡**:`src/cli.ts` 是全库顶层 bin,import 几乎所有模块,因此出现在几乎所有目标的崩溃集里;`dist/src/cli.js` 随之不存在,`test/host/cli-permissions.test.ts` 必然失败(ENOENT 已在失败详情中逐一确认)。这是消融的合法后果,不是隐藏耦合。唯一例外方向:消融 integrations / agents 等不被 cli.ts 引用的目标时该测试通过。
2. **基线已知失败**:`pi-execution.test.ts` "binds interaction Workspace materials…" 在崩溃集未覆盖该文件时按基线照常失败。

## 关键发现

1. **零隐藏耦合**:16 个目标在扣除上述两类后,幸存测试全部通过。静态 import 闭包**完整解释**了测试级耦合——Loom 模块之间没有绕过类型系统的共享状态、全局单例或 fixture 桥接。这是本轮最重要的架构结论:模块边界与编译边界重合。
2. **删除比例分层清晰**:
   - 删 `configuration` / `runtime` / `operational-events.ts` 任一,全库约 88% 的测试文件消失(幸存 63–73/586)——三者是事实上的承重底座;
   - 删 `workspace` / `channels` / `agents` / `main-agent` / `attachments` / `integrations*` 幸存 300–542;
   - 删栈顶 `host` / `instance` / `channels/weixin` / `channels/raft` 幸存 486–552,几乎无伤。
3. **`operational-events.ts` 与 `configuration` 同级承重**(删除后幸存 70 vs 63),确认 Round 3 静态图谱中“隐性枢纽”的判断——它不在 docs 模块叙事里,但承重位列全库第三。
4. **附带发现(测试时序敏感)**:host 消融在 2 路并发负载下的一次运行中,`pi-execution.test.ts` 的另一条用例 "requires a message decision after a human steers a proactive Turn" 也失败过一次;单独重跑(无并发负载)该用例通过。同文件失败用例随机器负载翻转,指向 transcript 断言对写入时序敏感(与基线失败的尾随换行 diff 同源)。建议单独开 issue 核实,不属于本消融的方法论问题。
   - **后记(压载复验)**:基线失败的尾随换行已根因定位并修复——Pi SDK `buildSystemPrompt` 的 customPrompt 分支在 cwd 行后追加尾随 `\n`,测试预期漏算(commit `6a00a12`)。修复后复验:pi-execution 文件 3 路并发 7 连跑全过;两个独立 worktree 并行全量套件 588/588 × 2 零失败;"requires a message decision…" 未再复现,记为一次性观察项。
   - **压载方法教训**:两个 `npm test` 并发跑在**同一** checkout 时,`clean → tsc → cp core-skills` 三步竞态会产生嵌套的 `dist/src/main-agent/core-skills/core-skills/`,skill 加载器注入 name-collision 诊断导致 `loom-instance.test.ts` "provides the built-in skill manager…" 失败。这是并行构建的自伤,不是产品缺陷——且 skill 诊断面对损坏状态行为正确(显式报 collision,winner/loser 路径齐全)。消融 harness 的 worktree 隔离正好规避了它。
