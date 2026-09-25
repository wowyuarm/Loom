# DSH 底座：模型、接缝与操作

Loom 是坐在 DeepSeek Harness（DSH）上的一个 bundle。本文写 **DSH 的组合模型、Loom 实际用到的接缝，以及怎么把一个 Loom 部署跑起来**——都是已在真实运行中验证过的事实。

动手改任何能力前先读 DSH 对应子系统的源码和已有插件（根 [`AGENTS.md`](../AGENTS.md) 的规矩）；本文只给地图和已经踩实的路，不替代读源码。

## 一、Loom 在哪一层

DSH 是一棵 Cordis 插件树，一切都是插件。组合靠三层，没有接线函数：

| 概念 | 是什么 | 例子 |
| --- | --- | --- |
| plugin | 一个能力，经 `ctx` 服务与事件交互 | `@deepseek-ai/dsh-agent-loop` |
| bundle | 一份插件清单（patch），包自带 | `@deepseek-ai/dsh-base`、`loom` |
| profile | 有序 bundle 列表 + 自己的 patch 层 | `$DSH_HOME/profiles/<name>/` |

**Loom 是 bundle，不是 app。** 一个完整部署是三段叠加：

```
  dsh-base          标准栈：llm / session / agent / agent-loop / tools /
                    system-prompt / sandbox / skill / compaction / credentials
+ 一个 app bundle   人机入口：headless / web / acp / sdk
+ loom              让这套栈成为一个持续存在的 agent
```

app bundle 是可替换的：将来 channels（Telegram 等）就是 Loom 自己的入口，那时不必要人机 app。

**Loom 只换上层、复用底层，是顺着 DSH 的纹理走，不是硬改。** DSH 的底层机制——turn/step 循环、service/event/waterfall 接缝、session/storage/sandbox——是中立的，不预设 agent 是干什么的；"编码 agent" 的味道集中在上层那批任务脚手架插件（`goal`、`plan-mode`、`tool-todo`、`tool-ralph` 及其工具面）。Loom 在 `cordis.patch.yml` 里禁掉的正是这层脚手架，复用的是中立底层，所以转向发生在配置层，不需要 fork 或改 DSH 内部。这也是复用 92 个插件里保留约 67 个、只自写 7 个插件就能把 "编码 CLI" 改造成 "持续存在的个体" 的原因。

## 二、组合机制（写 bundle patch 必须知道）

包的 `package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，loader 据此挂载。

patch 文件是一个操作列表，**两种条目，语义完全不同**：

```yaml
# 改已有行：顶层 id。注意 config 是整份替换，不是合并 —— 要把该行配置写全
- id: storage-domain
  config:
    backend: json            # base 原有的值也必须重述，否则丢失
    routes:
      loom_runtime_state: sqlite

# 新增行：insert
- insert:
    - id: clock
      name: 'loom/clock'
```

其它要点：

- **叠加顺序**：bundle 按 profile 列表顺序 → profile 自己的 patch → 启动器 `--patch`。同一 id 后写的赢。
- **`!!js` 表达式在组合期不求值**，composeEntries 里是 `{__jsExpr: "..."}`，挂载期才算。可用词汇：`dshHomePath('...')`、`process.env`、`process.cwd()`、`ctx.get(...)`。
- **插件 `name` 是模块标识符**，loader 要能解析。单包多插件就用子路径导出（`loom/clock` ← package.json `exports` 的 `./clock`）。
- 关掉某行用 `disabled: true`，不是删除。

## 三、怎么跑一个部署

`$DSH_HOME` 是部署根：一个 home 就是一个部署，profile、session、storage、凭据都在里面。

profile 目录 = `package.json`（`dsh.profile.bundles` 有序列表）+ 可选的 `cordis.patch.yml`：

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "loom"] } } }
```

launcher 的两条关键命令：

| 命令 | 用途 |
| --- | --- |
| `dsh --profile <name> --dump-config` | 打印组合后的完整插件树并退出，**带来源标注**（`# == dsh-base, patched by loom`）。验证清单的第一手段，不花钱不联网。 |
| `dsh --profile <name> "<任务>"` | 配合 headless app 跑一次任务后退出。验证整栈真能挂载、真能跑一轮。 |

开发中的 bundle 让 profile 能解析到：在 profile 的 `node_modules/` 里软链到源码目录即可（profile 是第二解析锚点）。

### 版本对齐陷阱

- **npm 的 `latest` dist-tag 被故意压在一个很低的版本**（`dsh-base` 的 latest 是 `0.0.1-rc.1`），直接 `npm view <pkg> version` 会误导。要看 `versions` 列表并显式装对齐的版本；alpha 线在 `alpha` tag 上。
- 整套 DSH 包必须同版本线（Loom 当前钉在 `0.1.7-rc.2`），`dsh-base` 会把子插件 pin 在同线。
- **升一个小版本要预期包改名和配置字段增减**。`0.1.6 → 0.1.7` 就换掉了 preset 机制：`@deepseek-ai/dsh-agent-presets`（复数，根目录发现式）变成 `dsh-agent-preset-registry` + `dsh-agent-preset`（单数，声明式），旧配置字段（`roots`、`includeShippedRoot`、`includeUserRoot`）在 0.1.7 里一个都不存在。升级前先 `npm view <包>@<目标版本> version` 逐个确认存在，再看 `--dump-config` 有没有报错。
- `cordis` 版本要同时满足 DSH 的 peer（`^4.0.2`）和 loader/include 的 peer（`~4.0.4`）——取交集。

## 四、Loom 用到的接缝

| 接缝 | 用法 | 关键约束 |
| --- | --- | --- |
| service | `ctx.provide('name', impl)` / `inject = ['name']` | 名字裸用功能名（DSH 惯例），撞名在加载期直接报错 |
| 静态提示段 | `ctx.systemPrompt.section({name, order, text})` | 跨轮稳定；`deployment:persona-prefix` 占 order 0，base 留空 |
| 动态上下文 | `ctx.systemPrompt.context({name, order, text})` | **每轮重新求值**，`text` 用函数就能现读文件 |
| 工具 | `ctx.tools.register(defineTool({...}))` | 返回 disposer；`exec.agent?.id` 是 SessionId |
| KV 域 | `ctx.storageDomain.open(spec)` | 域名/表名必须匹配 `/^[a-z][a-z0-9_]*$/` |
| 会话投影 | `ctx.sessionProjections.register(def)` / `.stateOf(session, key)` | register 返回 disposer；投影按 key 全局注册一次，对每个 session 驱动 |
| agent 生命周期 | `ctx.agents.create({sessionId, meta})` / `.resume({resumeSessionId})` | 返回 handle，**disposer 是一种能力**：只有持有者能拆 |
| 会话事件 | `ctx.on('session/event', (session, event) => …)` | 全局广播，消费者自己按 session 过滤 |
| 轮次闸门 | `ctx.on('agent/pre-step', async ({agent, messages}, next) => …)` | waterfall，可返回 `{kind:'reject'}` 挡下这一步 |

两条**互相独立**的排序轴，渲染成两块，不要混淆：

```
  静态系统提示（sections）          动态上下文快照（contexts）
  0      persona-prefix（base 留空）  10   identity      ← 每轮现读
  100    loom:orientation            20/25 memory core/index
  500+   策略与工具 schema            30   threads-index
  10200  persona-suffix              40   attention
                                     110+ base 的 sandbox/approval
```

身份的落点：**persona 留空，identity.md 承载身份**。persona 是部署写死的静态段，identity.md 是 agent 自己长期维护、每轮现读的自我模型——Loom 选后者，因为身份该由 agent 自己攒。

## 五、验证分三层

| 层 | 怎么做 | 证明什么 |
| --- | --- | --- |
| 单元 | 真实现 + 打桩依赖（如真 runtime-state + 假 agent registry） | 编排逻辑、顺序、持久化语义 |
| 组装冒烟 | 最小栈 7 件（llm/session/projection/system-prompt/tools/agents/agent-loop）+ 脚本化 mock 模型 | 插件之间真的接得上、一轮真的能跑完 |
| 真部署 | `dsh --profile … --dump-config` 然后真跑一次 | 清单真组合、整栈真挂载、真模型真回答 |

mock 模型的配方来自 DSH 自己的 `agent-loop/tests/agent.spec.ts`：`AgentLoop` 配 `{agents: []}`（**loop 自己不建 agent**，留给插件驱动），`ctx.llm.registerAdapter(['mock'], adapter)` 注册脚本化 adapter，`agent.followup(msg)` 送输入，`await agent.whenIdle()` 等这一轮结束。

要真 key 的测试用环境变量 gate（没 key 自动 skip），默认套件保持离线确定。

## 六、踩过的坑

- **sqlite 键不能含 NUL**（`\u0000` 是 C 字符串终止符，会被截断）。复合键用 `JSON.stringify([a, b])` 编码，不要用分隔符拼接。
- **域的 close disposer 必须 await**（`ctx.effect(() => async () => { await domain.close() })`），否则重启时 sqlite 可能还没 flush。
- **域 global 的 `initial` 要类型断言**：TS 从字面量推出 `{}`，需要 `as` 到 schema 推导出的类型。
- **域 global 存不了 null**（那是"从未写过"的哨兵），要存可空的值就包一层对象。
- **用 `ctx.systemPrompt` / `ctx.tools` 前要副作用 import** 对应包，否则类型增强没加载。
- **patch 的 `config` 是整份替换**，改一行 base 的配置要把该行其它字段重述一遍。
- **`assemble()` 返回 Promise**，别忘了 await。

## 七、Loom 自己的约定

命名照 DSH（厂商前缀只加在包名和共享命名空间上）：

| 层 | 约定 | 例 |
| --- | --- | --- |
| 包 | `@loom/<cap>` | `@loom/runtime-state` |
| 插件 name / id | 裸功能名 | `runtime-state`、`agent-runtime` |
| ctx 服务 | 裸 camelCase | `ctx.runtimeState`、`ctx.clock` |
| 存储域 | `loom_<cap>` | `loom_runtime_state`（域是共享命名空间，要前缀） |
| 归属 id | `@loom/<cap>` | `@loom/context-continuity`（要全局唯一） |
| 模型可见的工具 | 裸 `verb_noun` | `memory_write`（模型不该看到厂商名） |

服务接口集中在 `src/contracts/`（纯类型 + ctx 类型增强，零实现）。插件之间**只经 ctx 服务与事件交互**，不互相 import 实现——这是"能被替换"的支点：换一个提供同名服务的插件即可，不需要改消费者。

## 八、把 DSH 当底座：性质与风险

前七节是已跑通的事实。本节把这个底座的性质和代价讲清，供跟版和长期运行时决策。已验证的事实与尚未验证的关注点分开标注。

把底座押在 DSH 上是对的选择——一个 agent harness 真正难写、且人人都要重造的通用底座（模型适配、可回放 session、agent 循环、工具、sandbox、持久化、compaction、凭据），DSH 已做成可替换插件且文档扎实，自研这些不会更好。代价是绑上了一个还在快速迭代的 preview，下面四条是已知性质和要守的纪律。

1. **仍在 developer preview，承诺破坏性变更（事实）。** DSH README 大写声明 `THERE WILL BE COMPATIBILITY-BREAKING CHANGES`，版本还在 alpha/rc 线。Loom 钉在 `0.1.7-rc.2` 并稳定一段时间，升级是单独的工作项（预检清单见上一节）。
   - 纪律：钉死一条版本线，不无理由追新；对 DSH 的接缝依赖收敛在 `src/contracts/`，上游改了只需动这一处。

2. **版本偏斜是已发生的真实故障（事实）。** 见 §三「版本对齐陷阱」——整套 DSH 包不同线会导致启动失败、session 序号撞号、日志损坏，且是同源反复出现的一簇问题。
   - 纪律：整套 DSH 包保持同版本线；升级第一道门是 `dsh --profile loom --dump-config`（离线、不花钱）核对组合树，再真跑一轮，别图快跳过。

3. **DeepSeek 生态是 base 的默认深绑（事实）。** base 默认挂 `dsh-llm-deepseek`、`dsh-deepseek-account-platform`、`session-log-deepseek`、`deepseek-llm-api-extensions`。因为一切是插件，这是"可换"（换一个提供同 service 的插件）而非"锁死"，但真要换到中立生态要付适配成本。
   - 纪律：清楚这是默认不是约束；需要中立时按插件替换，不要 fork DSH。

4. **长期运行下的持久化成熟度未验证（关注点，Loom 自身尚未观测到该故障）。** DSH 的 session 持久化在"一次性编码任务"场景下验证充分；Loom 是长期存在、持续接消息、长期高频写的 individual，负载 profile 与 DSH 的设计场景不同。同生态的 agent-team 项目已在此撞到性能坑（session read 记录偏胖 + 每批全量 replay 顶 CPU）——这是 Loom 独有形态最可能复现的坑。
   - 纪律：进入长期运行前，对 session/storage 做一次真实负载压测，别等撞墙才补。
