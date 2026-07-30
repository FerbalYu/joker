# JOKER 上下文优化演进计划

> 状态：规划稿
> 日期：2026-07-30
> 范围：JOKER 自有上下文优化能力，不引入 Headroom 运行时或外部代理
> 原则：保留原始会话、只优化模型投影、可回取、可观测、可关闭

## 1. 背景

JOKER 已具备上下文压缩基础：

- Renderer 每次发送完整会话，main process 将 `ChatMessage[]` 转换为 `ModelMessage[]`。
- `src/main/agent/context.ts` 按估算 token 判断是否需要压缩。
- 当前触发条件取以下两者的较小值：模型上下文的 80%，或减去输出预留和 4096 safety reserve 后的硬限制。
- 触发后保留约 55% 最近消息，使用当前模型总结更旧历史。
- 单个大型工具结果最多投影为约 16,384 token，使用 70% 头部 + 30% 尾部截断。
- 初始请求和每个 `prepareStep` 都会重新调用 `compressContext()`。
- Session JSON 仍保留原始聊天消息，当前压缩只影响发送给模型的投影视图。
- 已记录 provider usage、cache read/write token、上下文分类占比和最近压缩前后 token。

这套实现可以避免 provider context overflow，但仍属于“通用摘要 + 无语义截断”。主要问题是：

1. 同一段旧历史可能在每个新请求中被重复总结。
2. 每个 tool step 会重新检查全部消息，而不是只处理新增 live zone。
3. JSON、日志、代码、搜索结果、网页和 MCP 输出采用同一种字符串截断方式。
4. 被截断内容虽然通常仍在 Session JSON 中，但模型没有按 ID 回取原文的工具。
5. 当前压缩展示没有计算 summary 调用、retrieval 和重试后的净 token 节省。
6. 小 context 配置可能使硬阈值下降到 1，导致几乎每次请求都触发压缩。

## 2. 目标

### 2.1 产品目标

- 长时间 coding、research 和 MCP 会话中减少重复输入 token。
- 避免上下文接近上限时粗暴丢弃旧决策、错误、文件路径和未完成事项。
- 让 Agent 能在需要时回取压缩前的原始工具结果。
- 保持短会话零额外模型调用、零额外用户等待。
- 将“压缩率”升级为“净节省 + 质量 + 延迟 + 缓存命中”的联合验收。

### 2.2 工程目标

- 区分 frozen prefix 与 live zone，只处理新增动态上下文。
- 建立可扩展的 content/tool-aware compressor registry。
- 使用确定性压缩优先，LLM summary 只处理旧对话和普通长文本。
- 建立持久化、带版本和 source hash 的 session checkpoint。
- 保持所有新能力可测试、可旁路、可回滚，不依赖真实 Provider 进入 CI。

## 3. 非目标

本计划第一阶段不做以下事项：

- 不安装或代理 Headroom。
- 不引入向量数据库、embedding service 或大型本地模型。
- 不尝试压缩 system prompt、当前用户请求、工具 schema 或最近关键 turn。
- 不把 provider 原生 context compaction 替换为 JOKER 私有协议。
- 不承诺任意任务都能达到固定压缩率。
- 不在压缩失败时静默覆盖原始 Session 数据。
- 不让 `ContextRetrieve` 读取其他 session、任意文件路径或外部资源。

## 4. 设计原则

### 4.1 Frozen prefix 与 live zone

Frozen prefix 默认包含：

- `capabilities.systemPrompt`。
- 当前启用的 Skill instructions。
- 内置和 MCP tool schema。
- 当前用户目标与最近关键 turn。
- 已生成并通过 source hash 校验的历史 checkpoint。

Live zone 默认包含：

- checkpoint 之后新增的用户与 assistant 消息。
- 最新工具调用与工具结果。
- 新增 WebSearch、WebRead、MCP、Bash、Read、Grep 和 sub-agent 输出。

`prepareStep` 只处理新增 live zone，不重新总结已经冻结的 checkpoint。

### 4.2 确定性压缩优先

优先级：

1. 去重、minify、模板折叠、字段筛选、分组统计。
2. 基于工具类型和当前任务的相关性筛选。
3. 结构化 checkpoint。
4. 只有无法安全确定性压缩的旧 prose/history 才调用 LLM summary。

### 4.3 可回取压缩

压缩结果必须包含稳定引用：

```text
[Context compressed]
contextId: ctx_session_message_tool
source: Bash
originalTokens: 42150
projectedTokens: 3900
omitted: repeated log templates and low-relevance lines

需要细节时调用 ContextRetrieve。
```

“可回取”是运行时恢复机制，不替代 Session 原始消息持久化。

### 4.4 不修改原始会话

- `ChatMessage[]` 继续保存完整 UI 历史。
- 压缩器只生成 `ModelMessage[]` 投影和 checkpoint sidecar。
- 编辑历史消息、删除 session、修改 tool result 后必须让旧 checkpoint 失效。
- 任何迁移失败都应回退到原始会话重建上下文。

### 4.5 可观测与可关闭

每次 transform 记录原因、输入输出 token、耗时、是否调用模型、是否可回取和错误。配置中保留 legacy/observe/v2/disabled 四种状态，出现质量或兼容问题时可以立即切回 legacy。

## 5. 目标架构

```text
Session 原始消息
    │
    ├─ ContextCheckpointStore
    │    ├─ source message range
    │    ├─ source hash
    │    ├─ structured summary
    │    └─ policy version
    │
    └─ ContextCompiler
         ├─ Detect：消息类型、toolName、内容格式
         ├─ Protect：当前目标、错误、ID、路径、数字、约束
         ├─ Budget：模型窗口、输出预留、工具 schema、Skill/MCP
         ├─ Route：选择对应 compressor
         ├─ Transform：生成压缩投影
         ├─ Reference：附加 contextId
         └─ Observe：记录 token、延迟、回取和错误
                    │
                    ▼
              streamText messages
                    │
                    └─ ContextRetrieve
                         └─ 从当前 session 原始消息或 artifact 读取
```

## 6. 建议数据结构

### 6.1 Context checkpoint

```ts
interface SessionContextCheckpoint {
  version: 1
  policyVersion: string
  sourceFromMessageId: string
  sourceUntilMessageId: string
  sourceHash: string
  createdAt: number
  summary: {
    goal: string
    confirmedFacts: string[]
    decisions: string[]
    filesRead: string[]
    changesMade: string[]
    failedAttempts: string[]
    openTasks: string[]
    criticalIdentifiers: string[]
  }
  estimatedSourceTokens: number
  estimatedSummaryTokens: number
  summaryUsage?: StreamUsage
}
```

Checkpoint 推荐作为 Session envelope 的可选字段持久化，沿用当前 per-session lock、临时文件、backup 和恢复链路。引入字段时升级 schema version，并提供旧 Session 无 checkpoint 的兼容读取。

### 6.2 Context reference

```ts
interface ContextReference {
  contextId: string
  sessionId: string
  messageId: string
  toolCallId?: string
  sourceType: 'message' | 'tool-result' | 'artifact'
  sourceName?: string
  contentHash: string
  originalTokens: number
  projectedTokens: number
  createdAt: number
}
```

优先引用 Session 中已有 `ToolCallInfo.output`，避免重复保存大文本。只有工具自身需要在返回上限前保留完整原文时，才写入独立 artifact。

### 6.3 Compression metrics

```ts
interface ContextOptimizationMetrics {
  policyVersion: string
  mode: 'legacy' | 'observe' | 'v2'
  transforms: Array<{
    sourceType: string
    transform: string
    beforeTokens: number
    afterTokens: number
    durationMs: number
    contextId?: string
  }>
  summaryInputTokens: number
  summaryOutputTokens: number
  retrievalInputTokens: number
  retrievalOutputTokens: number
  estimatedAvoidedInputTokens: number
  estimatedNetSavedTokens: number
  retrievalCount: number
  retrievalFailureCount: number
}
```

`estimatedNetSavedTokens` 必须标明 estimated，不能伪装成 provider 实测。

## 7. Compressor 路由

| 来源 | 第一阶段策略 | 必须保护 |
|---|---|---|
| `Read` | 保留目标行段、符号定义、imports、首尾边界；大文件按行范围引用 | 文件路径、行号、标识符、错误相关代码 |
| `Grep` / `Glob` | 按文件分组、重复命中折叠、限制每文件代表项 | 总命中数、文件名、精确匹配行 |
| `Bash` | 日志模板折叠、相同行计数、保留状态变化和首尾异常 | exit code、stderr、error、stack trace、时间边界 |
| `GitDiff` | 保留文件统计与完整相关 hunk，按文件预算裁剪 | 文件名、hunk header、增删行、冲突标记 |
| `WebSearch` | 去重 URL/hostname，保留标题、snippet、排序与来源编号 | URL、标题、查询、排名 |
| `WebRead` | 标题层级、与当前问题相关段落、关键数字和引用；原文按 source/context ID 回取 | URL、标题、日期、引用、否定和限制 |
| `MCP` JSON | JSON minify、重复对象聚合、字段统计、异常和离群项采样 | `isError`、ID、状态、错误字段、schema 关键字段 |
| `Agent` | 输出转为 goal/facts/findings/open questions 结构 | 未完成事项、证据路径、失败尝试 |
| `TodoWrite` | 只保留最新完整 todo snapshot，旧 snapshot 去重 | in-progress、pending、priority |
| 旧对话 | 结构化 checkpoint，必要时使用 LLM | 当前目标、决策、文件、命令、错误、未完成事项 |

无法识别类型时使用 generic text compressor；压缩结果没有达到最小节省或保护规则无法满足时返回原文。

## 8. Token 预算策略

### 8.1 分级触发

建议从单一 80% 阈值改为分级策略：

| 使用率 | 行为 |
|---|---|
| `< 60%` | 不调用 summary；仅使用工具自身已有安全输出限制 |
| `60%–75%` | 对新增大型 JSON、日志、搜索结果执行确定性压缩 |
| `75%–85%` | 复用或更新历史 checkpoint，分配各内容类型预算 |
| `> 85%` | 更积极裁剪 live zone，但仍保留当前用户 turn 和 retrieval reference |

具体百分比应通过基线测试调整，不能直接作为永久常量。

### 8.2 配置校验

- 输入预算不得被 `outputTokenReserve + safetyReserve` 压缩到接近零。
- 对小 context 模型限制最大输出预留比例，或在配置保存时明确报错。
- Token estimator 仍可作为触发依据，但 provider 实测 usage 用于后续校准。
- Image/file token 不再永久使用固定 256 估算；按 provider 能力或保守上界分别估算。

### 8.3 压缩预算分配

预算分配顺序：

1. system instructions、Skill、tool definitions、当前用户 turn。
2. 最近 assistant/tool loop。
3. 历史 checkpoint。
4. 当前任务相关工具结果。
5. 低相关性旧工具结果。

不能通过压缩 system prompt 或当前用户意图来补偿过大的 MCP schema；应单独减少暴露的工具集合或采用渐进式工具发现。

## 9. 分阶段实施

## Phase 0：基线与契约固定

目标：在改变行为前建立可比较证据。

任务：

- 为当前 legacy compaction 增加完整 fixture：长 coding 会话、大 JSON、重复日志、长 WebRead、MCP 列表、sub-agent 报告。
- 记录每个 fixture 的原始 token、summary usage、最终请求 token、step 数和延迟。
- 增加保护项断言：最新用户消息、错误码、文件路径、行号、ID、数字、否定条件不得丢失。
- 固定短会话不触发额外 `generateText()` 的测试。
- 增加小 context 配置测试，明确合理的最小输入预算。

涉及文件：

- `src/main/agent/context.test.ts`
- `src/main/agent/usage.test.ts`
- `src/main/agent/loop.test.ts`
- `scripts/fixtures/fake-provider.mjs`

完成标准：legacy 行为有可重复基线，后续每个阶段都能对比净成本和保护项。

## Phase 1：ContextReference 与原文回取

目标：先建立恢复路径，再提高压缩强度。

任务：

- 给压缩后的 tool result 附加 `contextId`、原始 token 和压缩说明。
- 新增只读内置工具 `ContextRetrieve`。
- `ContextRetrieve` 只允许读取当前 `ToolContext.sessionId` 的原始消息。
- 支持按 `toolCallId`、关键词、行范围读取，单次返回有硬上限。
- 删除 session 后引用失效；编辑消息后旧 hash 不匹配时拒绝返回。
- retrieval 进入现有 approval/risk/audit 体系，但不授予文件或网络能力。

涉及文件：

- `src/shared/types.ts`
- `src/main/store/sessions.ts`
- `src/main/agent/context.ts`
- 新增 `src/main/tools/context-retrieve.ts`
- `src/main/tools/registry.ts`
- 对应单元测试

完成标准：压缩后的内容可以通过稳定 ID 找回当前 session 原始工具结果；跨 session、伪造 ID 和过期 hash 均失败。

## Phase 2：确定性工具结果压缩

目标：替换统一头尾截断，减少不必要的 LLM summary。

任务：

- 建立 `toolName/contentType -> compressor` registry。
- 先实现 JSON、日志、Grep/Search、GitDiff 四类 compressor。
- 输出统一 transform metadata：压缩原因、保留规则、遗漏数量、contextId。
- 对无法安全解析的输入回退到 legacy head/tail，但必须保留 retrieval reference。
- 不改变 Session 原始消息和 UI 中用户看到的完整工具输出。

建议在 compressor 达到三类以上后再机械拆分目录：

```text
src/main/agent/context/
├── budget.ts
├── router.ts
├── references.ts
├── checkpoint.ts
└── compressors/
    ├── json.ts
    ├── logs.ts
    ├── search.ts
    └── git-diff.ts
```

完成标准：大 JSON 和重复日志 fixture 获得显著 token 降低，所有 error/outlier/ID 保护断言通过。

## Phase 3：持久化 checkpoint 与增量 live zone

目标：消除跨 turn 重复总结和单次 run 内重复压缩。

任务：

- 在 Session envelope 中增加可选 `contextCheckpoint`，升级 schema version。
- Checkpoint 由 source message range、source hash、policy version 和结构化 summary 组成。
- 新请求优先复用有效 checkpoint，只处理其后的新增消息。
- `prepareStep` 按新增 toolCallId 增量处理，不重新总结冻结区。
- 编辑/替换历史消息、切换压缩策略、模型能力变化时自动失效并重建。
- Summary 使用固定结构输出，并加入当前任务相关性，而不是自由散文摘要。

涉及文件：

- `src/main/store/sessions.ts`
- `src/main/store/sessions.test.ts`
- `src/main/agent/context.ts` 或拆分后的 `checkpoint.ts`
- `src/main/agent/loop.ts`
- `src/main/agent/loop.test.ts`

完成标准：同一未变化历史在后续 turn 中不再次调用 summary model；新增工具结果只压缩一次。

## Phase 4：预算、净节省和 UI 可观测

目标：证明压缩真的降低总成本，而不只是消息长度。

任务：

- 增加 summary、transform、retrieval 和 net saving 指标。
- ContextUsageIndicator 区分 provider measured 与 local estimated。
- 展示最近 transform 类型、是否可回取、summary 成本和估算净节省。
- 增加 legacy/v2 对比报告，不在普通聊天流中堆叠调试信息。
- 配置页增加优化模式和快速关闭开关。

涉及文件：

- `src/shared/types.ts`
- `src/main/agent/usage.ts`
- `src/main/agent/loop.ts`
- `src/renderer/src/components/ContextUsageIndicator.tsx`
- `src/renderer/src/components/SettingsModal.tsx`
- `src/main/store/config.ts`

完成标准：用户能区分“上下文变短”和“总 token 净减少”，且可以一键关闭 v2。

## Phase 5：影子验证与逐步启用

目标：在不影响真实回答的情况下验证新策略。

模式：

- `legacy`：当前实现。
- `observe`：运行 v2 编译并记录结果，但仍发送 legacy messages。
- `v2`：发送 v2 messages。
- `disabled`：完全不做自动压缩，仅依赖硬限制保护。

步骤：

1. CI 只运行确定性 fixture 和 fake Provider，不调用真实 Provider。
2. 本地 opt-in eval 对同一会话运行 legacy/v2 paired comparison。
3. 先对 JSON、日志和 search compressor 启用 v2。
4. 再启用 checkpoint 与 LLM summary。
5. 出现 retrieval failure、保护项缺失或净 token 为负时自动回退 legacy。

## 10. 测试与验收

### 10.1 必须测试的契约

- Frozen prefix 在同一 run 内保持稳定。
- 当前用户消息和最近关键 turn 不被总结或截断。
- Tool call 与 tool result 配对不被拆散。
- Error、stack trace、文件路径、行号、ID、数字和否定条件得到保护。
- Session 原始消息在压缩前后字节一致。
- `ContextRetrieve` 精确命中原文，跨 session 访问失败。
- Checkpoint 在历史编辑后失效，在未变化时复用。
- Summary 失败时不会覆盖原始 checkpoint。
- 小 context 配置不会无条件把 threshold 降到 1。
- 短会话不会产生额外 summary 调用。
- Abort、session switch 和并发 append 不留下损坏 checkpoint。

### 10.2 建议发布门槛

这些是目标门槛，需要在 Phase 0 基线后确认：

- 所有结构保护测试 100% 通过。
- `ContextRetrieve` fixture 成功率 100%。
- 大 JSON/重复日志 fixture 的净输入 token 降低目标不少于 30%。
- 长 coding fixture 的净输入 token 降低目标不少于 15%。
- 未变化 checkpoint 在后续 turn 中 summary 调用次数为 0。
- Short-chat fixture 的额外模型调用次数为 0。
- V2 产生错误或超过硬预算时能确定性回退 legacy。

真实 Provider 评测保持 opt-in，不进入默认 CI，也不得把少量模型结果包装成普遍质量结论。

## 11. 安全与隐私边界

- `ContextRetrieve` 只读取当前 session，不接受任意文件路径。
- contextId 必须绑定 sessionId、messageId/toolCallId 和 content hash。
- Tool output 中的 credential、header 和 token 继续遵守现有日志脱敏规则。
- 独立 artifact 如需落盘，必须有容量上限、TTL、session 删除联动和原子写入。
- MCP 与网页内容仍是不可信数据；压缩摘要不能把其中指令提升为 system instruction。
- 压缩器不得改变 approval、tool permission、Skill allowlist 或 workspace boundary。
- Metrics 不保存完整 prompt、完整工具输出或 secret。

## 12. 主要风险与控制

| 风险 | 控制措施 |
|---|---|
| Summary 遗漏关键事实 | 固定结构、保护字段、原文回取、paired fixtures |
| 每步重复 summary 导致成本上升 | 持久 checkpoint、live-zone cursor、source hash |
| JSON/日志误分类 | 置信度不足时回退原文或 legacy |
| Retrieval 形成无限循环 | 单次输出上限、每 run 次数预算、记录失败原因 |
| Checkpoint 与编辑后的历史不一致 | message range hash、编辑即失效 |
| Prompt cache 命中下降 | Frozen prefix 保持稳定，tool order 继续固定 |
| 本地 Session 文件膨胀 | 优先引用已有 output，artifact 设置 TTL/容量 |
| Token estimator 不准 | provider measured usage 校准，本地估算明确标注 |
| 新策略影响现有大量改动 | feature flag、按 phase 小批量提交、保留 legacy |

## 13. 文件级实施清单

| 文件 | 计划职责 |
|---|---|
| `src/main/agent/context.ts` | 保留 facade；逐步迁移预算、路由、checkpoint 与 reference 编排 |
| `src/main/agent/loop.ts` | 保存 run-scoped live-zone state，避免每步全量压缩 |
| `src/main/agent/usage.ts` | 统计 summary、retrieval、transform 与净节省 |
| `src/main/model-messages.ts` | 保持稳定 toolCallId，并为 context reference 保留必要 sidecar |
| `src/main/store/sessions.ts` | 持久化 checkpoint、按 toolCallId 查找原始输出、处理失效 |
| `src/main/tools/context-retrieve.ts` | 当前 session 原文回取工具 |
| `src/main/tools/registry.ts` | 注册工具并纳入现有风险、审批和审计链 |
| `src/shared/types.ts` | ContextReference、Checkpoint、Metrics 和 StreamEvent 类型 |
| `src/renderer/src/components/ContextUsageIndicator.tsx` | 展示 measured/estimated、净节省与回取情况 |
| `src/main/store/config.ts` | legacy/observe/v2/disabled 模式和策略版本 |
| `README.md` / `MILESTONES.md` | 功能完成后更新真实边界，不提前宣称完成 |

## 14. 推荐首个实现批次

首批只做低风险闭环，不立即重写全部 `context.ts`：

1. 增加 Phase 0 fixtures 和保护项测试。
2. 实现 `ContextReference` 与只读 `ContextRetrieve`。
3. 让现有 head/tail 截断附带可回取 ID。
4. 增加小 context 配置校验。
5. 增加 summary 实际成本与估算净节省字段。

完成这一批后，JOKER 即使仍使用旧截断策略，也已经从“不可恢复地丢模型上下文”升级为“原文保留、可诊断、可回取”。随后再进入 JSON/log compressor 和持久化 checkpoint，风险更可控。
