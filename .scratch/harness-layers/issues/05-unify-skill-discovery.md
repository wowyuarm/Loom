# 05 — Unify Skill Discovery per Turn

Type: implementation
Status: resolved
Blocked by: 04 — Bind Agent Workspace Materials to Turns

## Outcome

让主 Agent 在每个新 Turn 通过 Pi 的同一套 catalog 看到 Harness core、Agent Workspace 与已装配 Integration 提供的 skills。来源只表示维护权，不形成三套能力或覆盖顺序。

## Confirmed Behavior

- `PiAgentExecution` 显式接收 Harness core 与已装配 Integration 批准的 skill 路径；Workspace 来源固定为 `<workspace>/skills/`，目录不存在是正常状态。
- 关闭 Pi 的 global、user 与 project skill 继承。Integration skill 只来自后续 Integration 装配明确提供的路径，不扫描 Workspace 中任意 extension 目录。
- 每个新 Turn 重新发现一次并冻结；同 Turn steering 继续使用同一份 catalog。
- 接受的 skills 按 name 与 path 稳定排序。
- 无效、`disable-model-invocation` 与重名 skills 不对主 Agent 可用。重名没有 winner：同名的所有项都移除。
- 降级诊断不阻塞 Turn；诊断既进入该 Turn 的 system prompt，也以 `loom.skill-diagnostics.v1` 写入 Primary Agent Transcript。
- 只要存在已接受 skill，最终工具面必须有名字严格为 `read` 的工具，否则在 provider 调用和 Input inclusion 前失败。

## Public Seam

使用真实临时 skill 目录和 Pi faux provider，从 `PiAgentExecution` 观察最终 system prompt、provider 是否调用、Input inclusion 与 transcript evidence。测试不约束 `DefaultResourceLoader` 的内部调用顺序。

## Acceptance

- core、Workspace 与批准的 Integration skills 进入同一 `<available_skills>` catalog，且稳定排序。
- Pi global/user/project skills 不泄漏；缺失 Workspace `skills/` 不产生诊断。
- invalid、manual-only 与 collisions 全部从 catalog 移除，诊断对主 Agent 可见并持久记录。
- 有诊断时 provider 仍正常运行；有 accepted skill 但无 `read` 时 provider 不运行、Input 不 inclusion。
- Workspace skills 的增加、删除和内容修改在下一 Turn 生效，同 Turn steering 不改变 catalog。
- 既有 Runtime、Transcript、Context、Agent Workspace 与 Agent Execution 行为不回归。

## Out of Scope

- Integration loader、extension 安装、credentials 与实际 `resources_discover` 装配。
- workspace init、默认 skill 模板、skill 管理 CLI 或迁移逻辑。
- Cognitive Organs 的受限 skill catalog。

## Implementation Result

- `PiAgentExecution` 每个新 Turn 建立一个 Pi `DefaultResourceLoader`，显式合并 Harness core、存在的 `<workspace>/skills/` 与已装配 Integration 批准的路径；`noSkills: true` 继续关闭 Pi 默认来源。
- `skillsOverride` 在一个 catalog 内移除 Pi 报告为 invalid 的路径、`disable-model-invocation` 项和所有 collision 名称，并按 name/path 固定排序。Workspace `skills/` 不存在时不传给 loader，也不产生伪诊断。
- 最终 diagnostics 以结构化 `Skill Diagnostics` 进入当轮 system prompt，并在 provider 前以 `loom.skill-diagnostics.v1` 追加到 Primary Agent Transcript；降级项不阻塞 Turn。
- 只要最终 catalog 非空，Agent Execution 会在 provider 与 Input inclusion 前确认实际工具面存在名称严格为 `read` 的工具。
- 新 Turn 重新读取目录并建立 catalog；steering 复用同一 Pi session，因此运行中的 Turn 不受文件增加、删除或修改影响。

## Verification

在 Node `24.15.0` 下通过：

- `npm run typecheck`
- `npm run build`
- `npm test`：42 tests passed
- `git diff --check`

## Source References

- Xi [05 — Harness Capability Composition](../../../../Xi/.scratch/harness-generalization/issues/05-define-harness-capability-composition.md)
- Xi [Extensions](../../../../Xi/docs/extensions.md)
- Loom [04 — Bind Agent Workspace Materials to Turns](04-bind-agent-workspace-materials-to-turns.md)
