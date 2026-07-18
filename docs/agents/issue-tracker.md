# 任务记录

工程需求、方案和任务保存在仓库内 `.scratch/`，用于开发协作，不承载运行数据或 Agent Individual 的材料。

## 目录约定

- 一个主题一个目录：`.scratch/<feature-slug>/`
- 方案：`.scratch/<feature-slug>/spec.md`
- 实施任务：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 编号从 `01` 开始；每张任务单独一个文件。
- 讨论与实施结果追加在任务末尾的 `## Comments` 或 `## Result` 下。

任务文件在开头写 `Status: <状态>`；状态名称见 [triage-labels.md](triage-labels.md)。完成并验证后写 `Status: resolved` 和 `## Result`。

## 大型探索

尚未形成实施方案的工作使用 `.scratch/<effort>/map.md` 和对应的 `issues/NN-<slug>.md`。调查票在开头写 `Type:`、`Status:` 和 `Blocked by:`；一次只推进一张没有依赖的票。路线清楚后，再用 `to-spec` 和 `to-tickets` 建实施任务。

当工程 skill 要“发布到 issue tracker”时，在上述位置创建文件；要读取任务时，读取用户指定的路径或相关主题目录。
