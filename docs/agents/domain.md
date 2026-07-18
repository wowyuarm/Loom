# 项目术语和决定

## 阅读顺序

处理 Loom 的工程工作时，依次阅读：

1. `AGENTS.md`
2. 根目录 `CONTEXT.md`
3. 与任务有关的 `docs/adr/`
4. 对应 `.scratch/` 中的 map、spec 或 ticket（存在时）

## 文件位置

Loom 是单一领域上下文：

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── agents/
└── .scratch/
```

`CONTEXT.md` 只记录稳定术语和边界；ADR 只记录难以逆转、存在真实取舍且代码无法解释的长期决定。没有相关文件时静默继续，不为填目录而新增文档。

## 使用原则

任务、方案、代码和测试名称使用 `CONTEXT.md` 已定义的术语。若新方案与 ADR 冲突，必须明确指出并重新讨论，不能悄悄改写既有决定。
