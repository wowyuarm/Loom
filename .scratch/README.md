# Scratch 工作资料索引

`.scratch/` 保存某个工程主题在推进期间形成的研究、方案、实施票和验收证据。这里的内容记录的是当时的事实和决定，不是 Loom 当前行为或正式合同的事实源——那些以 `src/`、`test/`、真实运行状态和 `docs/` 为准。

**怎么在这里工作（工作项结构、实施票骨架、生命周期）见 [AGENTS.md](AGENTS.md)。**

## 目录

```text
.scratch/
├── <topic>/           # 正在推进的主题
├── archive/<topic>/   # 已收口主题的历史资料
└── local/<topic>/     # 本机工作区：不进版本控制（.gitignore 忽略 .scratch/local/）
```

`local/` 放只在本机有意义、或体积/内容不适合入仓的材料（例如评测实例的产物）。它**不在上面两个索引表里**——索引只登记入仓的主题；`local/` 里有什么以本机实际目录为准。

## 活跃主题

| 主题 | 状态 | 入口 |
| --- | --- | --- |
| deepseek-harness | active —— 评估 DSH 作为 Loom 的 Interaction Channel（探索阶段，尚未形成实施方案） | [`deepseek-harness/as-channel/map.md`](deepseek-harness/as-channel/map.md) |

## 归档主题

已收口主题的索引与结果见 [`archive/README.md`](archive/README.md)。

## 阅读

- 只有当前任务明确引用某个主题时才进入对应目录。
- 先以代码、测试、真实运行状态和 `docs/` 判断当前情况，再用 scratch 追溯背景。
- 旧 `map.md`、spec 和闭合 issue 可能已被后续实现或正式文档取代；不要从整个目录推导 Loom 当前状态。

## 新建主题

新主题应对应真实产品或代码边界，只有实际需要时才创建目录；目录结构与实施票骨架见 [AGENTS.md](AGENTS.md)。工作简单且合同已清楚时，可以直接使用任务系统而不创建 scratch。
