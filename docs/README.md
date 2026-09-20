# Loom 文档索引

本目录是持续维护的正式工程文档。改动或新增这里的文档前，先读 [AGENTS.md](AGENTS.md)（路由与维护纪律）。当前行为以代码、测试和真实运行状态为准；文字与代码冲突时以代码为准。

## 入口

| 文档 | 用途 | 何时读 |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | 模块关系与数据流 | 改动跨模块边界、装配或持久面时 |
| [`cognitive-organs.md`](cognitive-organs.md) | 认知器官职责与调度 | 动器官、调度或连续性材料时 |
| [`channels/raft.md`](channels/raft.md) | Raft channel 行为与配置 | 动 Raft 接入或多 channel 并行时 |
| [`channels/weixin.md`](channels/weixin.md) | Weixin channel 行为与配置 | 动 Weixin 路由、附件或快照时 |
| [`integrations/nmem.md`](integrations/nmem.md) | nmem 外部记忆集成 | 动记忆召回或证据投影时 |
| [`integrations/web.md`](integrations/web.md) | Web Access 公开资料读取 | 动网页搜索与抓取能力时 |
| [`integrations/workspace-mirror.md`](integrations/workspace-mirror.md) | Workspace 镜像运维观测面 | 动镜像配置或运维观测时 |
| [`operations/agent-guided-instance-operations.md`](operations/agent-guided-instance-operations.md) | 实例操作总入口（给外部 operator agent） | 安装、运行、备份、迁移时 |
| [`operations/reference/`](operations/reference/) | 生命周期、配置凭据、备份恢复、状态诊断 | 查具体操作口径时 |
| [`adr/`](adr/) | 已接受的长期决定 | 方案与既有决定疑似冲突时 |
| [`agents/`](agents/) | Agent 工作约定：规划、执行、类型、测试、防御、问题记录、状态 | 按根 `AGENTS.md` 的阅读指引按问题取用 |
| [`AGENTS.md`](AGENTS.md) | 本目录的工作规则 | 改动或新增本目录文档前 |

## 阅读起点

- **跑起来、做运维**：先读操作总入口，再查 `reference/` 里对应的口径。
- **改运行时、器官、channel、integration**：先读 `architecture.md` 定边界，再读对应文档；术语不清回 [`CONTEXT.md`](../CONTEXT.md)。
- **做规划、拆任务**：`agents/` 按根 `AGENTS.md` 指引按问题取用；历史背景用 [`.scratch/README.md`](../.scratch/README.md) 定位主题。
- **拿不准有没有长期决定挡路**：先读 `adr/`，再动手。
