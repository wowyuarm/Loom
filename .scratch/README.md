# Scratch Work

`.scratch/` 保存某个工程主题在推进期间形成的研究、方案和本地实施票。这里的内容记录的是当时的事实和决定，不是 Loom 当前行为或正式合同的事实源。

## 阅读

- 只有当前任务明确引用某个主题时才进入对应目录。
- 先以代码、测试、真实运行状态和 `docs/` 判断当前情况，再用 scratch 追溯背景。
- 旧 `map.md`、spec 和闭合 issue 可能已被后续实现或正式文档取代；不要从整个目录推导 Loom 当前状态。

## 新建主题

新主题应对应真实产品或代码边界，只有实际需要时才创建目录。可以按需包含：

```text
.scratch/<topic>/
  map.md
  research/
  spec.md
  issues/
```

不要求每个主题具备全部结构，也不要预建空目录。工作简单且合同已清楚时，可以直接使用任务系统而不创建 scratch。

同一主题会反复进行审查、简化或清理时，以时间轮次保存快照：

```text
.scratch/<topic>/
  README.md
  rounds/YYYY-MM-DD-<slug>/
    summary.md
    research/
    decisions.md
    issues/
```

日期属于一轮调查，不需要机械加入每个 research 文件名。`summary.md` 记录 Captured、Baseline、Status 和 Result；该轮其他材料默认继承这些时间和基线，只有证据采集时间不同才单独标注。

## 完成与清理

主题推进期间可以更新状态和结果；工作闭合后，不把后续设计回写进旧记录。仍需长期遵守的术语、架构和操作边界应进入 `CONTEXT.md`、`docs/` 或 ADR。

定期清理时可以按主题归档或删除已经失去价值的材料，但必须先核对引用和历史价值。清理不承担改写产品历史，也不能用旧目录结构约束当前架构。
