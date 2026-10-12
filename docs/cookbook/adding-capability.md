# 为 Loom 新增一个能力

在仓库里开发一个新插件或扩展现有插件的步骤。纪律见[根指令](<../../AGENTS.md>)与[架构](<../architecture.md>)；这是一条工作路径，不是模块清单模板——按职责切分，不为每个导出建插件。

## 步骤

1. **确认没有现成接缝。** 先查 DSH 对应子系统与已有 Loom 插件（路由见[DSH 底座](<../dsh-platform.md>)）；能复用服务/事件/工具/waterfall 就不自建机制。
2. **定义对外契约。** 提供哪个服务、发/听什么事件、注册什么工具、占哪个提示位置、用哪个存储域。共享接口写进 [contracts](<../../src/contracts/index.ts>)（纯类型与 ctx 增强）；消费方 inject，不 import 实现。
3. **写实现。** `src/<cap>/index.ts` 导出 `name`、`inject`、`apply`（需要配置再加 Schemastery `Config`）。资源与注册的 disposer 由 `ctx.effect` 持有并等待完成。package.json 加 `./<cap>` 子路径导出。
4. **接入组合。** Host 能力在 [cordis.patch.yml](<../../cordis.patch.yml>) `insert`；模型可见能力（工具、技能、提示）进 [Preset](<../../presets/loom.patch.yml>)，并在 Host patch 禁用对应 base 全局行。监听顺序敏感的（如 `agent/created`）排在被监听者之前。
5. **写测试。** 单元测试用真实现 + 打桩依赖；跨插件协作进 [boot-smoke](<../../tests/boot-smoke.spec.ts>) 风格的组装测试；组合变化由 [bundle-manifest](<../../tests/bundle-manifest.spec.ts>) 锁。需要真实模型的按 boot-live 的 key-gate 模式，不进默认套件。
6. **写文档。** 能力页按职责落进 `docs/subsystems/` 或更新相邻页，导航表加一行；模型可见行为、失败与恢复、权限影响不可缺。规则见[维护规则](<../AGENTS.md>)。
7. **验证并报告。** 按[开发指南](<../development.md#验证选择>)选证据，报告写明验证范围。

## 命名

沿用 DSH 惯例：插件 name/id 用裸功能名（`runtime-state`），ctx 服务裸 camelCase（`ctx.runtimeState`），存储域带 `loom_` 前缀（共享命名空间），模型可见工具用裸 `verb_noun`。归属 id（消息 source、notice 命名空间）用 `@loom/<cap>`。精确示例见现有 [contracts](<../../src/contracts/index.ts>) 与各插件。

## 验收前的自查

- 消费方能否在不知道实现的情况下替换提供方？（不能 → 接缝没走 ctx）
- 失败路径写了吗？（接受后失败、没有活句柄、存储写失败——各自的行为是什么）
- 文档声称的每条都能在源码或测试里指到吗？
- 有没有为假设的需求加抽象、兼容层或配置项？（有 → 删掉）
