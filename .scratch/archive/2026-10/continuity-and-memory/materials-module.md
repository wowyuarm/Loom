# 模块：材料/记忆层

**Status:** v1 已实现并通过测试（`src/resident-context/`, `src/clock/`；`tests/resident-context*.spec.ts`）。identity 为 `section()`；prompt 心智引导已移除，改由 workspace/AGENTS.md 承载（on-touch）；新增 `loom:bootstrap` 段与 workspace scaffold。memory/threads/attention 留 `context()`（历史）——放置判定见 DESIGN §6。
**last-checked:** 2026-09-26

## 已实现

- 投影：`registerResidentContext(ctx, workspace, caps)` 贡献两部分：**section** —— `loom:bootstrap`（90，读 `bootstrap.md`，有内容才渲染、否则空）+ `loom:identity`（120，读 identity.md、过预算、`interpolate:false`）；**context** —— memory-core 20 / memory-index 25 / threads-index 30 / attention 40。缺文件→空串（渲染时不贡献）。心智引导段已删——“怎么管理”整块搬进 workspace/AGENTS.md（harness 出厂、on-touch 注入）；prompt 只在 orientation(100) 留极简机制 + 指针 + “不外露机制”约束。
- scaffold：`resident-context` 的 `apply()` 调 `ensureWorkspaceScaffold(workspace)`（幂等，以 `AGENTS.md` 存在为标记），首次 boot 播出材料文件(空)+目录+`AGENTS.md`+`bootstrap.md`；已诞生的 workspace 不重播。见 `src/resident-context/scaffold.ts`。
- memory.md 按 `## Notes` 标记切 core / index 两段；`memory_write` 在 index 段 upsert 路由行（幂等）。
- `memory_write({concept, body, ref?})`：先写 `memory/notes/<concept>.md`（frontmatter 盖 session + written_at + ref），再 upsert 索引。concept 限 slug 防路径穿越；无 agent session 拒绝。
- 预算：每材料字节上限，超了按 UTF-8 边界截断 + 可见标记（`applyBudget`）。
- **时间 seam**：新增 `ctx.loomClock`（`src/clock/`），`memory_write` 的时间戳走它；测试用 `ManualClock`。runtime-state 的 acceptedAt 也应由调用方从此钟取。
- 未接：jev 写入路由（该记吗 / memory vs thread）——主动性阶段。

---

按 [FRAMEWORK](../../../active/loom-architecture/FRAMEWORK.md) §8 展开。材料的语义形状（三轴 + identity、记录/理解两层、预算）见 [DESIGN.md](DESIGN.md)；本文只定"怎么落到 DSH 上"。

## Loom 需要它做什么

三件事：

1. **投影**：把 5 个常驻材料文件注入进每轮 context（identity / memory 核心 / memory 索引 / threads 索引 / attention）。
2. **写入**：memory 单元（note + 索引行）原子写、自动盖来源；attention/threads 走裸 fs。
3. **预算**：常驻文件字节上限 + 注入块显示用量。

## 候选 DSH plugin

| 需求 | 候选 | 判定 |
| --- | --- | --- |
| 注入 context | `system-prompt` 的 `.context()` | 直接复用（原语） |
| baseline/delta 投影 | `agent-instructions` | **不用** |
| 字节预算 | `agent-instructions` render | 参考思路，自己实现 |
| 写入工具 | 无 | 自实现薄工具 |

## 判定与理由

### 投影：自写 `context()` provider，不碰 `agent-instructions`

`context()` 原语本身就给了我们要的机制：注册 `{ name, order, text: ()=>string }`，每次组装求值，**只在内容变化时作为 user-role 快照进历史，旧快照 compaction 时移除，不变不重发**。

`agent-instructions` 是 `context()` 之上的高层消费者，语义绑死"遍历 workspace 树找 AGENTS.md 类 instruction 文件"，其逐文件 delta 是为"多文件散落偶尔变"优化的——和我们"5 个材料各有语义/顺序/预算"的结构冲突，增值（树发现、instruction 语义）也不是我们要的。

落法：一个常驻材料 → 一个 provider，order 升序 = 醒来 bundle 顺序（identity 在前、attention 贴当前 Input）：

```
  section({ name:'loom:bootstrap',       order:90,  interpolate:false, text:()=>read('bootstrap.md') })  // 有才渲染，诞生后删
  section({ name:'loom:identity',        order:120, interpolate:false, text:()=>budget(read('identity/identity.md')) })
  context({ name:'memory-core',   order:20, text:()=>coreOf('memory/memory.md') })
  context({ name:'memory-index',  order:25, text:()=>indexOf('memory/memory.md') })
  context({ name:'threads-index', order:30, text:()=>read('threads/index.md') })
  context({ name:'attention',     order:40, text:()=>read('attention/attention.md') })
```

"投影 builder"就退化成：注册 N 个读文件的 provider。不造 delta 引擎。

### 快照模型：常驻全量，不做 delta

`context()` 是"常驻全量快照、变了整块刷新"，不是 delta。对小材料（总预算 20-40KB）比 delta 更简单，模型每轮看到当前全貌。**delta 只在某材料日后被证明又大又频繁变时才作为优化加入，不是 v1 需要。**

### 醒来 bundle：无需单独 baseline 触发

rollover 后新 session 空，第一次组装时 provider 直接读当前文件、自然注入；同 session 内后续 turn 内容没变则不重进历史。**不需要单独的 baseline/resume 机制**——`context()` 每次组装都反映当前文件状态。

provider 每轮组装读文件（小文件、本地 fs，便宜）。v1 不加 mtime/digest 缓存——DSH 已做"内容没变不重进历史"去重，过早优化。

### memory_write：薄工具，原子写 note + 索引 + 盖戳

```
  memory_write({ concept, body, ref? })
    ├─ notes/<concept>.md      写正文
    ├─ memory.md 索引段         upsert 路由行（concept → notes/<concept>.md）
    ├─ 盖戳：exec.agent.id（= 当前 SessionId）+ 时间   自动
    └─ ref?：可选 contextRef（agent 从 search 命中记东西时传入）
```

- **session id 来源**：`exec.agent.id`（`Agent.id === SessionId`），DSH 现成。**不依赖连续性 store 的 current-session 指针。**
- **召回双通道**：note 存了 ref → `context_read` 精确展开；只有 sessionId → `context_search` 在该 session 内按内容找。落实"有引用则引用，否则内容"。
- **原子性**：先写 note、再更新索引行。崩在中间 = 孤儿 note（良性、可自愈）。**v1 不做 journal**，出现再说。
- 只有 memory 的"note+索引"配对需要专门工具；attention/threads 是单文件重写，用 `tool-fs` 的 write/edit。

### 预算

不靠 `agent-instructions`，在自己的 provider 里做：读文件时按材料字节上限截断加标记 + 在快照里显示用量（"memory.md 6.2/16 KiB"）。一个小工具函数。

## 落点

```
  Loom materials 插件，贡献：
    ├─ N 个 context() provider     投影
    ├─ memory_write 工具（tools()） 原子 note+索引+盖戳
    └─ 预算 helper                  截断 + 显示用量
  依赖：workspace fs 访问 · exec.agent.id
  不依赖：连续性 store 的 current-session 指针
  预留 no-op：jev 写入路由（该记吗 / 进 memory 还是 thread）——主动性阶段
```

具体包结构在"装配"模块定。
