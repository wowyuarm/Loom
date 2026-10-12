# 在请求边界切换模型路由

`model-switch` 读取部署侧 JSON 文件，通过 DSH 的 `installModelSelection` 改变主 Agent 下一次请求的 provider/model/effort，不截断已经在飞的请求。它不安装 provider、不自动回退，也不把模型选项写回启动配置。

## 配置与输入

配置字段 `switchFile` 是控制文件的绝对路径；[Bundle](<../../cordis.patch.yml>)给出默认落点。插件 inject `llm`，在 `agent/created` 窗口为每个 Agent 安装 scoped selection。它不提供 ctx 服务、专用工具或存储域。准确配置见[实现](<../../src/model-switch/index.ts>)。

控制文件只接受 JSON 对象：必填 `provider` 与 `model` 非空字符串，选填 `reasoningEffort` 非空字符串；其它键使整份文件无效。provider/model 必须经当前 llm 提供方解析，effort 必须是该路由声明的档位。省略 effort 表示使用 provider/default 行为，不继承旧路由的 effort。

文件每 Step 组装前现读；内容改变时才重新解析、验证和报告。同一 generation 相同内容不反复校验，拒绝的内容也不因后续提供方变化而自动重试。真正读取失败会告警并保留旧路由，缺失文件不告警。

## 生效、撤销与换代

刷新监听器注册在平台 selection 的 assembly 监听器之前，保证该 Step 捕获新值。不能挪到 `agent/pre-step`：它发生在 assembly 之后，会晚一次请求。拒绝发生在修改 selection 之前，合法部分不会部分生效。

删除文件不会改变正在运行的路由。要恢复某路由，写入那份完整选择；要恢复启动默认，可在停止运行并准备重启的流程中移除文件，或直接把默认路由写入控制文件。恢复命令不属于本插件，不能把删除文件写成即时撤销。

重启与换代创建新 selection，初值仍来自 Agent 的已有 options；保留的控制文件在后继第一个 Step 再应用。运行中成功切换不持久写回 options，所以“当前实际路由”以 Session 的请求记录为准，不以启动配置或控制文件推断。

## 模型与运维看到什么

运维日志给出成功切换或拒绝原因。provider/model 改变时 DSH 在下一次接纳的请求中追加持久 user-role notice；**只有 effort 改变时不追加该 notice**。平台负责消息来源和持久记录，Loom 不另造通知。

控制文件不触发新 Turn：若主主体 idle，须等下一次输入才会读取。切到 provider 能解析但实际不可用的路由后，主体可能无法再生成以撤销选择，插件不保证健康探测或自动 failover；运维应保留可恢复的默认路由与外部控制手段。

## 权限与归属

文件在工作区之外表示它是机器配置输入，不是主体材料；**这不是权限隔离**。当前 [运行时](<runtime.md>)写入 `danger-full-access`，同 uid 文件工具可以达到该路径，初始[模型路由技能](<skills.md>)也说明这种操作路径。插件没有专用自切换工具，但不能因此声称 Individual 无法切换模型。若要求硬隔离，需要单独修改沙箱或凭据边界，而不是修改本文措辞。

## 验证入口

[model-switch 测试](<../../tests/model-switch.spec.ts>)用 mock provider 验证立即生效、整份拒绝、合法 effort、删除保持、内容去重与后继首步应用。平台 notice 语义还须核对同版本 DSH agent 的 model-selection；Loom 的 tests 不能替代真实 provider 可用性检查。配置路由的操作入口见[部署指南](<../cookbook/deployment.md>)。
