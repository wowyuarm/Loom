# DSH 集成地图

**Status:** 参考（对着 deepseek-harness 0.1.5-rc.2 本地源码核过）。

**last-checked:** 2026-09-21

把 [FRAMEWORK §5](FRAMEWORK.md) 每个模块关联到 DSH 的真实 ctx API / service / event。设计到实现之间的桥；实现票据此写具体贡献点。核过的源码在 仓库锁定的 DSH 版本源码（见 `docs/dsh-platform.md`）。

## core/agent — `ctx.agents`（channels 消费层 + 装配 boot）

`AgentRegistry`（`core/agent/src/index.ts`）：

```
  ctx.agents.create(ownerCtx, CreateAgentOptions) → AgentHandle { agent, dispose() }
  ctx.agents.resume(ownerCtx, ResumeAgentOptions) → AgentHandle
    ResumeAgentOptions { resumeSessionId, parentAgent?, agentOptions?, setup? }
    CreateAgentOptions { sessionId, meta{cwd,agentPreset,parentSession?,isSeeded?}, setup? }
    resume 需注入 sessionPersistence
  ctx.agents.get(id) → bare Agent
```

Agent inbox 方法（`core/agent/src/runtime-types.ts`）——channels 消费层路由用：

```
  followup(msg)              普通 follow-up turn，唤醒 driver，独占一个 turn  ← 外部 Input 用这个
  send(msg, target, wakeup)  路由到指定 inbox 边界，可选唤醒
  steer(msg)                 对最近 step 的引导
  inject(msg)                下一 pre-step 的 model-facing context，不唤醒
```

事件（都经 `dsh-scope` 按 agent 过滤）：

```
  agent/created · agent/disposed · agent/status(idle⇄running)
  agent/session-start { source: startup|resume|clear|compact }   ← 知道 agent 起/续
  agent/inbox/{inserted,claimed,discarded}
  agent/pre-step (waterfall)   拒绝/替换进入 step 的消息 —— 真实扩展点
```

**setup 回调**：create/resume 时的 per-agent 组装（注册 scoped 工具、prompt 段），在 session/agent 发布前跑。Loom 只有一个 agent，材料/工具/persona **全局注册即可**，不必用 setup 的 scope。

## core/agent-loop — boot 起 root agent（装配）

config `agents: [{ id, sessionId?|resumeSessionId?, cwd, ...}]`，startup 时逐个 create（fresh）或 resume（有 resumeSessionId）。动态指定 session id 的机制：

```
  launcher 在 Loader 挂载前:
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { loom: { id: SessionId, resume: boolean } })
  → agent-loop 用它覆盖配置里的 identity，resume 或 create
```

**Loom boot 两条路：**

- **A. launcher identity overlay**：launcher 在挂载前读 ② 指针 → provide identity → agent-loop resume/create 那一个 `loom` agent。DSH 原生，但 launcher 要在插件挂载前直接读存储。
- **B. 插件驱动（agent-team 的做法，推荐）**：profile 不配 startup agent；Loom 插件在 ② store + sessionPersistence 就绪后读指针，直接 `ctx.agents.resume/create`。指针读写都在 ② owner 里，无挂载前存储 hack。

Team 用 B。推荐 Loom 也 B——单一 owner、无 chicken-and-egg。

## core/system-prompt — `ctx.systemPrompt`（材料投影 + persona）

```
  .section({ name, order, text|provider, complete? }) → 取消器   升序拼接
  .context(PromptContext) → 取消器                             动态，每次 assembly 求值
  .variable(name, provider) → 取消器
  .getSectionOrder(NAME) / .getContextOrder()                  命名 order 分配
  事件 system-prompt/assemble (waterfall)
```

**persona 的真相（`preset/persona/src/index.ts`）：**

- `dsh-system-prompt` **自己拥有 deployment persona 配置**，无条件注册 `PERSONA_PREFIX_SECTION`(`deployment:persona-prefix`)/`PERSONA_SUFFIX_SECTION`。
- `dsh-persona` 是 **scope-only 行**（挂进 agent preset 遮蔽某一 session 的 persona）；全局挂载会和 registry 自带的注册**冲突并 fail loud**。

所以 Loom 的**中性 persona = 在 profile 里配 `dsh-system-prompt` 的 persona 文本**，一个地方，不写自定义 persona 插件。心智引导段 = 一个 Loom 插件全局 `.section()`（单 agent，全局即可）。identity.md/memory/threads/attention = `.context()` provider（材料层）。

## core/tools — `ctx.tools`（Loom 工具）

```
  ctx.tools.register(defineTool({ name, description, parameters, execute(args, exec) })) → 取消器
  事件 tools/{pre-execute,execute,post-execute} (waterfall)
```

Loom 工具在这注册：`memory_write`（材料层）、`send_message`（channels 出站）。

## storage/storage-domain — `ctx.storageDomain`（② store）

```
  defineDomain({ name, version, tables:{...zod}, global?, layout?, ... })
  ctx.storageDomain.open(spec) → Domain
    Domain.global : DomainGlobal { get(): G 同步内存, set(value): Promise durable }
    Domain.table(name) : KvTable {
      get(k): V|undefined 同步内存,  entries(), keys(), size,
      put(k,v): Promise durable,  delete(k): Promise<bool>,  update(k, fn): Promise 原子RMW
    }
  facility 配置 { backend:'sqlite', routes? }   默认后端名；storage-sqlite 注册为 'sqlite'
```

② store 直接映射：

```
  global currentSession   → domain.global.get()/set()
  table  acceptedInput    → domain.table('acceptedInput').get(key) 同步去重 / put(key,val) durable
```

**接受屏障成立**：`get()` 同步（去重快），`put()` await 后 durable——channels 消费层 await put 再 `followup`，Input 落地先于执行。

Profile 里要装：`dsh-storage` + `dsh-storage-sqlite`（注册 'sqlite' 后端）+ 配 `storageDomain.backend='sqlite'`。

## dsh-context-continuity — host 契约（连续性）

Loom 实现 host（`dsh-context-continuity/src/host.ts`）：

```
  projectionForSubject(id, sessionId)   折叠 subject 的投影
  executeTransition(id, plan)           Loom 写 body：commit rollover、dispose 旧、激活 successor
                                        ← setCurrentSession(新) 就放这里；reject 则旧 generation 可恢复
  rolloverIdentity(prevSessionId, toolCallId)   崩溃重放收敛用的确定 id
  isEphemeralNotice(msg)                哪些排队消息是可重derive的瞬时通知（v1 返回 false）
```

## fs/tool-fs — 裸 fs（材料）

attention / threads / memory 核心段走裸 fs 工具（`fs/tool-fs`：read/write/edit/str-replace）。materials-module 已定：memory_write 只管 note+索引，其余材料裸 fs。

## context/agent-instructions — workspace/AGENTS.md（workspace 治理）

复用 `dsh-agent-instructions`（inject `ctx.fs`）：

```
  baseline：workspace 根 AGENTS.md 首个 request 前进 durable context
  on-touch：fs 工具成功碰某目录 → 注入该目录 nested/changed/removed 的 AGENTS.md
  注入的是 context 消息，不占 system prompt 段
```

只用于目录级治理指引（不用于材料投影，那是自写 context() provider）。详见 [`../../archive/2026-10/workspace/README.md`](../../archive/2026-10/workspace/README.md)。

> 2026-10-12 订正：这段描述已被推翻——`agent-instructions` 在 [Host patch](../../../cordis.patch.yml) 里是**刻意禁用**的，目录级治理指引的内容改由 seeded skill `skills/workspace-upkeep/SKILL.md` 承载。上面那段保留的是当时的判断。

## 落地要点（源码核过的几个实处）

1. **boot 用 B（插件驱动 resume/create）**，不用 launcher overlay——单一 owner，无挂载前存储读。
2. **persona = system-prompt 的 deployment persona 配置**，不写自定义 persona 插件；`dsh-persona` 全局会冲突。
3. **材料/工具/persona 段全局注册**（单 agent），不必 per-agent setup scope。
4. **接受屏障**：KvTable `get()` 同步、`put()` await 即 durable，天然满足"接受先于 followup"。
5. **外部 Input = `agent.followup(msg)`**（独占 turn、唤醒），不是 inject。
