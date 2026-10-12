# dsh-alignment — 逐模块对照 DSH

**状态：** 进行中
**最后核对：** 2026-09-24
**当前 frontier：** 第二轮完成，修正了第一轮的两处浅判断（检索包选错、换代谱系写错地方）。已修复：parentSession 链（`7e2e139`）、telemetry 禁用 + clock 注释（`5e8b038`）、compaction 恢复（`da7f77b`）。下一步：B 工作项（搜索 + 回返/checkpoint），开工前先深读 context-continuity 的 checkpoint 半边。
**完成条件：** 每个 Loom 模块都给出「DSH 提供什么 / Loom 做什么 / 是否重复 / 正确接缝在哪」的结论，且结论有源码或文档出处；需要用户拍板的取舍已列出。
**正式文档出口：** 稳定结论进 `docs/dsh-platform.md` 与各模块文档；本记录收口后归档。

## 为什么要做

此前多次在 DSH 上凭印象判断，导致选错方案（见「已确认的判断错误」）。本工作项的目标是把 Loom 的每个模块与 DSH 的对应子系统逐一对齐，用源码和文档而不是记忆来支撑决策。

## 来源

- DSH 源码：本地 DSH checkout（版本见 `package.json`）（本地 0.1.5-rc.2）
- Loom 依赖：`@deepseek-ai/*@0.1.6-alpha.2`
- 主要文档：`docs/architecture.md`、`docs/capability-seams.md`、`docs/subsystems/*.md`、`packages/*/README.md`、`.agents/notes/implemented/architecture/*.md`

---

## 一、DSH 的分层

一个运行中的 `dsh` 是启动时按有序层组合出来的插件树。

```
  profile            命名的组合，存在 Harness home 里
    ├─ bundle 列表   dsh-base + 应用 bundle + 部署自己的 bundle
    ├─ cordis.patch.yml
    └─ 外部插件
  bundle             一份 cordis 配置行 + 它们挂载的代码的分发格式
```

层的应用顺序：各 bundle 按 profile 列出的顺序 → profile 的 patch → home 级 patch → `--patch`。patch 按 id 命中一行并**替换整份 config**，或 insert 新行。

### 三条轴

| 轴 | 内容 | 谁拥有 |
|---|---|---|
| **host plane** | 注册表、策略、持久化、模型路由、进程单例 | bundle（`dsh-base`） |
| **agent plane** | 工具、提示段、技能 | agent preset（`agent.cordis.yml`） |
| **session log** | 模型可见的一切事实 | `ctx.sessions`，append-only |

### host plane / agent plane 的判定标准

来源：`.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md`

留在 host plane 的条件（满足任一）：
- 拥有**进程级**的投影单元（空值与真实值无法区分，如 `token-meter`）
- 是注册表，preset 行要从 realm 之外解析它（如 `tools`、`skills`、`web`、`subagents`）
- 是进程单例（如 subagent 注册表，provider 名全局唯一）
- 在任何 session 存在之前就要注入服务

否则可以归 agent plane。preset 里发布到 root realm 的服务会被 mount 审计拒绝。

**重要后果**：一个没有加入任何 preset 的 agent，在 preset 型部署里解析到的是空的全局层——模型什么工具都收不到，不报错。加入是一条 scope 父链链接，靠 `ctx.agentPresets.mount(agentCtx)` 在 agent 创建窗口里建立。

---

## 二、DSH 的核心服务与接缝

来源：`docs/capability-seams.md`（自动生成，权威）。

### 骨架

| ctx key | 角色 | 拥有者 |
|---|---|---|
| `ctx.sessions` | core | `session` — append-only 事件日志 + 内存 store |
| `ctx.systemPrompt` | core | `system-prompt` — 提示段、动态 context、工具 schema 组装 |
| `ctx.tools` | core | `tools` — 工具注册表 + 守卫执行管线 |
| `ctx.agents` | core | `agent` — 活 agent 句柄、create/resume 工厂接缝 |
| `ctx.agentLoop` | bundle | `agent-loop` — 唯一的循环实现 |
| `ctx.scope` | library | `scope` — 逐 agent 作用域注册原语 |

### 可替换接缝（seam = 接口 + 实现 + 消费者）

| ctx key | 实现 | 用途 |
|---|---|---|
| `ctx.llm` | `llm-deepseek`, `llm-pi-ai`, `llm-replay` | 模型适配器注册表 |
| `ctx.sessionPersistence` | `session-persistence-jsonl` | 会话持久化 |
| `ctx.sessionQuery` | `session-query-sqlite` | 会话读取、过滤、追踪、**全文搜索** |
| `ctx.storage` | `storage-json`, `storage-sqlite` | 非会话存储 hub |
| `ctx.fs` | `fs-local`, `fs-sandbox`, `fs-e2b` | 文件系统提供者 |
| `ctx.subprocess` | `subprocess-local`, `subprocess-e2b` | 进程生成 |
| `ctx.shell` | `bash-local`, `bash-sandbox`, `pwsh-local` | shell 执行器 |
| `ctx.terminals` | `terminal-bash` | 持久 PTY |
| `ctx.sandbox` | `sandbox-local` | 进程沙箱 |
| `ctx.approval` | — | 一次性权限决策 |
| `ctx.compaction` | `compaction-basic` | 上下文压缩 |
| `ctx.skills` | `skill-filesystem`, `skill-badge` | 技能提供者注册表 |
| `ctx.subagents` | `subagent-spawn-in-process`, `-fork-in-process`, 等 | 子 agent 提供者 |
| `ctx.web` | `web-search-deepseek`, `web-fetch-http`, 等 | 网络访问 |
| `ctx.jobs` | `jobs-local` | 后台任务注册表 |
| `ctx.spillStore` | `spill-local` | 超大工具输出落盘 |
| `ctx.settings` | `settings-file` | 用户设置 |
| `ctx.credentials` | `credentials-local` | 凭据 |
| `ctx.userQuestions` | — | **向人提问的接缝** |
| `ctx.attachments` | `attachment-local` | **持久二进制附件** |
| `ctx.webhookRuntime` | — | **外部投递启动 Session** |
| `ctx.lsp` | `lsp-stdio` | 语言服务器 |
| `ctx.codeRuntime` | `code-runtime-worker-thread` | 模型写的程序执行（PTC 模式用） |
| `ctx.sessionTelemetry` | `session-telemetry-otel` | 遥测 |

### 其他核心服务

| ctx key | 用途 |
|---|---|
| `ctx.sessionProjections` | 逐会话折叠单元注册表 |
| `ctx.sessionProjectionCache` | **投影状态持久检查点**（节流 + turn/end/detach 强制点） |
| `ctx.tokenMeter` | 逐会话重放 token 计量 |
| `ctx.toolResultPruner` | 无模型工具结果剪裁 |
| `ctx.agentPresets` | **逐会话 agent 组合** |
| `ctx.agentDefaultModel` | 默认模型选择（分层过 settings） |
| `ctx.commands` | **人直接下的命令，不经模型** |
| `ctx.invariants` | 包自有的不变式注册表 |
| `ctx.workspaceRegistry` | Workspace 实体注册表（走 domain facility） |
| `ctx.goals` | 同一会话内的目标域 |
| `ctx.planMode` | 计划协作状态 |
| `ctx.skills` | 技能目录合并 |
| `ctx.sessionTitle` | 日志支撑的会话标题 |
| `ctx.sessionReferenceResolver` | **跨会话快照准备**（作为不可信消息上下文注入） |
| `ctx.fileReferences` | 文件引用补全 |
| `ctx.messageFeedback` / `ctx.sessionFeedback` | 反馈记录 |

### 扩展点

来源：`docs/architecture.md`「Where new behavior goes」。

| 目标 | 机制 |
|---|---|
| 加模型提供者 | 在 `ctx.llm` 注册适配器 |
| 加面向模型的能力 | 在 `ctx.tools` 注册；schema 自动进入组装 |
| 给一个会话不同的能力集 | 组合 agent preset；服务行需要 `isolate` realm |
| 加人下的命令 | 在 `ctx.commands` 注册，不经模型回合 |
| 加后台工作 | 在 `ctx.jobs` 注册；`job_*` 工具收集或停止 |
| 从外部 webhook 启动 Session | 在 `ctx.webhookRuntime` 注册可信规则 + 挂提供者适配器 |
| 拦截请求、工具或回合 | 用对应的 `agent/*` 或 `tools/*` 事件 |
| 加面向模型的上下文 | 调 `agent.inject()`；落在下一个被接受的请求里 |
| 加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染与重放 |
| 给一个 agent 限定注册 | 用该 agent 的 `agent.ctx` |
| 派生一个会话 | `ctx.agents.create({ sessionId, seed, meta })` |

---

## 三、Loom 当前持有的能力

组合后 74 行启用、26 行禁用（实测 `dsh --profile loom --dump-config`）。

### Loom 自己的 8 行

```
  clock               loom/clock                时间源
  runtime-state       loom/runtime-state        指针 + 接收账本
  orientation         loom/orientation          机制提示段
  resident-context    loom/resident-context     常驻上下文 + memory_write
  agent-runtime       loom/agent-runtime        boot + 换代
  channel-gateway     @wowyuarm/...             通道接缝
  channel-telegram    @wowyuarm/.../telegram   Telegram 适配器
  channels            loom/channels             入站消费 + message 工具
```

### 已挂载但当前无人使用的能力（重要）

| 行 | 能力 | 现状 |
|---|---|---|
| `session-query-sqlite` | 会话全文搜索、追踪、读取 | 挂载了，但没有面向模型的消费者 |
| `session-projection-cache` | 投影状态持久检查点 | 挂载了；`context-continuity` 是否在用需确认 |
| `session-checkpoint-policy` | 请求前/副作用前/下一步前强制持久化，fail-closed | 挂载了，生效中 |
| `attachment-local` | 持久二进制附件存储 | 挂载了；channel 路径未接 |
| `spill-local` + `spill-policy` | 超大工具输出落盘 | 挂载了，生效中 |
| `commands` + `command-feedback` | 人直接下的命令 | 挂载了，Loom 未注册任何命令 |
| `user-questions` | 向人提问的接缝 | 挂载了；`tool-ask-user` 未挂，无消费者 |
| `image-offload` | 压缩时图片外置 | 挂载了 |
| `repeat-tool-reminder` | 重复工具调用提醒 | 挂载了，生效中 |
| `timeout-policy` | 工具调用超时策略 | 挂载了，生效中 |
| `ptc-runtime` + `workflow-ptc` | 程序化工具调用模式 | 挂载了；preset 未声明 |
| `subagent` + spawn/fork 后端 | 子 agent 注册表 | 挂载了；工具未声明（已决定不做） |
| `skill` | 技能注册表 | 挂载了；工具未声明（已决定不做） |
| `session-title` + `-llm` | 会话标题 | 挂载了 |
| `mcp-resources` | MCP 资源 | 挂载了 |
| `session-telemetry-otel` | 遥测 | 挂载了 |

---

## 四、逐模块对照

### 1. `contracts` — 纯接口与 ctx 增强

**DSH 提供：** Cordis 的 Service 模式（`ctx.provide`）与类型增强（`declare module`）。
**Loom 做：** 集中声明 `Clock`/`RuntimeState`/`AgentRuntime` 等接口，作为替换点。
**结论：** 与 DSH 惯例一致（DSH 每个包在自己入口声明 ctx 增强）。保留。

### 2. `clock` — 时间源

**DSH 提供：** 无时间接缝。`session`、`agent-loop` 等直接用 `Date.now()`。
**Loom 做：** `ctx.clock`，供 `channels`（acceptedAt）和 `memory-write`（writtenAt）使用。
**结论：** 不重复。但代码注释「Everything that needs 'now' reads it here」不成立——DSH 自己的部分不走它，所以「behavior eval 可以确定性地驱动时间」只是部分成立。
**待定：** 缩小注释表述，或评估这个接缝对行为评估的实际价值。

### 3. `runtime-state` — 当前会话指针 + 接收账本

**DSH 提供：** `ctx.storage` / `ctx.storageDomain`（domain facility，Loom 已用，路由到 sqlite）。
**Loom 做：** 持久化「当前是哪个 session 代」的指针 + 入站消息去重账本。
**结论：** DSH 没有「哪个 session 是活的当前代」这个概念（DSH 是多会话的），所以指针是 Loom 自己的。去重账本同理。
**注意：** 单活锁不在这里——create/resume 自带 DSH 跨进程写租约，重复进程会抛 `SessionAlreadyOwnedError`。

### 4. `resident-context` — 常驻上下文

**DSH 提供：** `ctx.systemPrompt` 的 context provider 机制；`ctx.tools.register`。
**Loom 做：** identity / memory / threads / attention 四个 context + `memory_write` 工具。
**结论：** 机制用对了。DSH 没有「记忆」概念，内容归 Loom。
**发现：** DSH 的 `dsh-agent-instructions` 是**另一个**机制——加载 `AGENTS.md` 兼容文件（用户全局 + 项目级）。Loom 的 workspace 设计原本要用它（`.scratch/active/workspace/README.md:56`「workspace/AGENTS.md 与 dsh-agent-instructions」），但我在 preset 改造时把它当「任务脚手架」禁用了。**这是我的判断错误。**

### 5. `context-continuity` — 换代宿主绑定

**DSH 提供：** 无「上下文换代」概念；`compaction` 是另一件事（压缩，不是换代）。
**Loom 做：** 绑定外部包 `@wowyuarm/dsh-context-continuity` 的宿主，持有 `executeTransition`。
**结论：** 不重复。
**待确认：** `session-projection-cache`（投影持久检查点）与连续性折叠是否有重叠或可复用之处。

### 6. `orientation` — 机制提示段

**DSH 提供：** `ctx.systemPrompt` 的 section 机制 + `{{variable}}` 插值（严格解析）。
**Loom 做：** `loom:orientation` section，order 100，`interpolate: false`。
**结论：** 用对了。DSH 的 `deployment:persona-prefix`（order 0）由 base 配置，Loom 保持为空，身份交给 `identity.md`。
**发现：** DSH 有 prompt variables 注册表（persona 用 `{{cwd}}`/`{{model}}`）。orientation 现在是静态文本，不需要变量；但若将来要写进动态值，走变量注册而不是自己拼字符串。

### 7. `agent-runtime` — boot 与换代

**DSH 提供：** `ctx.agents`（create/resume + 单活租约）、`ctx.agentDefaultModel`、`ctx.agentPresets`。
**Loom 做：** resume-or-create、写指针、`executeTransition` 换代、`deliver` 投递。
**结论：** 用对了。preset 加入已在创建窗口内完成。
**发现（已修）：** 之前没读 `agentDefaultModel`，创建的 agent 没有模型，收到消息也生成不了。

**发现：换代没记进 DSH 认识的会话元数据。**

`ctx.agents.create` 的 `meta` 有 `parentSession` 字段（`packages/core/agent/src/index.ts:80`），是 DSH 的 fork 谱系。Loom 的 `executeTransition` 只传 `meta: { cwd }`，谱系存在自己的 `runtimeState` 指针里（`parentLineage` 数组）。

后果：`dsh-tool-session-query` 的 `session_trace`（祖先链）看不到 Loom 的换代谱系，因为 DSH 不知道。另外 `meta.agentPreset` 也没传，会话头里不记录它跑在哪个 preset 上。

### 8. `channels` — 入站消费与回复

**DSH 提供：**
- `ctx.commands` — 人直接下的命令，不经模型回合（Loom 未注册任何命令）
- `ctx.userQuestions` — 向人提问的接缝（已挂载，无消费者）
- `ctx.attachments` — 持久二进制附件（已挂载，channel 路径未接）
- `ctx.webhookRuntime` — 从外部投递启动 Session（未挂载）

**Loom 做：** 监听 `channel/inbound`、去重落账、焦点跟踪、投递给 agent；`message` 工具回址。
**结论：** 消费层本身不重复。
**发现：**
- `channels` 里有 `clock`、`runtimeState`、`agentRuntime`、`tools` 四个注入，但**没有用 `ctx.commands`**。人通过 Telegram 发的 `/xxx` 会当作普通消息进模型回合。
- `user-questions` 挂着但没人回答，意味着 agent 无法真正向人提问（`tool-ask-user` 未挂）。
- `attachment-local` 挂着，但 channel 的入站契约里没有附件路径。

---

## 五、DSH 已有、Loom 计划自建的

### `tool-session-query` 对上了 Loom 计划的 `context_search` / `context_read`

来源：`packages/session-query/tool-session-query/README.md`。这是一个 opt-in 包，不在 `dsh-base` 里。

| 工具 | 给模型什么 |
|---|---|
| `session_search` | 匹配字面查询的会话，带标题与最佳匹配摘录；**总是排除调用方会话** |
| `session_event_search` | 一个已授权会话内的事件匹配；对当前会话，停在发起本次调用的那一步之前 |
| `session_trace` | 一个会话的祖先链与后代树；未授权的边界显示为标记而不泄露 id |
| `session_event_trace` | 一个事件的位置替换与引用关系 |
| `session_event_read` | 一个事件的完整未删节 JSON，可带相邻事件摘要 |

与 Loom 的契合点：
- 跨会话授权的条件是**目标会话的 `cwd` 与调用方完全相等**。Loom 所有会话共用同一个 workspace cwd，天然满足。
- `session_search` 排除调用方会话，正好是「回忆更早的代」。
- 依赖 `ctx.sessionQuery`，Loom 已挂 `session-query-sqlite`。
- 结果无游标；超上限时要求模型收窄查询，不暴露 offset/limit。
- 不做截断；超大输出交给已挂的 `spill-policy`。

配置：`maxSearchResults`（默认 100）、`searchTimeoutMs`（默认 30000）。

### `agent-instructions` 是 workspace 治理机制

来源：`packages/context/agent-instructions/README.md`。

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 渲染后的完整基线消息上限 |
| `projectRootMarkers` | `['.git']` | 标记项目根的目录名 |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | 每个项目目录加载的基础文件名 |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | 基础文件之后加载的本地叠加 |
| `dshHome` | `$DSH_HOME` | 含用户全局 `AGENTS.md` 的目录 |

它在 `agent/pre-step` 上工作，属于逐 agent 的提示贡献。

**启用前必须处理两点：**
1. `projectRootMarkers` 默认是 `.git`。Loom 的 workspace（`$DSH_HOME/loom/workspace`）不是 git 仓库，发现逻辑会向上爬到文件系统根，可能读到无关的 `AGENTS.md`。需要给 workspace 放一个自己的标记。
2. `dshHome` 默认 `$DSH_HOME`，即它会读 `$DSH_HOME/AGENTS.md`——那是跨 profile 共享的位置。

---

## 六、已确认的判断错误

| # | 当时的判断 | 实际 | 影响 |
|---|---|---|---|
| 1 | 用 `disabled` 就够了 | 官方模式是 `disabled`（让出位置）+ preset（声明内容）配对 | 工具直接消失 |
| 2 | `restrict({allow})` 是声明工具面的接缝 | `restrict` 全仓唯一生产调用者是 `subagent/child-agent.ts:217`，用于给子 agent 过滤继承能力 | 若照此实现会走错方向 |
| 3 | `agent-instructions` 是任务脚手架，该禁用 | 它是 `AGENTS.md` 兼容文件的加载机制，workspace 设计原本要用 | 能力被误禁 |
| 4 | `skill-filesystem` 对 Loom 是「空能力」 | 它默认扫 `~/.agents/skills`，会把该机器上的 agent 技能串进来 | 用户发现；已去掉 |
| 5 | 没读 `agentDefaultModel` | base 把默认模型放在这个服务里，创建方要主动读 | agent 哑掉，收到消息不回 |
| 6 | 检索工具对应通用 `dsh-tool-session-query` | 对应的是 Loom 自己依赖 context-continuity 的 `createSearchTools`（subject/代际感知、与 `context_rollover` 打通） | 选错包，第二轮才找对 |
| 7 | 换代谱系存自己的 `parentLineage` 就行 | 连续性搜索的活跃谱系游走读 `session.header.parentSession`（search.ts:349）；Loom 没写它 | 检索功能在修谱系前无法建立 |

---

## 七、待拍板（状态）

1. ✅ **先修换代谱系** — `meta.parentSession` 已链，`parentLineage` 已删（`7e2e139`）。
2. ✅ **`clock`** — 注释已改准（`5e8b038`）。
3. ✅ **`agent-instructions`** — 保持禁用。
4. ✅ **telemetry** — `session-telemetry-otel` 已禁用，不外发（`5e8b038`）。
5. ✅ **compaction** — 第二轮发现抄 web-app 清单时误关，已恢复到 preset（`da7f77b`）。token-meter 留 host plane，compaction-basic + tool-result-pruner 在 isolate realm（serviceForAgent 探针确认 present）。

**待做（B 工作项）：** 检索 = context-continuity 的 `createSearchTools`（实现 `ContextSearchAdapter`）+ 回返/checkpoint（把 `isRestorableRef`/`recordCheckpoint` 做实）。前置已备（parentSession 链、投影已注册、session-query-sqlite 已挂）。开工前先深读 context-continuity 的 checkpoint 半边，并钉死「换代 dispose 后旧 session 持久化文件存活」。

**新能力（更后）：** `tool-ask-user`+`user-questions`、`ctx.commands`（channel 命令）、`ctx.webhookRuntime`（外部唤醒，与主动性相关）。
