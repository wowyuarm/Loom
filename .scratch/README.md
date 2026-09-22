# 工作资料目录索引

`.scratch/` 保存跨会话工作项的设计快照、研究、实施 tickets、原型和可复查的里程碑证据。它不定义当前产品行为、公开 API 或架构边界；这些以源码和测试为准（源码落地之前，`active/` 是进行中设计的主要依据）。

**怎么在这里工作（工作项结构、ticket 骨架、生命周期）见 [AGENTS.md](AGENTS.md)。**

## 目录

```text
.scratch/
├── active/                 # 尚未结束的工作项
├── archive/YYYY-MM/<work>/ # 已完成工作项的历史资料
└── local/                  # Git 忽略的私人草稿和临时输出
```

## 当前工作项入口

本节只列尚未结束的工作项；已结束的见 `archive/YYYY-MM/`。

- [continuity-and-memory](active/continuity-and-memory/README.md)：连续性 Individual 的 session（记录层）与 memory（理解层）设计——三轴模型、醒来 bundle、薄 memory 工具、search 双通道、jev 接缝。
