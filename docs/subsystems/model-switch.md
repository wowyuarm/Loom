# model-switch — 改一个部署侧文件，个体的下一个请求就换模型，不重启

进程里跑着一个长期个体，模型出问题（上游限流、路由挂了、想换更好的）时，过去只能改配置 + 重启。
这个能力把"换模型"从**启动时决定**变成**运行时决定**：运维写一个控制文件，**下一个请求**就用新路由，
进程不动、会话不断、上下文不丢。

机制用的是平台自己的接缝（`installModelSelection`，`@deepseek-ai/dsh-agent`），Loom 只决定
"selection 里该是什么"，不自己造通知、不自己管 selection。

## 运维怎么触发（值班的人只需要读这一节）

**文件位置**：`$DSH_HOME/loom/model-switch.json`，本机即 `~/.loom/loom/model-switch.json`。
路径由部署的 `cordis.patch.yml` 里 `model-switch` 那一行的 `switchFile` 给出。
它**故意不在 agent 的 workspace 里**：这是运维的产物，不是个体自己维护的材料。

**格式**：一个 JSON 对象，只允许三个键：

```json
{ "provider": "deepseek", "model": "deepseek-v4-flash", "reasoningEffort": "high" }
```

- `provider` / `model`：必填，非空字符串，二者必须一起给（路由是整体选的，不做字段级修补）。
- `reasoningEffort`：选填。**只有该路由自己声明了可选档位时才接受**，值必须是它声明过的那个。

**生效时机**：文件在**每一步组装提示词之前**被读一次，所以是"下一个请求生效"，正在飞的那一个请求
不会被拦腰截断。进程不用重启。

**怎么撤销**：**删掉文件在运行中什么都不发生**——这是故意的，半夜误删一个文件不能把正在跑的模型换掉。
想换回去，就把想用的路由写进文件（它只表达"此刻用这个"，不冒充"现在在用哪个"；当前用的是哪个，
以会话记录为准）。
**真要回到部署配置里的默认模型**：删掉文件**再重启**（重启时没有文件，就按 `cordis.patch.yml` 里
`agent-default-model` 起），或者直接把那个默认路由写进文件。

**怎么确认生效了**（不用读源码）：

```bash
journalctl --user -u loom.service | grep model-switch
#  info [model-switch] model switch: workbuddy/hy4-preview-f -> magpie/group/auto-hy4-preview-f (high)
#  warn [model-switch] ignoring /home/.../model-switch.json: unknown key "temperature" — only provider, model, reasoningEffort may be set
```

个体自己也会收到一条平台写的持久通知（"[model changed: … the session continues with …]"），
写在切换生效的那次请求里——**它不会被偷偷换掉**，这一点由平台保证，不由我们复述。

**被拒绝时会发生什么**：整份文件不生效，**不是部分生效**——哪怕它同时写了合法的 provider/model。
旧路由继续用，日志里一条 warn 说明拒因。同一份内容只报一次，不会每步刷屏。
没见过的键、不是 JSON 对象、provider/model 缺失或为空、路由没人提供、effort 该路由不认，都走这条路。

## 对外契约

- 服务：不提供任何 `ctx` 服务。
- 事件：听 `agent/created`（装接缝的时机）；在 agent 自己的 scope 上听 `system-prompt/assemble`（读文件）。
- 系统提示段：不占。切换通知由平台在请求里插入，不是我们写进提示词的段落。
- 存储域：无。状态只有内存里的 selection，随进程结束消失。
- 依赖的接缝：`inject: ['llm']`（校验路由）；DSH 行 `@deepseek-ai/dsh-agent` 的 `agent/created`、
  `system-prompt/assemble`、`agent/request`、`agent/pre-step`。
- 配置：`switchFile`（控制文件的绝对路径）。

## 不变量与安全约束

- **读文件的时机不能挪到 `agent/pre-step`。** agent-loop 的顺序是**先 assemble 再 dispatch pre-step**
  （`dsh-agent-loop`：`systemPrompt.assemble(...)` 在前，`agent/pre-step` 在后），而接缝是在
  `system-prompt/assemble` 的监听器**一开始**就把 `selection.current` 快照进 `assembled` 的。
  所以刷新必须挂在与它同一个 waterfall 里、且**注册在它之前**（waterfall 按注册顺序执行）。
  挪到 pre-step 的后果不是报错，而是**永远慢一步**：文件改了，路由在下一次请求里没变。
- **selection 的初值只来自已有的解析结果**（`agent.options`，即 default-model 插件已解析出来的那份），
  不重跑一遍选择逻辑。
- **装接缝必须在创建窗口内**：平台的 `agent/created` 监听器返回之前压着排队输入，所以在个体第一次组装
  提示词之前就装好了。每次换代（含 context rollover 产生的后继）都会走 `agent/created`，
  所以切换能力跟着换代走，不会在 rollover 之后失效。
- **重启语义没有被改**：启动时的路由仍然只来自配置（`agent-default-model`）。控制文件在**第一个步边界**
  才被读，所以"重启后按配置起"这条成立；文件若还在，第一次请求就会收敛到它——那是运维的持续意图，
  不是启动路径读了文件。
- **拒绝是整体的、且发生在切换之前**：路由先对着 provider 校验（`ctx.llm.resolveModelInfo`），
  不通过就整份文件拒掉，此时旧路由还活着，没有需要回滚的东西。校验只在文件**内容变化**时做一次，
  不是每步都打 provider。
- **主体没有任何路径能改自己的模型**：这里不注册工具、不读消息、不解析提示词内容，个体只能"被告知"。
  见下面的边界说明。

## 边界：这条保证到哪为止

`agent.options` 与 selection 是**单向**的：个体做什么都动不了它。但**文件本身在文件系统上**，
本部署的 DSH 文件策略是 `danger-full-access`，所以个体自己的 shell/文件工具**物理上够得到**那个路径。
因此"它自己永远切不了"要分清两层：

- **模型面路径：不存在。** 没有工具、没有消息、没有提示词内容能改它——这是代码保证的，且由测试盯着。
- **越权伪造部署产物：物理上可能**（同 uid、无沙箱），但那已经不是"改自己的模型"，而是"篡改 harness 的
  输入"，跟它直接去改 `cordis.patch.yml` 是同一类，得靠沙箱策略或凭据隔离解决，不是这个插件能兜住的。

真要把第二层也堵上，方向是收窄文件策略或让触发路径落在个体凭据够不到的地方——那是独立决策，
别在本能力的实现里偷偷加半个机制。
