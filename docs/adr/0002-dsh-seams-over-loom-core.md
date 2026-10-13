# Loom 通过 DSH 接缝扩展，不建特权 core

- 日期：2026-10-13
- 状态：有效

## 背景

DSH 已经提供模型循环、Session、工具、存储、Preset、Loader 和作用域。Loom 增加的是单主体的长期存在条件，而不是另一套 Harness。若 Loom 用统一 import、注册表或自建 DI 把插件接起来，DSH 的组合和替换能力就会被 Loom 自己的接线层重新锁死。

## 决定

Loom 继续作为 DSH Bundle/Profile patch 存在，不建立特权 core。跨插件协作只通过 DSH 的 service、event、waterfall、tool、prompt 和 Loom 的 contracts；插件消费方不依赖另一个插件的具体实现。Host plane 与 Agent plane 仍由清单和 Preset 组合，不能用仓库内的统一启动函数取代 Loader。

插件内部的纯 helper 可以直接组织代码；只有真正属于一个能力的实现才放进该能力的插件。外部实现的 adapter 属于边缘适配职责，不自动升级成 Loom-wide 抽象层。

## 理由与代价

- 保留 DSH 的组合、卸载、作用域和替换语义，升级 DSH 时只核对既有接缝。
- 消费方可以替换提供方，而不用修改整条业务路径。
- 清单顺序、作用域和 effect 生命周期会成为必须理解的工程事实，短期代码不一定比统一接线更直观。
- 直接依赖外部包的 adapter 可能不容易替换；只有出现第二个实现或独立发布需求时才引入更深的接缝。

## 重审信号

- DSH 没有提供某项 Loom 必需能力的可用接缝，且已有两个以上 Loom 能力重复实现同一机制。
- 多个独立部署需要一套稳定的 Loom 运行时语义，而现有 Bundle、Host plane 和 Agent plane 无法表达它。
- 替换实验表明当前 contracts 只是类型外观，不能让第二个实现独立工作。
