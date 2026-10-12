# 安装或替换插件

给一个 Loom 部署加能力，或替换现有能力的提供方。改的是部署的 Profile 层，不改 loom 包本身；要改的是 Loom 自身行为时走[新增能力](<adding-capability.md>)。patch 条目语义见[DSH 底座](<../dsh-platform.md>)。

## 两种形态

**npm 包。** 用启动器的 plugin 命令装进指定 Profile 的 node_modules：

```sh
DSH_HOME=<部署 home> node bin/loom.mjs plugin --profile <名> add <包名>
```

包自带的 `cordis.patch.yml`（`dsh.bundle.patch`）会作为 Bundle 层进入组合——前提是包被加进 Profile 的 bundles 列表或经启动器登记；只装依赖不进 bundles 列表的包不会自动挂载。不带 `DSH_HOME` 时按默认 home 找 Profile，会找不到你的部署。

**本地文件。** 写一个 `.mjs` 放进 Profile 目录，在 Profile 的 `cordis.patch.yml` 里 `insert`：

```yaml
- insert:
    - id: my-plugin
      name: './my-plugin.mjs'
```

相对路径以**声明它的那份 patch 所在目录**为基准：Profile 自己的 patch 里 `./` 是 Profile 目录；`--patch` overlay 里用绝对路径或 `file://`。

最小插件形状：

```js
export const name = 'my-plugin'        // 日志与报错里的名字
export const inject = ['tools']        // 需要的服务；不齐则不挂载（最常见的"没反应"）
export function apply(ctx, config) { /* 经 ctx 注册能力，返回 disposer 由 effect 持有 */ }
```

接配置导出 Schemastery schema：`export const Config = Schema.object({...})`。

## 替换现有提供方

同服务名后者覆盖前者：在 Profile patch 用**同 id** 指到新的 `name`（实现），或在 bundles 顺序中让后加载的 Bundle 提供同 id 行。消费方只认服务接口（见 [contracts](<../../src/contracts/index.ts>)），所以替换不需要改消费方——这正是接缝的意义。替换前确认新实现满足同一接口的行为约定（事件、时机、失败语义），接口签名相同不等于行为兼容。

## 加之前核对

- **版本线**：包的 peerDependencies 对得上部署锁定的 DSH 版本；小版本差可能改包名、配置字段、事件。
- **服务**：`inject` 的服务在你的组合里存在；缺了会静默不挂载。
- **顺序**：需要先于某插件监听的（如对 `agent/created` 的监听要早于 `agent-runtime`）在清单中排前。
- **重复 id**：组合树中一个 id 一行；意外多出一行说明插错层。

## 验证与排错

1. `DSH_HOME=<隔离 home> node bin/loom.mjs --profile <名> --dump-config` 确认行在组合树里、来源对。
2. 真启动一次，看 stderr 有没有 `did not activate`（行没挂上：不存在的 id、`!!js` 求值失败）或 `failed to import`（路径解析错——overlay 里改绝对路径）。
3. 装了但 `cannot find package`：装进别的 node_modules 了，必须在该 Profile 的 node_modules 或启动器安装里。

行为级验证（工具真的可调、事件真的触发）需要按[开发指南](<../development.md>)选对应测试，dump-config 证明不了行为。
