# 任务记录

工程需求、方案和本地实施票可以保存在仓库内 `.scratch/`，用于某个主题推进期间的开发协作，不承载运行数据或 Agent Individual 的材料。它不是正式文档或当前运行状态的替代品。

## 入口

- 目录索引：[`.scratch/README.md`](../../.scratch/README.md)。
- 工作规则（工作项结构、实施票骨架、垂直切片与 frontier、生命周期与归档）：[`.scratch/AGENTS.md`](../../.scratch/AGENTS.md)。

## 约定

- 一个主题一个目录：正在推进的放 `.scratch/<topic>/`，收口后移入 `.scratch/archive/<topic>/`。
- 方案写在 `<topic>/spec.md`，实施任务一票一文件放在 `<topic>/issues/<NN>-<slug>.md`，编号从 `01` 开始。
- 任务文件在开头写 `Status: <状态>`；状态名称见 [triage-labels.md](triage-labels.md)。完成并验证后写 `Status: resolved`，结果追加在末尾的 `## Comments` 或 `## Result` 下。
- 任务闭合后不要把后续设计回写进旧记录；新的判断另建记录或进入正式 docs。
- 主题应对应真实代码或产品边界，不预建空目录。工作简单且合同已清楚时直接用任务系统，不创建 scratch。
- 当工程 skill 要「发布到 issue tracker」时，在上述位置创建文件；要读取任务时，读取用户指定的路径或相关主题目录。

## 大型探索

尚未形成实施方案的工作使用 `.scratch/<topic>/map.md` 和对应的 `issues/NN-<slug>.md`。调查票在开头写 `Type:`、`Status:` 和 `Blocked by:`；一次只推进一张没有依赖的票。路线清楚后，再按需用 `to-spec` 和 `to-tickets` 建实施任务。

## 时间轮次

同一主题会反复进行审查、简化或清理时，使用 `.scratch/<topic>/rounds/YYYY-MM-DD-<slug>/` 保存每一轮。该轮的 `summary.md` 记录 Captured、Baseline、Status 和 Result；research、decisions 和 issues 放在同一轮内并继承这些时间和基线。

时间属于整轮调查，不需要机械加进每个文件名。以后出现新判断就新建 round，不改写旧轮的 decisions；正式合同仍进入 `CONTEXT.md`、`docs/` 或 ADR。
