# Loom (next)

Loom 是面向长期关系主体的 Agent Harness：一个 Runtime Instance 只承载一个 Agent Individual，Harness 提供连续时间、Workspace、认知材料和可靠的对外行动条件，但不内置 Individual 的身份、关系或判断。

本仓库是 Loom 在 **DeepSeek Harness（DSH / Cordis）** 之上的重做，遵循 everything-is-a-plugin：没有不可替换的特权 core，能力由插件贡献、由 profile/bundle 装配。做完后将覆盖既有的 `wowyuarm/Loom`。

## 现状

设计收敛阶段，尚无源码。当前进行中的设计见 [`.scratch/active/`](.scratch/README.md)：

- **continuity-and-memory** — 连续性 Individual 的 session（记录层）与 memory（理解层）设计。

## 依赖姿态

- 构建于 `@deepseek-ai/dsh`（Cordis）之上。
- 复用已发布的 `@wowyuarm/dsh-context-continuity` 做 session 连续性与召回。
- jev（typesafe.ai）作为可插入的 System 1 model，非阻塞。
