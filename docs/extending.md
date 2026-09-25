# 扩展一个 Loom 部署

Loom 发布出来的是两样东西：一个 **bundle**（`cordis.patch.yml` 的组合清单）和一个 **agent preset**（`presets/loom.patch.yml`，这个 agent 能做什么）。它们带通用能力和安全默认。

你给自己部署加东西，加在它**外面**——不改 loom 包。本文讲怎么加。

组合机制本身（patch 的两种条目、`!!js`、怎么跑部署）在 [`dsh-platform.md`](dsh-platform.md) 第二、三节，本文不重复。

---

## 一、三层落点：你的东西写在哪

DSH 的组合是一层层 patch 叠出来的，后面的盖前面的：

```
  1  bundle 层     package.json 的 dsh.profile.bundles（base → loom）
  2  profile 层    $DSH_HOME/profiles/<名字>/cordis.patch.yml
  3  home 层       $DSH_HOME/cordis.patch.yml
  4  --patch       启动时临时叠加
```

判断放哪：

| 你的东西 | 放哪 |
| --- | --- |
| 只给这一个 Loom 部署用（模型选择、谁能跟它说话、专属工具） | **profile 层**（第 2 层） |
| 这台机器上所有 dsh profile 都要（公司 SDK、通用工具） | **home 层**（第 3 层） |
| 通用能力，值得发给所有 Loom 用户 | bundle 层——但那是改 loom 包本身，不是扩展 |
| 一次性试验 | `--patch` |

**安全默认是"谁都不许"**：Loom 的 `channel-gateway` 默认 `allow: []`，一个能跟你 agent 说话的渠道都不开。部署时必须自己写进去。

---

## 二、加一个 plugin：两种形态

### 形态 A：本地文件（最快）

两步。第一步，把 plugin 写进 profile 目录：

```js
// $DSH_HOME/profiles/<名字>/my-plugin.mjs
export const name = 'my-plugin'
export const inject = ['tools']

export function apply(ctx) {
  // 在 ctx 上注册能力
}
```

第二步，在 profile 自己的 `cordis.patch.yml` 里 `insert` 它：

```yaml
- insert:
    - id: my-plugin
      name: './my-plugin.mjs'
```

**路径怎么解析**：相对路径的基准是**声明它的那个 patch 文件所在的目录**。

- 在 profile 自己的 `cordis.patch.yml` 里 → 相对 profile 目录，`./my-plugin.mjs` 就是同目录下那个文件。**这条已实测可用。**
- 在 `--patch` overlay 里 → 相对 overlay 文件所在目录。所以 overlay 里请写绝对路径或 `file://` URL，否则会去 overlay 所在目录找。

### 形态 B：npm 包（复用别人的）

```sh
dsh plugin --profile <名字> add <包名>
```

它会用 **pnpm** 把包装进该 profile 的 `node_modules`，包自带的 `cordis.patch.yml` 会被带进来。

两个坑：

- **pnpm 11 的 `minimumReleaseAge` 默认 1440 分钟**，24 小时内发布的新版本会被跳过，而且**不报错**、`@latest` 悄悄解析到上一个版本。要装刚发布的版本就写死版本号。
- 全局的 `dsh` 和某个部署的 profile 是两回事。`dsh plugin --profile loom add ...` 如果敲的是全局 dsh，它按默认的 `DSH_HOME`（`~/.dsh`）去找 profile，找不到 `loom`。给自己的部署装东西要先 `DSH_HOME=<你的部署根>`，或者直接用那个部署自己的 dsh。

---

## 三、plugin 的最小形状

一个 plugin 就是一个导出 `apply` 的模块：

```js
export const name = 'my-plugin'      // 日志和报错里的名字
export const inject = ['tools']      // 需要哪些服务；齐了才加载
export function apply(ctx, config) { /* 注册能力 */ }
```

三件要知道的事：

- **`inject` 是等待，不是可选**。写进去的服务没就绪，plugin 就不加载。所以 `inject` 里多写一个不存在的服务，plugin 会静默不生效——这是最常见的"写对了但没反应"。
- **注册通过 `ctx`，卸载自动清理**。事件、工具、定时器都随 plugin 卸载消失。需要显式清理的资源（网络连接、文件句柄）用 `ctx.effect(() => { ...; return disposer })`。
- **要接配置就导出 Schemastery schema**，不能是普通对象：

```js
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
})

export function apply(ctx, config) { console.log(config.greeting) }
```

---

## 四、动手前先核对三件事

省下大量白费功夫。**用 `--dump-config` 就能看出大半，不花钱。**

**1. dsh 版本线。** 包装的 `dsh.compatibility` / `peerDependencies` 要和你的部署对得上。DSH 每个小版本都可能改内部 API 和包名——例如 `0.1.6 → 0.1.7` 把 `@deepseek-ai/dsh-agent-presets` 改名成了 `dsh-agent-preset-registry` + `dsh-agent-preset`。

**2. 平台。** 声明了 `dsh.client.platform: web` 的插件是给界面用的，在 Loom 这种无界面部署里不会挂。它的核心（比如模型适配器）可能仍然可用，界面部分自动跳过。

**3. 依赖的服务在不在。** 看 `inject` 列的服务你在组合里有没有。宿主平面（host plane）默认提供：`tools`、`skill`、`web`、`subagents` 注册表，shell 与 sandbox 栈，持久化，以及模型路由。

核对完，用 `dsh --profile <名字> --dump-config | grep <包名>` 确认它真的进了组合树。

---

## 五、完整例子：加一个工具

把工具注册进 `tools` 服务，agent 就能调用。这是实测跑通的完整例子（agent 真的调用了它并拿到返回值）：

```js
// $DSH_HOME/profiles/<名字>/example-plugin.mjs
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'loom-example'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deployment_home',
    description: 'Report where this deployment keeps its durable state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { home: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.home }],
    },
    execute(_args, exec) {
      return { home: `${process.env.DSH_HOME ?? '(unset)'} / session ${exec.agent?.id ?? '(none)'}` }
    },
  }))
}
```

配套的 `cordis.patch.yml`：

```yaml
- insert:
    - id: loom-example
      name: './example-plugin.mjs'
```

三点值得注意：

- **`output.schema` 是返回值的契约**，`render` 决定模型看到什么。`execute` 返回的对象要满足 schema。
- **`exec.agent` 给你发起调用的那个 agent**（`exec.agent.id` 就是它的 session id）。没有 agent 调用者时它是 `undefined`——需要 session 上下文的工具要自己判空并报错。
- **工具注册到宿主层，这个 agent 就看得见**。Loom 的 agent 平面由 preset 决定，但 profile 层插入的工具会注册到全局层，agent 继承它。这就是"部署是最终权威"。

想加**模型 provider**（接第三方网关、公司内网模型）走的是同一套 `insert`：插一个声明 provider 路由的 plugin，密钥按它要求的方式给（环境变量或 `$DSH_HOME/.credentials.yaml`）。选定的模型在 `agent-default-model` 那行配置。

---

## 六、给部署写 profile：两个硬要求

profile 的 `package.json` 必须**同时有非空的 `name` 和 `version`**：

```json
{
  "name": "loom-deployment-profile",
  "version": "0.0.0",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "loom"] } }
}
```

漏掉 `version` 的后果不是启动失败，而是**每一个模型请求都失败**：

```
DeepSeek request extension preparation failed  (REQUEST_EXTENSION)
```

原因是 DSH 有一个插件清单上报器，它会遍历所有活跃包并要求每个都声明 name + version。请求本身看起来正常，只有回合结束时才报错——只看"回合结束了"会误判成成功。

（这个上报器默认把**插件清单**和**会话日志**附在每次 DeepSeek 请求里，两者都能用 `enabled: false` 关掉。）

---

## 七、排错

按这个顺序查，能覆盖绝大多数情况：

| 现象 | 先查什么 |
| --- | --- |
| plugin 完全没反应 | `--dump-config` 里在不在？不在 → patch 没生效（id 撞了、层级不对）。在 → 看 `inject` 的服务是否齐 |
| 启动打印 `X did not activate` | 那条 patch 条目没挂上。通常是不存在的行 id，或 `!!js` 求值失败 |
| `failed to import <路径>` | 路径解析错了。overlay 里的相对路径按 overlay 目录算，改用绝对路径 |
| 模块装了但 "cannot find package" | 装到了别的 `node_modules`。npm 包要装在**这个 profile** 的 `node_modules` 里 |
| 回合"结束"了但没回复 | 看 `turn/end` 的 `reason`。`{"kind":"error"}` 才是真相，`turn/end` 本身不代表成功 |

改动要生效需要**重启部署**：bundle 和 profile 的 patch 在启动时组合一次。

---

## 关于那份 loom 包

上面所有做法都是**部署侧**的。loom 包本身保持通用：它带安全默认（渠道谁都不许），不写死任何个人配置。你的授权、模型选择、密钥、专属插件都留在自己的部署里——这也是为什么这份文档不讲"改 loom 的 `cordis.patch.yml`"。

要改的确实是 loom 该有的通用能力时，那才回到 bundle 层：改 `cordis.patch.yml`（宿主平面）或 `presets/loom.patch.yml`（agent 平面），并按 [docs/AGENTS.md](AGENTS.md) 的路由更新受影响的文档和测试。
