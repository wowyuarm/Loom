# Round 2 — 器官级 Stub 消融

日期:2026-09-03 · 基线:main @ 5aef85dd(586 测试,585 过 / 1 已知失败)。
方法:保留六个 Cognitive Organ 工厂的类型与导出,把函数体替换为立即 throw(编译零改动,`tsc` 通过、dist 内验证过 throw 标记),全量跑 586 个测试。任何真正触达该器官的测试都会失败——这是运行期爆炸半径的直接测量。
数据:`results/r2__agents__*.ts.json`(6 份)· 脚本:`harness/ablate-stub.mjs` + `harness/run-round2.sh`

## 结果(超出基线的失败,按测试区域归因)

| 器官(被 stub 的工厂) | 总失败 | 自身单测 (test/agents) | instance | runtime | channels | host | 跨区域失败 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tool Trace Compactor | **23** | 4 | 16 | – | 2 | 1 | **19**(3 个区域) |
| Memory Reflector | 19 | 18 | 1 | – | – | – | 1 |
| Life Recorder | 18 | 10 | 7 | 1 | – | – | 8 |
| Orientation | 16 | 3 | 13 | – | – | – | **13** |
| Attention Maintainer | 10 | 9+ | 1 | – | – | – | 1 |
| Thread Maintainer | 9 | 8+ | 1 | – | – | – | 1 |

\+ 含一条在 memory-reflector / thread-maintainer 两个测试文件中同名的用例(重名歧义,不影响区域归因)。

## 关键发现

1. **Instance 是所有器官的集成面**:`test/instance/loom-instance.test.ts` 出现在全部六个 stub 的失败清单里——器官经 Instance 装配后成为生命周期的一部分,印证“Instance Configuration 装配一切”的架构叙述。
2. **Tool Trace Compactor 是动态足迹最宽的组件**:叙事上它只是“轻量器官”,但因为它在**每次 context 组装时内联运行**,stub 它导致 instance 16、channels 2、host 1 共 19 处跨区域失败,总爆炸半径最大(23)。静态图谱完全看不到这一点(它在 src/agents 里的扇入只有 2)——这正是行为消融相对静态图谱的增量价值。
3. **Orientation 的失败 81% 在集成侧**(13/16 在 instance):Proactive Pulse 生命周期测试大量依赖它。它是唯一“自身单测少于集成测试”的器官,与它“只读、产出 Opportunity”的薄合同一致。
4. **Life Recorder 有唯一的 runtime 侧失败**(`test/runtime/activity-closure.test.ts`):Activity close → 器官队列这条边是 runtime 对具体器官存在的唯一行为依赖。
5. **四个写入型器官**(Memory Reflector / Life Recorder / Attention / Thread Maintainer)的自身单测数量(18/10/9/8)与各自合同复杂度(写入三态、显式 finish、分页基线、before-image)正相关,但这反映的是单测深度而非耦合——它们对系统的行为依赖都只有 instance 装配点 1 处。
6. **零泄漏到无关区域**:六个 stub 的失败全部落在 instance / runtime / channels / host / agents 五个区域;configuration、workspace、attachments、integrations 的测试完全不受影响。器官系统没有向材料层和集成层渗透。
