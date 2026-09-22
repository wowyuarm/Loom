# Repository Guidelines

## Scope and authority

Loom 是面向长期关系主体的 Agent Harness，在 DeepSeek Harness（DSH / Cordis）之上重做，遵循 everything-is-a-plugin：没有不可替换的特权 core。一个 Runtime Instance 只承载一个 Agent Individual；Harness 提供存在条件，不内置身份、关系或判断。

Use this authority order:

1. **Current behavior:** 源码与测试。当文字与代码不一致时，以代码为准。
2. **Work history:** `.scratch/` —— 进行中的设计、研究、tickets、原型和验收证据。源码落地之前，`.scratch/active/` 是进行中设计的主要依据；落地之后代码优先。其工作规则见 [`.scratch/AGENTS.md`](.scratch/AGENTS.md)，索引见 [`.scratch/README.md`](.scratch/README.md)。
3. **DSH contract:** `@deepseek-ai/dsh` 及相关包的官方文档与源码。

## Guardrails

- 任务范围、依赖、完成证据不清时，先指出缺口，不把猜测写成代码。
- 不过度防御或过度设计。只处理已存在或边界上合理可预见的问题；能用现有结构解决就不加抽象、配置、兼容层、回退路径。
- 不提交凭据、个人 Instance Root 或运行数据。

## Conventions

- 代码风格自解释；注释只写代码看不出的约束、原因和安全条件。
- 一个提交对应一个闭合工作单元；commit message 用简短一行英语 `type(scope): 描述`。
- 复用 DSH 原语和已发布插件，不重造。
