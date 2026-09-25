# Repository Guidelines

## Scope and authority

Loom 是面向长期关系主体的 Agent Harness，在 DeepSeek Harness（DSH / Cordis）之上重做，遵循 everything-is-a-plugin：没有不可替换的特权 core。一个 Runtime Instance 只承载一个 Agent Individual；Harness 提供存在条件，不内置身份、关系或判断。

Read [`docs/AGENTS.md`](docs/AGENTS.md) first —— 它是 `docs/` 的入口：索引与维护纪律，按任务路由到需要的文档，不必通读。

Use this authority order:

1. **Current behavior:** 源码与测试。当文字与代码不一致时，以代码为准。
2. **Maintained docs:** `docs/` —— 稳定的模块关系、术语和工作约定。它随代码或工作流变化而更新，不定义代码没实现的行为。索引见 [`docs/AGENTS.md`](docs/AGENTS.md)。
3. **DSH contract:** `@deepseek-ai/dsh` 及相关包的官方文档与源码。
4. **Work history:** `.scratch/` —— 进行中的设计、研究、tickets、原型和验收证据。源码落地之前，`.scratch/active/` 是进行中设计的主要依据；落地之后代码优先。其工作规则见 [`.scratch/AGENTS.md`](.scratch/AGENTS.md)，索引见 [`.scratch/README.md`](.scratch/README.md)。

## Reading guidance

- **从任务出发**：先读任务和它明确引用的代码、测试、scratch 记录，再按缺口展开；不要因为文件存在就通读整个仓库。
- **设计或实现任何能力前，先读 DSH 对应子系统的源码和已有插件，照它的做法来。** DSH 是“怎么做”的第一参考，不是只在术语对不上时才查：组合（bundle / `cordis.patch.yml` / profile）、service 与 event 接缝、`defineTool`、`storage-domain`、patch 层、命名、测试方式——有现成惯例就照搬，不自创。实例仓：`~/projects/deepseek-harness`（当前 0.1.6-alpha.2）、`~/projects/dsh-agent-team`（单一适配先例）、`~/projects/dsh-context-continuity`。
- 已摸清的 DSH 组合模型、接缝清单、跑部署的方法和踩过的坑写在 [`docs/dsh-platform.md`](docs/dsh-platform.md)：**先读它再翻源码**，发现它与实际不符就修正它。
- `docs/AGENTS.md` 的索引表按问题取用（“什么时候读/写”那一列）；一个能力一篇 `docs/subsystems/<capability>.md`，随模块落地补入。
- 稳定术语和边界见 `CONTEXT.md`（落地后建立），不可逆的持久化/恢复取舍见 `docs/adr/`。

## Guardrails

- 任务范围、依赖、完成证据不清时，先指出缺口，不把猜测写成代码。
- 不过度防御或过度设计。只处理已存在或边界上合理可预见的问题；能用现有结构解决就不加抽象、配置、兼容层、回退路径。
- 不提交凭据、个人 Instance Root 或运行数据。

## Conventions

- 代码风格自解释；注释只写代码看不出的约束、原因和安全条件。
- 命名贴合工程实际（它干什么就叫什么），不用抽象平面 / 层号命名。
- 一个提交对应一个闭合工作单元；commit message 用简短一行英语 `type(scope): 描述`。
- 复用 DSH 原语和已发布插件，不重造。

## Composition and extension

Loom 自身就是一个 DSH bundle，不是一堆静态层。遵守以下约束，才能做到 everything-is-a-plugin（可替换、可打补丁）：

- **组合用清单，不写接线函数。** 一次部署 = 一份 `cordis.patch.yml`（包声明 `dsh.bundle.patch`），按 `id/name/inject/config` 列出要加载的 DSH 核心插件 + Loom 能力插件，由 DSH 的 plugin loader 挂载。不用硬编码把各模块 import 进来统一接线的装配函数。
- **每个能力是一个独立 Cordis 插件，只经接缝交互。** 只通过 ctx service / event 和 DSH 现成接缝（`systemPrompt.context()`、`tools.register()`、agent inbox、生命周期事件等）接入；插件之间不 import 彼此的实现，只依赖 `contracts` 里的接口。
- **接口与实现分开。** service 的接口放 `contracts`（纯类型），实现分插件；消费方 `inject` service 名、用接口，不碰具体类。这样才能独立替换、独立发版。
- **替换与打补丁用 loader，不自建机制。** 替换 = 清单里换成另一个提供同一 service 的插件；打补丁 = 叠 profile / `--patch` 层或加一个 wrapper 插件，用 DSH 现成的 waterfall / event 接缝包住原行为。不自建注册表 / DI / 热替换——那是 Cordis 和 loader 的职责，再造一套就是把 harness 重新发明一遍。
- **包拆分按收益推进。** 先在单仓以独立插件模块形式共存，只要守住“只经 ctx / contracts 交互”，拆成 `@loom/*` 独立包就是机械提取；跨码跑通之前不拆，也不预建空包。
