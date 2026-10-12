# 03 — workspace 纳入 git：机械快照（主动性的前提，独立有价值）

**What to build:** 主体的 workspace（某部署的 Agent Workspace，一万多行真实材料，当前零版本控制）成为一个 git 仓库，由 harness 在每轮结束后机械提交一次。做完之后：材料写坏了能回退、主体能查自己的材料怎么演化、并且**逐条年龄可由 `git blame` 还原**——票 04 依赖后者。主体对此无感知：不提交、不看 git、不进上下文。

**Blocked by:** None — can start immediately（但需 Human 对"给主体材料建 git 仓库 + harness 自动提交"点头，见 2026-10 订阅模式讨论（见该讨论））。

**Status:** complete — 实现侧 在分支 `feat/proactivity-workspace-history`（`d3497ca`）实现，收敛侧 独立重验（typecheck 0、全量 119/1、活体 `e1cb200` 单提交 clean、blame 通）。未合并，等 Human 定合并/重启。

## 为什么要有这张票

逐条年龄是票 04 的全部基础。已验证的关键事实（2026-10-09，收敛侧 在 /tmp 建仓实测）：**整文件覆写不会丢失逐条年龄**——只改一行、整文件重写，`git blame` 仍精确给出每行最后改动时间（第一行 09-25、第二行 10-08）。

所以"attention 整文件覆写 ⇒ 逐条时间无处可存"这个判断是错的。真正缺的只是：那个目录现在不是 git 仓库。

额外白捡（与主动性无关但独立成立）：该 workspace 当前无任何版本控制，覆写写坏无退路；主体自己也无法回答"我上次对这条是怎么想的"。

## 决策要点（内联）

- **提交者是 harness，不是主体。** 主体继续裸 fs 覆写，不调 git、不写 commit message、不感知仓库存在。理由：一旦要它参与，就变成一件它要记得做的事，会和 horizon 一样退化。
- **提交时机**：`turn/end (completed)` 之后一次——与 after-interaction 同一个事件接缝（`src/after-interaction/index.ts:85`）。无变更则不提交（空提交零价值且污染 blame）。
- **落点二选一，实现定**：(a) 新插件 `src/workspace-history/`（`index.ts` + git 调用模块），`cordis.patch.yml` 加一行 `loom/workspace-history`，config 传与 resident-context / agent-runtime 同一个 `workspace`；(b) 并入现有 `resident-context`（`ensureWorkspaceScaffold` 建骨架、`registerResidentWriteBudget` 已在看写）。收敛侧 倾向 (a)：存历史与读材料是两个职责，git 坏了不能连累读材料。
- **commit message 机械生成**，含轮次与变更文件名即可。不调模型。
- **提交身份跟着每次命令走，不落盘**（`git -c user.name=… -c user.email=…` 写在代码里）。不碰全局 `~/.gitconfig`，也不写仓库 `.git/config`；首次建仓同样带 flag。唯一落盘的是 `.gitignore`（文件内容，不是 git 配置）。
- **`.gitignore` 必须有**：该目录混着大附件与下载产物（图片、下载目录等）。只版本化材料文本（`*.md` 与配置），其余忽略。`.git` 本身永不记。
- **实例侧首次建仓手工做一次**（该 workspace 上 `git init` + `.gitignore` + 首次提交；git 2.43.0 在验证环境可用）。以后每轮提交全自动。
- **不碰 Loom 仓库的 git。** 这是另一个独立仓库，位于主体的 instance root 下，与本工程 checkout 无关。
- **失败不能影响主体。** git 操作失败只记日志，绝不阻塞或打断回合（fail-open：这不是安全机制，是便利设施）。

## Acceptance criteria

- [ ] workspace 成为 git 仓库，首次提交包含当前全部材料文本；`.gitignore` 排除图片、下载产物与非材料二进制。
- [ ] 每轮 `turn/end (completed)` 后，若材料有变更则产生恰好一次提交；无变更时不产生提交。
- [ ] 主体侧零变化：不新增工具、不新增提示、不进上下文；主体仍按原方式整文件覆写材料。`scaffold.ts`（workspace AGENTS.md）、`orientation` horizon 语句、`layout.ts` 文件名都不动。
- [ ] git 失败（锁冲突、磁盘满、仓库损坏、非 git 目录）只记日志，回合正常完成——测试 `tests/workspace-history.spec.ts` 覆盖"git 不可用时回合不受影响"。
- [ ] `git blame` 能对 `attention/attention.md` 给出逐行最后改动时间；测试以"整文件覆写只改一行"为输入，断言未改动行的时间戳保持不变（整条路的命根）。
- [ ] 仓库体积可控：连续 N 轮只改一行不产生异常膨胀（抽样验证，非性能测试）。
