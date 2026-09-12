# Test Suite Ablation

对 Loom 测试套件本身做消融视角的体检：回答"现有测试重不重、哪些测试真需要"。方法是把 src 消融的思路转置到测试侧——对每个测试文件做 leave-one-out 覆盖率测量（它执行而其余全部测试文件都不执行的 src 行有多少），再对候选做人工定性复核。这是研究记录，不是当前行为的权威来源。

## 研究问题

1. 套件"重"在哪：每个测试文件的时长、测试数与串行时间分布？
2. 哪些测试文件的执行足迹被其他测试完全覆盖（执行层冗余候选）？
3. 哪些 src 文件/行只有单一测试文件守卫，甚至零守卫？
4. 执行期覆盖与静态 import 边是否一致？

## 方法

- 基线（2026-09-03，main @ 4bde1f5）：全量 590 测试。两次全量：第一次 589/590、第二次 590/590；失败见"观察项"。
- 逐文件采集：51 个编译后测试文件各在独立进程中运行一次（`NODE_V8_COVERAGE` + 私有 `TMPDIR`，2 路并行，与 `node --test` 默认的每文件一进程隔离一致），记录时长与 node:test 计数。
- 覆盖率换算：V8 block coverage 字节区间（count>0 区间减 count=0 洞）→ 生成行 → tsc sourcemap（VLQ 解码）映射回 src 行；`src/` 下的原生 `.mjs` 脚本不经过编译，直接按行计入。
- leave-one-out 消融：测试文件 T 的"唯一行" = T 覆盖、其余 50 个文件都不覆盖的 src 行。唯一行 = 0 的文件是执行层冗余候选，再逐个人工读断言定性。
- 静态对照：解析 dist JS 的相对 import，得到每个测试文件的直接 src 依赖边。

## 主要结论（2026-09-03，51 文件 / 590 测试）

1. **执行层高度互为备份，文件级无孤岛**。80 个有运行代码的 src 文件中，除一个例外（见结论 3）每个都被 ≥3 个测试文件执行；`operational-events.ts` 被 27 个测试文件执行、`configuration/*` 被 15–18 个执行——从测试侧再次印证上一轮 src 消融"operational-events 是隐性枢纽"的判断。
2. **行级有真实纵深：25.3%（4,219/16,696）的被执行行只有单一测试文件守卫**，集中在专用协议与边界分支测试：`raft-cli-remote`（652 行）、`raft-channel`（561）、`runtime.ts`（284）、`tool-trace.ts`（294）、`weixin-http`（199）、`cli.ts`（191）、`memory-reflector`（155）等。删掉对应测试文件会留下这些行无任何测试执行——它们不是冗余，是套件的深度所在。
3. **真正的单点是集成脚本，不是单元测试**。`src/integrations/workspace-mirror/mirror.mjs`（138 行）只有 `workspace-mirror.test.ts` 一个守卫：tsc 不编译 `.mjs`，它游离在 import 图与常规覆盖率习惯之外。
4. **7 个"执行层完全被覆盖"（唯一行 = 0）的测试文件，逐个人工复核后全部保留**：
   - `workspace/write-limits`、`runtime/organ-budget`、`workspace/agent-workspace`：0.1–0.2s 的纯函数合同钉子，断言精确边界值（65539/65536 字节）、退避时刻表（1min/5min/24h）、错误名与错误消息——别的测试执行同一批行，但都不校验这些值。
   - `runtime/activity-closure`：唯一把"关闭 Activity → 后继 Turn 看到 recent_activity 框架 → Life Recorder 补写 Daily"三段时序钉进一个故事的场景测试（上轮 src 消融也确认这条边是 runtime 对 Life Recorder 的唯一行为依赖）。
   - `instance/process-driver`：钉事件序列（started/completed/failed 的形态与脱敏）、wake 时序、deferred 不轮询等驱动语义。
   - `host/cli-permissions`：不执行任何 src 代码，守的是构建产物 chmod +x 的完整性。
   - `integrations/workspace-mirror`：修复 .mjs 盲区后它有 138 行全部唯一（见结论 3）。
   - 结论：**执行覆盖相同 ≠ 断言冗余；本套件没有可删的测试文件**。
5. **时间分布**：串行总和 163s（含覆盖率采集开销，为上界）；真实套件 wall 77s（4 路并行）。top-10 文件占 74% 串行时间，全部是 fs/sqlite/子进程密集的集成测试：`runtime.test.ts` 28s（395ms/测试）、`loom-instance` 18.6s（640ms）、`foreground-cli` 14.3s（2,049ms/测试，真实子进程）。要给套件提速，杠杆在这 10 个文件的并行度与 I/O 形态，不在删测试——纯单元文件几乎免费（≤1s）。
6. **零覆盖的 3 个 src 文件均为纯类型文件**（编译产物 0 字节）：`channels/channel.ts`、`channels/surface.ts`、`runtime/types.ts`，无运行代码可测。

## 观察项（未修复，记录在案）

`test/runtime/runtime.test.ts` "does not emit run events from a rolled-back completing transaction" 在负载下偶发翻转：约 2/8 次负载运行出现（全量套件 1 次、消融采集轮 1 次），单独重跑与 2 路并行猎捕 3 轮均未复现。失败时 `failureCategory` 实际得到 `authentication`、期望 `invalid_result`——`src/runtime/runtime.ts:4430` 的分类器把某条负载下出现的错误消息按 `/auth|credential|token|401|403/` 误分类。属测试对分类器的假设在负载下不稳固，非本主题处理。

## 方法限制

- 执行覆盖子集只能提名冗余候选；断言值、错误消息、时序的独有性靠人工复核（本轮候选全部读过）。"零唯一行"不构成删除依据。
- 覆盖率采集有开销，时长数字是上界；并行采集下同条件可比。
- `runtime__runtime` 在采集轮有一次失败，其后用干净运行重采覆盖（数据取自干净轮）。

## 数据与脚本

- `harness/collect-one.mjs` — 单测试文件采集（时长 + node:test 计数 + 失败名 + V8 dump）
- `harness/merge-coverage.mjs` — V8→行→sourcemap→src 行矩阵 + leave-one-out 分析
- `harness/static-edges.mjs` — dist JS 的 test→src 静态 import 边
- `harness/run-round.sh` — 全轮编排（2 路并行）
- `results/coverage-analysis.json` — 每测试文件（时长/覆盖行/唯一行/唯一比）、每 src 文件守卫数、零覆盖清单
- `results/static-edges.json` — 静态依赖边
- 原始矩阵与 V8 dump 留在 `/tmp/test-ablation/`（未提交，可由 harness 重算）
