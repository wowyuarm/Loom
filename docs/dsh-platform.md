# DSH 底座与核对路径

Loom 复用 DeepSeek Harness（DSH）的插件组合、模型、循环、Session、工具和存储。本文说明如何找对依赖契约与组合接缝，不代替上游参考，也不把上游最新能力当作 Loom 当前事实。Loom 自己的协作见[架构](<architecture.md>)，操作见[部署](<cookbook/deployment.md>)与[扩展](<cookbook/extending.md>)。

## 先确认实际版本

[package.json](<../package.json>)声明工程使用的 DSH 包，[npm lockfile](<../package-lock.json>)确定安装结果；[仓库启动器](<../bin/loom.mjs>)使用其中的本地运行时。不要用全局 `dsh` 或 npm `latest` 推断本仓库的版本。

```sh
node bin/loom.mjs --version
npm ls @deepseek-ai/dsh @deepseek-ai/dsh-base @deepseek-ai/cordis
```

[上游仓库](<https://github.com/deepseek-ai/deepseek-harness>)与[上游文档](<https://deepseek-harness.github.io/deepseek-harness/>)用于定位和理解。旁边即使有 DSH checkout，也须核对其版本、提交和本次涉及的实现是否与安装包一致；安装包的导出声明和实际代码才是当前运行栈的契约。需要未发布行为时，先单独处理依赖升级，不把新 API 顺手写进 Loom。

## 组合模型

- **Plugin** 是一个可挂载能力，通过 Cordis 服务、事件与 effect 注册协作。
- **Bundle** 由包的 `dsh.bundle.patch` 声明一份或多份有序 patch；Loom 当前发布 [Host](<../cordis.patch.yml>)和 [Preset 声明](<../presets/loom.patch.yml>)两份。
- **Profile** 用自己的 package manifest 选择有序 Bundle，并加部署 patch。Loom 的常驻渠道入口不需要另一个 app Bundle；headless/web 等入口会带来它们自己的 Agent 生命周期，不能当作主主体的同义入口。

当前 launcher 的覆盖顺序是：**Bundle 列表 → Profile patch → DSH home patch → 命令行 `--patch`**。home 层比 Profile 晚，会覆盖所有使用该 home 的 Profile；排错不能只读 Profile 文件。启动器还可能应用明确的环境策略，例如 telemetry opt-out。

Patch 用两种不同的条目：顶层 `id` 修改已有行，`insert` 添加行。`config` 是整份替换，不深合并；改已有行时先读组合后的完整配置。`disabled: true` 保留并关闭行。`!!js` 在组合预览中保留表达式，在挂载时求值；不要把预览里的表达式当成已验证路径。

模块名可以是包子路径、相对模块或 file URL。相对路径以声明该行的 patch 目录为基准；Bundle 和模块解析还使用运行时安装及 Profile 锚点。实际查找顺序和 provenance 应核对同版本 app-boot/loader，而不是凭启动 cwd 猜测。

## 沿接缝找上游

下表是阅读路由，不是第二份 API 签名表。安装后在相应 `node_modules/@deepseek-ai/<包>` 的导出声明与代码中定位；对应源码目录在上游仓库。

| 本次涉及的问题 | 上游包族 / 接缝 | Loom 中的消费者或证据 |
| --- | --- | --- |
| 清单、覆盖、路径、兼容性检查 | `dsh-app-boot`、`cordis-plugin-include`、`cordis-plugin-loader` | [Bundle 测试](<../tests/bundle-manifest.spec.ts>)、[包声明](<../package.json>) |
| service / event / waterfall / effect | `cordis` | [contracts](<../src/contracts/index.ts>)与各插件 `inject` / `apply` |
| 提示 section、动态 context 与请求组装 | `dsh-system-prompt`、`dsh-agent-loop` | [材料](<subsystems/materials.md>)、[resident-context 测试](<../tests/resident-context.spec.ts>) |
| Agent 创建、写租约、输入与模型选择 | `dsh-agent`、`dsh-agent-loop`、`dsh-agent-default-model` | [运行时](<subsystems/runtime.md>)、[模型切换](<subsystems/model-switch.md>) |
| 模型适配器、请求及 provider 元数据 | `dsh-llm` 与所选 provider | [mock adapter](<../tests/support/mock-adapter.ts>)、[boot-live](<../tests/boot-live.spec.ts>) |
| Session 事件、投影与检索 | `dsh-session`、`dsh-session-projection`、`dsh-session-query-*`、`dsh-session-persistence-*` | [连续性检索](<../src/context-continuity/retrieval.ts>) |
| 校验过的 KV domain 与底层 medium | `dsh-storage`、`dsh-storage-domain`、`dsh-storage-sqlite` | [域声明](<../src/runtime-state/domain.ts>)、[状态测试](<../tests/runtime-state.spec.ts>) |
| Agent plane、scope 与 isolate realm | `dsh-agent-preset-registry`、`dsh-agent-preset` | [Preset](<../presets/loom.patch.yml>)、[创建窗口](<../src/agent-runtime/index.ts>) |
| 工具执行、文件权限、后台 jobs | `dsh-tools`、`dsh-tool-*`、`dsh-sandbox-*`、`dsh-jobs-*` | [运行时权限](<subsystems/runtime.md#存储与权限边界>)、[Preset](<../presets/loom.patch.yml>) |
| 技能 catalog、发现与正文读取 | `dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill` | [技能包装层](<../src/skills/index.ts>) |
| 配置与模块热重载 | `dsh-hmr`、loader、可编辑配置 | [部署指南](<cookbook/deployment.md>) |
| 子 agent 委托（Loom 未用） | `dsh-subagent` 及其 `ctx.tools.restrict({allow})` | Loom 只跑一个主主体，不委托子 agent；`restrict` 在 Loom 内无调用者 |

Loom 也依赖独立发布的 continuity、jev 与渠道网关包。版本同样以 lockfile 为准，它们不是 DSH 内置功能；continuity 的 Host 适配在[能力页](<subsystems/continuity.md>)，网关授权与传输在[渠道页](<subsystems/channels.md>)，不要把提供方的行为归给包装层。

`ctx.tools.restrict({ allow })` 容易被读成"声明某个 agent 工具面"的接缝，它不是：上游唯一的生产调用者是 `dsh-subagent` 给子 agent 过滤继承能力，而 Loom 只有一个主主体、不建子 agent，所以本仓库没有调用点。声明 agent 能力面走 [Preset 清单](<../presets/loom.patch.yml>)。

## 两条提示排序轴

System sections 与动态 contexts 独立排序，order 不能跨两块比较。动态函数在 assembly 中现读，DSH loop 管理快照持久记录和重注入；“现读”不意味着每个 Step 追加一份重复文本。Loom 的具体位置与预算见[材料参考](<subsystems/materials.md>)。

事件通常是全局广播，监听器必须明确是否过滤主 Session；不要从服务名猜它只作用于主主体。返回 disposer 的注册和异步资源关闭应由 effect 持有并等待完成，尤其是持久化设施。新增能力的操作例子见[开发指南](<cookbook/adding-capability.md>)。

## 验证与升级边界

配置 dump 只检查组合，不导入并激活每个插件，也不证明 credential、sandbox 或真实请求可用。测试栈、实际挂载和真实外部效果是不同证据，选择见[开发指南](<development.md>)。

升级需单独检查包名、导出、配置字段、事件、provider 路由与持久数据兼容性。不要用版本豁免跳过未知风险；先在隔离 home 验证组合、受影响测试及一次有明确成功判据的真实请求。真实部署的重启、凭据与外部发送必须由拥有该操作授权的人执行，不能借文档验证隐式触发。
