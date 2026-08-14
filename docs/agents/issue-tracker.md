# 任务记录

工程需求、方案和本地实施票可以保存在仓库内 `.scratch/`，用于某个主题推进期间的开发协作，不承载运行数据或 Agent Individual 的材料。它不是正式文档或当前运行状态的替代品。

## 目录约定

- 一个主题一个目录：`.scratch/<feature-slug>/`
- 方案：`.scratch/<feature-slug>/spec.md`
- 实施任务：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 编号从 `01` 开始；每张任务单独一个文件。
- 讨论与实施结果可以追加在任务末尾的 `## Comments` 或 `## Result` 下；任务闭合后，不要把后续设计回写进旧记录，新的判断另建记录或进入正式 docs。

任务文件在开头写 `Status: <状态>`；状态名称见 [triage-labels.md](triage-labels.md)。完成并验证后写 `Status: resolved` 和 `## Result`。

## 大型探索

尚未形成实施方案的工作可以使用 `.scratch/<effort>/map.md` 和对应的 `issues/NN-<slug>.md`。主题应对应真实代码或产品边界，不预建空目录。调查票在开头写 `Type:`、`Status:` 和 `Blocked by:`；一次只推进一张没有依赖的票。路线清楚后，再按需用 `to-spec` 和 `to-tickets` 建实施任务。

当工程 skill 要“发布到 issue tracker”时，在上述位置创建文件；要读取任务时，读取用户指定的路径或相关主题目录。主题完成后可将入口移入 `archive/` 或在定期清理时处理；归档内容默认不参与当前设计判断。

## 时间轮次

同一主题会反复进行审查、简化或清理时，使用 `.scratch/<topic>/rounds/YYYY-MM-DD-<slug>/` 保存每一轮。该轮的 `summary.md` 记录 Captured、Baseline、Status 和 Result；research、decisions 和 issues 放在同一轮内并继承这些时间和基线。

时间属于整轮调查，不需要机械加进每个文件名。以后出现新判断就新建 round，不改写旧轮的 decisions；正式合同仍进入 `CONTEXT.md`、`docs/` 或 ADR。
