# Context Optimization 验证草稿

> 草稿状态：验证脚本已搭架，产品 API 是否就绪以实际报告为准。本文件不代表计划阶段完成，也不更新 README、MILESTONES 或 `CONTEXT-OPTIMIZATION-PLAN.md` 状态。

## 范围

本验证覆盖六类确定性输入：大 JSON、重复日志、长 coding 会话、长 WebRead、MCP 列表、sub-agent 报告。所有 fixture 固定生成，不访问真实 Provider。

## Qualification

运行：

```bash
npm run test:qualification:context-optimization
```

报告包含每个 fixture 的：

- 原始、legacy、v2 估算 token；
- summary、retrieval、transform 输入/输出成本；
- step 数与 duration；
- 每个保护 sentinel 的机械断言；
- `estimatedNetSavedTokens` 与估算净节省比例；
- v2 是否应用、是否 fallback 及原因。

机械门禁：

- 大 JSON 和重复日志估算净节省不少于 30%；
- 长 coding 估算净节省不少于 15%；
- 所有 sentinel 保留；
- short chat summary 调用为 0；
- summary 失败时确定性 fallback，Session 输入不变且最新用户意图保留。

Qualification 会探测以下产品侧导出之一：`compileContextV2`、`compileContext`、`optimizeContext`。当前适配预期签名为：

```ts
(messages, {
  mode,
  sessionId,
  maxContextTokens,
  outputTokenReserve,
  model,
  policyVersion
}) => {
  messages?: ModelMessage[]
  projectedMessages?: ModelMessage[]
  metrics?: {
    originalTokens?: number
    projectedTokens?: number
    summaryInputTokens?: number
    summaryOutputTokens?: number
    retrievalInputTokens?: number
    retrievalOutputTokens?: number
    transformInputTokens?: number
    transformOutputTokens?: number
    stepCount?: number
    durationMs?: number
    fallback?: boolean
    error?: string
  }
}
```

若 API 尚未存在，报告状态为 `integration-pending`，并明确使用 `legacy-fallback`；不得据此宣称 v2 qualification 通过。

## Electron smoke

运行：

```bash
npm run test:e2e:electron:context-optimization
```

该脚本使用隔离的 `JOKER_HOME`、Electron user-data 和 fake Provider，验证：

1. `legacy|observe|v2|disabled` 模式可读取、保存并跨重启持久化；
2. Provider 收到压缩投影，而 Session 中工具原文在运行前后及重启后保持字节一致；
3. fake Provider 可发现并调用 `ContextRetrieve`，回取当前 session 的原始 sentinel；
4. `context-usage` 事件和 `ContextUsageIndicator` 展示模式、transform、summary/retrieval 成本及 estimated net saved；
5. Renderer 无 console error 和 page error。

未就绪能力记录为 `integration-pending`，脚本仍会继续收集能够验证的 Session 保真、重启和错误信息。只有所有检查为 `pass` 时才能称 Electron context optimization smoke 通过。

## 当前需整合点

以脚本运行报告为最终依据，预期产品侧至少需要：

- `AppConfig`、config normalization/persistence 和 Settings UI 提供 `contextOptimizationMode`；
- `runAgent` 根据模式选择 legacy/observe/v2/disabled，并将 v2 投影发送给 Provider；
- 压缩投影携带稳定 `contextId`，但不修改 Session 原始消息；
- 工具 registry 注册只读、当前 session 边界内的 `ContextRetrieve`；
- `ContextUsage`/stream event 提供 summary、retrieval、transform、estimated net saved、mode/fallback 指标；
- `ContextUsageIndicator` 明确区分 provider measured 与 local estimated。
