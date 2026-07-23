# Loom

Loom 是面向长期关系主体的 Agent Harness。它提供持续存在、成长、私人工作和可靠外部行动所需的条件，但不内置某个 Agent Individual 的人格、关系或关切。

当前 Runtime Instance 已连接 Main Agent、Agent Workspace、Cognitive Organs、Scheduler、nmem Integration 和 Process Driver。foreground Host 可以独占并持续运行一个已经准备好的 Instance Root；Weixin、`loom init` 和 OS service 接入尚未完成。

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

运行已准备好的 Instance：

```bash
node dist/src/cli.js run --root /path/to/.loom
```

该入口保持前台运行，并在 `SIGINT` 或 `SIGTERM` 后等待当前工作自然结束。Instance Root 必须已经包含完整 Workspace 材料；初始化入口会在后续工作中提供。
