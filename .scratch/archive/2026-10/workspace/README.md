# workspace / Instance Root 结构

**Status:** 布局收敛；scaffold + bootstrap + workspace/AGENTS.md 已实现（`src/resident-context/scaffold.ts`），Instance Root 各 root 路径的 profile 配置待接。

**last-checked:** 2026-09-26

Loom 一个部署的物理根目录，以及 agent 文件空间与 harness 运行数据的边界。

## 两个区，边界要清

```
  Agent Workspace   agent 的高权限文件空间 = 它的 cwd
                    材料(identity/attention/memory/threads) + skills + 私人工作
                    agent 用 fs 工具 / memory_write 读写
  Runtime 数据      harness 拥有，在 Instance Root 内、Workspace 外
                    session log · ② sqlite · attachments
                    agent 不把它们当可编辑文件（结构化 harness 状态）
```

分开的理由：agent fs 工具只该看到 Workspace；② sqlite 与原始 session log 不能被当文件乱改；快照 = 整个 Instance Root 一起拍。

## DSH 已有布局主张，我们是配置不是发明

- `workspace` 包是 WorkspaceEntity registry（durable workspace 记录 + workspace domain），不只是 cwd。
- `session-persistence-jsonl` 按 project/cwd 分目录存 session log。

Loom 的活是把 DSH 的各 root 配置进一个 Instance Root，让它们一致落在同一个根下（具体路径是部署配置，不是仓库事实）。

## 布局

```
  <instance-root>/          Instance Root（一个部署；路径由部署决定）
    workspace/                Agent Workspace = session cwd（DSH workspace entity）
      AGENTS.md               workspace 治理指引（见下）
      identity.md
      attention.md
      memory.md  +  notes/
      threads/   index.md + <id>/
      skills/
      （私人工作、agent 自己写的 scripts/ tools/ …）
    runtime/                  harness-owned，Workspace 外
      sessions/               DSH session-persistence root（按 cwd 分目录）
      continuity.sqlite       ② storage-domain 的 sqlite medium
      attachments/            attachment store
```

映射：session cwd = `<instance-root>/workspace/`；sqlite medium = `runtime/continuity.sqlite`；persistence root = `runtime/sessions/`；attachments = `runtime/attachments/`。

## 已定的点

- **两区 split**：agent fs 工具锁在 `workspace/`，runtime 数据在外。
- **材料放 Workspace 根**（identity.md 等直接在根，skills/ 一个子目录）。
- **Instance Root 默认路径是部署配置**（单部署）；一机多部署（`<instance-root>/<instance>/`）是后续，不预建。
- **快照边界 = 整个 Instance Root**：eval 的 Instance Root 快照拍这个目录，要求拍的瞬间无 in-flight 写（连回 [verification-and-eval.md](../../../active/loom-architecture/verification-and-eval.md) 的 seam）。

## workspace/AGENTS.md 与 dsh-agent-instructions

复用 `dsh-agent-instructions`（`context/agent-instructions`）：

```
  · baseline：项目根 AGENTS.md 首个 request 前进 durable context
  · on-touch：fs 工具成功碰某目录 → 注入该目录 nested/changed/removed 的 AGENTS.md
  · 注入的是 context 消息，不占 system prompt 段
```

材料模块曾否决 agent-instructions 做**材料投影**（per-file/tree-discovery 语义与 5 材料结构冲突）；这里是它的**本职用途**（目录级治理指引），两者不冲突：

```
  材料（③,常驻,curated）        → 自写 context() provider
  workspace 治理指引（碰到才注入） → dsh-agent-instructions
```

**workspace/AGENTS.md 与 system prompt 的分工（已定案）：**

```
  system prompt        只留必要机制 + 一句指针指向 workspace/AGENTS.md + "不外露机制"约束   常驻、极薄
  workspace/AGENTS.md  怎么"持家"：文件地图、note vs thread、core 保持小、刷 attention、
                       保持有序、维护去哪查                                              fs 碰到才注入
```

收敛点：**"怎么管理"整块从常驻 prompt 撤下、搬进 workspace/AGENTS.md**（原设想的常驻"心智引导"段已删）。prompt 不再教如何用器官，只点名这个文件让 agent 自己去读；并加一条行为约束：memory/attention/threads/rollover 这些是内部机制，agent 默默做、不对 user 复述（藏管道，不藏回忆出来的内容）。

**scaffold（初始化即存在，不靠 agent 凭空建）：**

首次 boot（`workspace/AGENTS.md` 不存在）时 harness 一次性铺出骨架——各材料文件（空）+ 目录（`memory/notes`、`skills`）+ `AGENTS.md` + `bootstrap.md`；以 `AGENTS.md` 是否存在为幂等标记，已诞生的 workspace 绝不重铺。

**bootstrap（诞生引导，本身是 prompt）：**

```
  workspace/bootstrap.md 存在
      └─ 原样拼进 system prompt 段 loom:bootstrap（order 90，领先 identity）
          └─ 引导 agent 与 user 对话、确立"我是谁"（说关系与自我，不说文件）
              └─ agent 写好 identity/identity.md → 删 bootstrap.md → context_rollover（自己做）
                  └─ 再醒来：无 bootstrap.md、identity 已在 → 正常连续运行
```
结尾容许露一点机制（写文件+删+rollover），因为这是一次性诞生环节。

内容大纲：

```
  workspace/AGENTS.md
    ├─ 文件地图：各材料是什么（简述，细节在 prompt）
    ├─ 有序原则：workspace 要管好；自写 scripts/ tools/ 归类别散落
    ├─ 维护索引：材料整理(compact/demote/split)见 skills/<维护skill>；索引怎么更新
    └─ 它是 workspace 的贡献指南，指引以后的工具，不进 prompt
```

## 落点

装配层复用 `dsh-agent-instructions`（inject `ctx.fs`），workspace 根放 AGENTS.md。Instance Root 各 root 路径在 Loom profile 配置。
