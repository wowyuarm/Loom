# Loom

Loom 是一个面向长期关系主体的 Agent Harness。它希望成为 proactive agent 的运行环境——为一个能跨时间持续存在、主动、好奇、独立且以人为中心的关系主体提供条件，但不内置任何具体个体的人格、关系或关切。

每个 Loom 部署形成一个 Runtime Instance，只承载一个 Agent Individual。Harness 提供连续的时间、工作空间、认知器官和可靠的对外行动能力；Individual 自己决定关注什么、建立什么关系、何时主动、何时沉默。Agent 可以偏向关系，也可以倾向协作——关系性关切本身就是一种完整的主动机会，不是没有活儿干时的 fallback。

Loom 的设计来自一个已长期运行的真实 agent 的经验沉淀与通用化，目前处于早期阶段，但已经过实际使用的验证（包括第二个 Individual 的真实模型验收）。

## 它怎么工作

一个 Runtime Instance 由四类执行模块装配而成，它们各自持有不同的持久面：

```
Instance Configuration          装配一切：时间、模型、Integration、调度

Runtime                         持有 Runtime Store（本地 SQLite）
  │                               input · 时间 · turn · effect / delivery
  │                               活动生命周期 · 恢复
  │
  ├── Main Agent                 在 Pi session 中执行主 agent
  │     cwd = Agent Workspace      固定文件工具 + message
  │     产出 Primary Agent Transcript（按 logical day）
  │
  ├── Cognitive Organs           各自独立 Pi session，不互相调用
  │     Orientation               空闲时探索近期生活，形成一个主动入口或 none
  │     Life Recorder             把已冻结活动记成 Daily 与可回放 Episode
  │     Attention Maintainer      维护跨天自然带着的 Current Attention
  │     Memory Reflector          把跨时间证据写回 Identity / Memory / Behavior
  │     Thread Maintainer         维护私人工作线 Threads 的结构连续性
  │     Tool Trace Compactor      压缩过长的工具轨迹
  │
  └── Integrations               默认关闭，Instance Configuration 显式启用
        Local · Weixin · Raft · nmem · Attachments
```

这些东西归属分明：**Agent Workspace** 是 Individual 自己的--身份、关系、记忆、私人工作都在这里，Harness 不替它决定。运行事实、执行证据和装配配置归 Harness 持有，让进程能恢复、能审计、能重新装配。

认知器官各自独立运行，不互相调用，只通过共同的记忆和工作空间间接影响彼此。Loom 一次只推进一件事：处理来信，在空闲时发起主动机会，适时整理记忆和注意力。任何一步失败都会留着重试；一段活动停了一会儿或持续太久，会被冻结成可回放的经历，供记忆器官之后取用。

术语和边界的准确定义见 [CONTEXT.md](CONTEXT.md)，难以逆转的长期取舍见 [docs/adr/](docs/adr/)。

## 现状

- **阶段**：早期，单 Instance，前台 Host 运行。Loom 不负责 OS service 安装，也不替 Individual 生成身份。
- **已验证**：Local interaction channel、Weixin（文字 / 单张入站图片 / 单个出站附件）、nmem 可选集成、Instance 初始化、第二个 Individual 的真实模型端到端验收。Raft 的机械实现与本地合同已通过测试，独立 Raft-only Instance 的真实验收仍在进行。
- **边界**：一个 Instance 只启用一个 interaction channel；不预建通用运维或评估体系；语音 / ASR、入站普通文件、视频、多附件不属于当前 Integration。

## 快速开始

推荐直接让具备 Bash 权限的 Claude Code、Codex 等 Agent 阅读
[Agent-guided Instance Operations](docs/operations/agent-guided-instance-operations.md)，
再根据你的目标完成安装、配置和验证。

### 手动开始

需要 Node `>=24.15.0`。

```bash
npm ci
npm run build
node dist/src/cli.js init
```

`init` 只创建基础目录，不生成 Individual 材料，也不覆盖已有文件。继续准备实例见
[Instance Lifecycle](docs/operations/reference/instance-lifecycle.md)；模型、key 和
Integration 配置见
[Configuration And Credentials](docs/operations/reference/configuration-and-credentials.md)。

运行 Instance：

```bash
node dist/src/cli.js run
```

该入口保持前台运行，在 `SIGINT` 或 `SIGTERM` 后等待当前工作自然结束。

默认 Instance Root 是 `~/.loom`。只有维护非默认实例或测试时才需要
`--root`。在仓库开发期可 `npm link` 后直接使用 `loom`：

```bash
loom init
loom run
loom chat "hello"
loom history
loom status
loom status --json
loom status --since 2026-08-03T00:00:00Z
```

`chat` 和 `history` 通过启用的 Local Unix socket 读写互动视图；`status`
通过独立的本机只读 socket 查询正在运行的 Host，因此在 Raft-only 或
Weixin-only 实例上同样可用。Host 不在时返回 `unavailable`，不会直接打开
Runtime Store 猜测当前状态，并以退出码 1 结束。`--since` 只增加该时间后的
无内容 Agent 运行摘要。

Instance Root 布局：

```
<root>/
├── configuration/
│   ├── instance.yaml          装配、时间、模型、Integration、调度
│   ├── pi/                    auth.json · models.json · models-store.json
│   └── integrations/<name>/   config.json · auth.json（按需）
├── workspace/                 Agent Individual 拥有
│   ├── identity.md  memory.md  attention.md  facts.json
│   ├── behavior/{interaction,background}.md
│   └── daily/  episodes/  threads/  skills/
├── runtime/                   Harness 拥有
│   ├── host-lock.db           Host 独占锁
│   ├── status.sock            运行中 Host 的本机只读状态入口
│   ├── workspace-mutations/   认知器官多文件 revision 恢复
│   └── integrations/          channel state · nmem.db · attachments/
├── transcripts/{main,organs}/
└── backups/                   认知器官写前备份
```

## 开发

```bash
npm run typecheck
npm test
npm run build
```

## 文档

Loom 的文档保持薄：稳定术语落在 CONTEXT.md，难以逆转的取舍落在 ADR，当前工作路线用 `.scratch/` 里的 map 与 ticket 推进。

- [CONTEXT.md](CONTEXT.md) — 术语与边界
- [docs/adr/](docs/adr/) — 难以逆转的长期取舍
- [AGENTS.md](AGENTS.md) — 协作规则
- [.scratch/harness-layers/map.md](.scratch/harness-layers/map.md) — 当前阶段、已闭合工作与下一步
- [docs/agents/](docs/agents/) — 工程任务约定
- [docs/integrations/](docs/integrations/) — Integration 接入与运行边界
- [Agent-guided operations](docs/operations/agent-guided-instance-operations.md) — 可直接交给 Claude Code、Codex 等经用户授权且具备主机操作能力的 Agent，用于安装、初始化和运维 Loom
