# Loom

Loom 是面向长期关系主体的 Agent Harness。它提供持续存在、成长、私人工作和可靠外部行动所需的条件，但不内置某个 Agent Individual 的人格、关系或关切。

当前 Runtime Instance 已连接 Main Agent、Agent Workspace、Cognitive Organs、Scheduler、nmem Integration 和 Process Driver。foreground Host 可以独占并持续运行一个 Instance Root；Weixin 支持文字、单张入站图片和单个出站附件。Loom 提供最小初始化入口，但不负责 OS service 安装或替 Agent Individual 生成身份。

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

初始化一个 Instance Root：

```bash
npm run build
node dist/src/cli.js init --root /path/to/.loom
```

初始化会写入两份 Harness-owned 默认 Behavior、`configuration/instance.yaml` 和 `templates/workspace/` 下的四份非生效模板，并创建 Pi 配置目录。它不会覆盖已有文件，也不会把模板直接变成 Identity、Stable Facts、Long-term Memory 或 Current Attention。

按命令返回的映射补齐以下 active material 后，Instance Root 才具备 Workspace 前置条件：

```text
workspace/facts.json
workspace/identity.md
workspace/memory.md
workspace/attention.md
```

随后在 `configuration/instance.yaml` 配置 `models.default`，并按 Pi 格式提供 `configuration/pi/auth.json`；自定义 provider/model 定义仍由 Pi 的 `models.json` 管理。Weixin 接入见 [Weixin Integration](docs/integrations/weixin.md)。

运行 Instance：

```bash
node dist/src/cli.js run --root /path/to/.loom
```

该入口保持前台运行，并在 `SIGINT` 或 `SIGTERM` 后等待当前工作自然结束。缺少必要 Workspace 材料或配置文件损坏时会直接拒绝打开；模型或认证尚未就绪时，Host 保持运行并把 Agent work 标记为 blocked。
