# docs/ 工作规则

本目录是 Loom 持续维护的正式工程文档。根 `AGENTS.md` 只保留每项任务都必须知道的规则；本文件只管怎么在这里工作——把改动路由到拥有该事实的文档，以及让整套文档保持真实的纪律。文档索引见 [README.md](README.md)。

## 路由

让文档事实失效的改动，在同一改动里更新 owning 文档：

| 改动触及 | 更新 |
| --- | --- |
| 稳定术语、概念、边界 | [`CONTEXT.md`](../CONTEXT.md) |
| 模块关系、数据流、装配 | [`architecture.md`](architecture.md) |
| 认知器官职责与调度 | [`cognitive-organs.md`](cognitive-organs.md) |
| Raft / Weixin channel 行为 | [`channels/`](channels/) 下对应文件 |
| nmem / Web Access / Workspace Mirror | [`integrations/`](integrations/) 下对应文件 |
| 安装、运行、备份、诊断、配置 | [`operations/`](operations/) 下对应文件 |
| 难以逆转、有真实取舍的长期决定 | [`adr/`](adr/)（新决定按编号新增，不改写已接受的） |
| Agent 工作约定（规划、执行、类型、测试、问题记录、状态） | [`agents/`](agents/) 下对应文件 |
| 项目定位与文档入口 | [`README.md`](../README.md) |

## 落点判定

新内容先定落点，再动笔：

| 内容性质 | 落点 |
| --- | --- |
| 每项任务都生效的行为约束 | 根 `AGENTS.md` |
| 稳定事实与可复用方法 | `docs/`（按上表路由） |
| Agent 工作流约定 | `docs/agents/` |
| 推进期的研究、方案、实施票 | `.scratch/<topic>/`（规则见 [`.scratch/AGENTS.md`](../.scratch/AGENTS.md)） |
| 难逆转的长期决定 | `docs/adr/` |
| 只对自己有意义的偏好 | 私有 memory，不进仓库 |

## 维护纪律

- 代码、测试和真实运行状态定义当前行为。文字与代码冲突时改文档；不写代码没实现的行为。
- 一个事实只有一个正式归属；跨文档引用用链接，不复制事实。
- 不确定的事实不猜：写成未决问题并升级（规划结果与交接材料里的"未决问题"就是放它的地方）。
- 改动本目录、新增正式文档，或改四个入口文件（根 `AGENTS.md`、`README.md`、`CONTEXT.md`、`docs/README.md`）后，运行 `npm run docs:check`。
- 新文档在同一改动里登记进 `README.md` 的索引与阅读起点。
- 提交只 stage 自己的路径，不覆盖他人的未合入改动；commit 格式见根 `AGENTS.md` 约定。
- `.scratch/` 是工作历史不是依据；结论稳定后再搬进本目录，不为迎合新代码改写归档。

## 长度纪律

每段只留三类：所有权与写入点、顺序或调用依赖、反直觉的前置条件与公开契约要点。删四类：设计辩护、已不存在的旧实现的成本叙述、与其他文档重复的规则长段、测量方法与推导叙事。改前先量（新增行数与字节），别凭观感。
