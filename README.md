# Loom

Loom 是面向长期关系主体的 Agent Harness。它提供持续存在、成长、私人工作和可靠外部行动所需的条件，但不内置某个 Agent Individual 的人格、关系或关切。

当前已完成 Runtime Store 的第一条核心事实链：input、主 Agent turn、effect、delivery attempt、lease 与崩溃恢复。Pi、真实 channel、schedule 和 Agent Workspace 尚未接入。

## 入口

- [协作规则](AGENTS.md)
- [项目术语](CONTEXT.md)
- [工程任务约定](docs/agents/issue-tracker.md)
- [Runtime Store 决策](docs/adr/0001-keep-runtime-store-concrete-and-internal.md)

## 开发

需要 Node `>=24.15.0`。

```bash
npm run typecheck
npm test
npm run build
```
