# JOKER Agent 工作准则

默认使用简体中文沟通，保护现有脏工作区，不回滚或覆盖无关修改。

## 真实页面与运行链路验收硬门槛

- 用户在页面、Electron 窗口、ToolCard 或会话中报告的问题，必须先在对应真实界面与同一操作路径上复现；修复后必须再次走完同一路径。
- `test`、`typecheck`、`lint`、`build` 只能作为辅助证据，不能单独证明用户可见问题已经修好。
- Generated Tool 问题必须验证完整链路：模型或 provider 发起工具调用 -> 宿主注册表与 schema -> runtime/worker/IPC -> ToolCard 可见输出 -> 会话进入正确终态。
- 只验证 manifest、schema、adapter、设置页卡片或 fixture，不得宣称真实工具调用已经修好。
- Electron 主进程、preload、worker 或 runtime bundle 发生变化后，必须确认实测进程已加载新产物；必要时重启后再验收。
- 实测至少记录：操作路径、代表性输入或数据、可见结果、DOM 或 ToolCard 状态、console/page error、必要的 network/runtime 输出，以及截图或结构化报告。
- 如果当前无法运行真实界面，必须明确标记“用户可见链路未验证”，不得使用“已修好”“已完成”等结论。

## 完成判定

只有同时满足以下条件才能结束页面或 Electron 运行时修复：

1. 报告中的原始路径可以复现，或有明确证据说明为何无法复现。
2. 修复后在真实应用中重复同一路径，用户主任务可完成。
3. 页面没有与本问题相关的可见错误、卡死、自动刷新或错误终态。
4. console、page error、network/runtime 中不存在与本问题相关的未解释异常。
5. 自动化测试、类型检查和构建作为补充门禁通过，或对无关基线失败作出明确区分。
