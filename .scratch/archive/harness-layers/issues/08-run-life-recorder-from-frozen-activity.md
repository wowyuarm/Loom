# 08 - Run Life Recorder from Frozen Activity Evidence

Status: resolved
Type: cognitive organ

> Current model Context, Stable Facts, actor attribution and test policy were corrected by [ticket 09](09-correct-life-recorder-context-and-grounding.md). This ticket preserves the original implementation step rather than describing the current Interface in isolation.

## Problem

Loom 已有 Main Agent Transcript、Context Window、Agent Workspace 和只读写事实的 Tool Trace Compactor，但还没有任何会把一段实际生活写回 Workspace 的认知器官。直接复制 Xi life-recorder 会重新引入对具体姓名、展示文案、固定时区、`xi.jsonl` 和 nmem 在线状态的依赖；过度中性的自然语言又会让模型混淆是谁说了或做了什么。

## Confirmed Direction

- Life Recorder 是 Harness 内置、版本化的 Cognitive Organ，不是 plugin、主 Agent 人格或 generic worker。
- 事件归属由稳定 `actorRef` 决定；自然称呼来自 Identity、observed label 与可用的关系材料。缺少自然称呼时可以使用中性称谓，但不能改变 actor 归属。
- 本票输入是一份由调用方冻结的 Activity evidence。Runtime Active Segment 的持久化、idle/soft-split 调度、Context Window 关闭和 bridge 编排由下一张 ticket 接入。
- Life Recorder 使用独立 one-shot Pi session，不继承主 Agent Context、skills 或 tools。
- 它通过专属 `read_activity` 读取完整 evidence，通过 `write_daily` 维护 Daily Narrative，通过 `record_episode` 写入稳定的 Workspace episode。nmem Integration 后续独立导入，不能阻塞 recorder。
- Identity 是归属视角的必要材料。Long-term Memory、已有 Daily 与 episodes 缺失时明确呈现为 absent，但不阻断运行；未定义的 Workspace 私人材料不由 Recorder 猜测或扫描。
- receipt 只证明冻结 evidence 已完整读取，Daily 已更新或明确 no-change，episode 写入已落盘。它不证明 nmem 导入或 Activity 关闭。

## Model-visible Semantics

- Recorder 是第一手记录者，不是长期分析者。
- 对方 Input、主 Agent 内部输出、工具行动、Effect 与 Delivery 必须按结构化事件区分。
- 只有证据支持的自然名字和关系称呼才可使用；证据不足时退回中性称谓。
- thinking 只可作为明确标注的内部材料，不能写成对方原话、外部事实或已经发生的行动。
- Daily 服务近期接续；episode 保存发生改变的可回放场景。两者都允许没有变化。

## Test Seams

- Life Recorder Interface：通过真实 Pi faux provider 观察最终 system prompt、run context 和专属工具面，并验证缺失可选材料不会阻断。
- Agent Workspace：验证 Daily 与 episode 的真实文件结果、稳定 episode identity，以及失败后恢复原 Daily 并移除本次 episode。
- Frozen Activity reader：验证 receipt 只在全部 event pages 已读后产生，未知 actor 或 evidence 引用被拒绝。

## Out of Scope

- Runtime Active Segment Store、close claim、idle/soft-split、logical day 或 recent bridge。
- nmem Integration、导入 cursor、重试或同步状态。
- 其他 Cognitive Organs 或 generic organ framework。
- 最终 workspace init、模板和模型配置系统。

## Result

- 新增 `createPiLifeRecorder(...).record(activity)` 这一条外部 Interface。Life Recorder 内部使用独立 one-shot Pi session，不加载主 Agent Context、skills、extensions 或通用工具。
- Frozen Activity 在调用模型前校验唯一 actor/event 与明确归属；初始 Context 只提供 Identity、可选材料、actor registry 和证据元数据，原始 events 必须通过分页 `read_activity` 完整读取。
- 模型只得到 `read_activity`、`write_daily`、`record_episode` 三个专属工具。工具要求先读完 evidence，episode 只能引用本段 eventId，并以 `segmentId + ordinal` 形成稳定 identity。
- Identity 缺失或为空会阻断；Long-term Memory、当日 Daily 和 episodes 缺失会明确呈现为 `missing`，不会阻断。
- Daily 与 episode 先原子写入 Workspace，并由一次 recorder run 的 write journal 统一提交语义。tool、provider 或 abort 失败会恢复旧 Daily，并删除或恢复本轮 episode。
- receipt 由代码根据已读取页和已完成写入机械生成，不接受模型文本作为完成证明，也不包含 nmem 或 Activity close 状态。

## Verification

- Node `24.15.0`: `npm run typecheck`
- Node `24.15.0`: `npm test`，60 tests passed
- 真实 Pi faux provider 覆盖专属工具面、通用 system prompt、Context 材料、raw event 延迟读取、缺失可选材料、完整分页、actor/evidence 越权、参数校验、provider/abort/tool failure 回滚和稳定 episode identity。
