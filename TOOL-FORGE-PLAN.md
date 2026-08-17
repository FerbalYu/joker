# JOKER ToolForge 自造工具与热加载实施计划

> 状态：修订稿 v3（对齐已发布实现）
> 日期：2026-08-05（v3 更新：2026-08-14）
> 修订记录：
> - v2 — 对照代码逐条核对 §2 事实声明（修正 3 处细节）；新增 §8.2.1 运行等级与降级路径；§17/§21/§22 按等级调整退出条件与 Vertical Slice 验收变体；§20 补充资格门禁风险行
> - v3 — 依据已发布的 ToolForge 实现（提交 `ecc7390` 及后续工作树）对齐文档：当前实现采用 `user-owned-full-trust-v1` 全信任运行时，无审批门、无权限门；原分级资格门禁（§8.2.1）与按权限 fail-closed 策略矩阵（§11.1）已不被当前实现采用，相关段落标注为「历史设计（已被全信任覆盖）」，保留作为设计演进记录。
> 范围：JOKER 自主发现工具缺口、委派 ForgeAgent 制造 Tool、验证、热加载、继续原任务，以及“设置 → 自造工具”的管理与定向编辑闭环
> 首期边界：项目级、本地 Tool；生成代码只在独立 Node 子进程（`fork`）中运行，不把任意生成代码直接载入 Electron 主进程地址空间

## 0. 实现现状（v3，权威）

> 本节的代码事实以当前 `src/main/generated-tools/**` 为准，取代本文中与其冲突的历史设计描述。

已发布并维持的策略为**全信任运行时（`user-owned-full-trust-v1`）**：

- **执行模型**：生成代码通过 `fork()` 在独立 Node 子进程中运行（`runtime/user-owned-full-trust-runner.ts`），不进入 Electron 主进程地址空间。子进程仅隔离取消语义；它**不是能力或策略边界**，生成代码以**当前桌面用户账户权限**执行（源码注释原文：*"This profile intentionally runs generated code with the current desktop user account permissions. The child process only keeps cancellation isolated from Electron; it is not a capability or policy boundary."*）。
- **审批与权限门**：`policy.ts` 的 `evaluateGeneratedToolPolicy()` 对所有输入返回 `allow`（reasonCode `workspace-full-trust-authorized`，reason 原文 *"ToolForge has no approval or permission gate"*，`requiresApproval: false`，`hardDeny: false`）。生成工具注册为 `validationProfile: 'user-owned-full-trust-v1'` 时，`registry.ts` 的执行路径同样跳过审批 gate 自动执行。
- **验证与证据仍然存在**：ForgeAgent 只制造，宿主 Validator 独立验收（编译、测试、越权/路径探测、超时、取消、审计），ValidationReport 绑定 fingerprint；这些是**事实验收**，不是授权门。
- **仍然生效的防护**：生成代码无法调用 JOKER IPC、修改 Tool Registry 或写审计文件；执行受超时/取消/进程树清理约束；运行在 workspace 目录内；内容或权限变化自动使旧版失效并可回滚/停用/删除。
- **产品/Agent 层约束（非运行时强制）**：不允许修改 JOKER 主进程、审批系统、Registry 或 ToolForge 实现；不允许自动读取系统凭证/浏览器 Cookie/SSH Key/未声明环境变量；不允许发布、支付、删除生产数据等不可逆操作。这些由 Agent 提示词与工具暴露面约束，**不构成运行时技术强制**。
- 代码中仍保留 L0/L1/L2 运行时资格机制（`runtime-qualification-service.ts`、`qualification.ts`），但当前策略硬编码 `runtimeQualificationLevel: 'L2'` 且忽略磁盘上的资格报告结果，因此**不参与授权决策**。

## 1. 结论

> **v3 注**：下文及后续 §2–§23 描述 v2 的设计流程。其中「Policy Engine 根据权限与运行模式决定自动通过或请求用户」等授权步骤，在已发布的全信任实现中已简化为恒 `allow`（见 §0）；「受控 Tool Runner」的隔离语义也已由全信任子进程模型取代。其余机制（ToolSearch→ForgeAgent→Validator→Promote→续跑）仍与实现一致。

JOKER 应具备 Tool 自举能力：当主 Agent 判断现有 Tool 无法完成用户任务时，能够自主搜索已有能力、生成结构化 ToolSpec、委派专用 ForgeAgent 编写 Tool、由宿主验证器独立验收、按策略安装并刷新工具集合，然后在同一个用户任务中继续调用新 Tool。

首期推荐采用“JOKER 自造 Tool + 本地受控 Tool Runner + MCP 桥接”的结构：

```text
用户任务
  ↓
主 JOKER 判断能力缺口
  ↓
ToolSearch：确认没有可复用 Tool
  ↓
ToolForgeStart：创建持久化 ForgeJob
  ↓
ForgeAgent：只在隔离 job 目录制造 Tool
  ↓
Deterministic Validator：编译、测试、越权、超时、MCP 契约验证
  ↓
Policy Engine：根据权限与运行模式决定自动通过或请求用户
  ↓
ToolPromote：生成版本、指纹并切换稳定版本
  ↓
capabilityRevision 递增，宿主自动重建 ToolSet
  ↓
主 JOKER 继续原任务并调用新 Tool
```

ForgeAgent 只有制造权，不能给自己授信、安装、扩大权限或修改安全策略。宿主验证器负责事实验收，Policy Engine 负责授权，Tool Registry 负责版本与可用状态，主 JOKER 负责使用。

## 2. 当前代码事实与约束

### 2.1 已有可复用基础

- `src/main/tools/registry.ts` 已定义统一的 `ToolDefinition`、Zod 输入 Schema、执行上下文、审批 gate 和工具审计入口。
- `src/main/tools/risk.ts` 已有 `read`、`write_local`、`exec`、`external` 四级风险分类。
- `src/main/agent/approval.ts` 已按窗口（实际粒度是 WebContents.id，经 BrowserWindow 映射层解析）、会话和 run 隔离审批状态，并支持建议、自动编辑、全自动模式。
- `src/main/tools/audit.ts` 已有脱敏、截断和 JSONL 工具审计。
- `src/main/mcp/client.ts` 已具备 MCP stdio/Streamable HTTP 连接、工具发现、指纹、信任、权限、超时、崩溃恢复和进程清理能力。
- `src/main/tools/mcp-bridge.ts` 已能把 MCP Tool 转成 JOKER `ToolDefinition`。
- `src/main/agent/execution-contract.ts` 已能依据任务类型要求真实工具调用，而不是允许可执行任务退化为纯文本回复。
- `src/main/goal/`、session 持久化和 run registry 已提供长任务、恢复和并发控制的部分基础。

### 2.2 必须改造的现状

- `src/main/tools/subagent.ts` 中普通 `Agent` subagent 只获得 Read/Grep/Glob/Git 只读工具，不能直接承担 Tool 制造；需要单独的 ForgeAgent 运行契约。
- `src/main/stream.ts` 在每次 run 开始时调用 `buildAllTools()` 并构建固定 ToolSet；运行中新增 MCP Tool 不会自动出现在当前模型步骤。
- `src/main/agent/loop.ts` 的 `prepareStep` 当前可以限制 `activeTools`，但不能向已经创建的 ToolSet 添加新定义。
- `src/shared/types.ts` 只有内置 Tool、MCP、Skill、审批和会话类型，没有 Generated Tool、ForgeJob、版本、权限清单和验证报告模型。
- `src/renderer/src/components/SettingsModal.tsx` 目前只有 Provider、Image、MCP、Skills 四个分区；复杂 Tool 编辑不适合全部塞进现有设置 Modal。
- 当前 MCP 的 `enabled`、`trustState`、`permission` 是三个独立状态轴，`getAllTools()` 要求三者同时满足，因此会出现“已启用且已信任但权限拒绝”的矛盾组合。自造 Tool 不应复制这种多轴状态 UI，而应使用单一、可解释的可用状态。

### 2.3 历史设计：不能当作安全边界的方案

> **v3 注**：本节反映 v2 设计期的安全约束。当前全信任实现（见 §0）已不再采用"分级资格门禁 + fail-closed 权限矩阵"模型；下述"不得作为安全边界"的底线在当前实现中只有第一、三、五条仍然被遵循，其余已被全信任模型有意改变。保留本节作为设计演进记录。

v2 设计期列出的、不得作为自造 Tool 自动运行正式安全边界的方案：

- 在 Electron 主进程中使用 `eval()`、动态 `import()` 或直接加载生成模块。— **仍遵循**：生成代码只在 `fork` 出的独立 Node 子进程运行，不载入主进程地址空间。
- 把 Node `vm`、普通 Worker Thread 或普通 child process 当作可靠沙箱。— **已被全信任模型有意改变**：当前 `user-owned-full-trust-v1` 以普通 `fork` 子进程运行，并明确它不是能力/策略边界（见 §0）。
- 仅依赖 ForgeAgent 在 manifest 中声明“不会联网”或“只读”。— **仍部分遵循**：ForgeAgent 无自证权，Validator 独立事实验收；但全信任下不再据此做授权放行/拒绝。
- 只做静态代码扫描，不做真实越权测试和运行时权限拦截。— **已被改变**：Validator 仍做真实越权/路径探测，但运行时不再拦截权限。
- ForgeAgent 自己编写测试、自己解释测试、自己决定安装。— **仍遵循**：验证与安装由宿主 Validator/Registry 掌控。

## 3. 产品目标

### 3.1 用户目标

- 用户提出任务时，无需先理解、寻找或手动安装插件。
- JOKER 能明确判断“现有 Tool 不足”，并自主制造缺失能力。
- 制造过程不丢失原任务；工具可用后自动继续。
- 用户能在主对话看到 JOKER 新造了什么、为什么造、结果如何。
- 用户能在“设置 → 自造工具”查看全部 Tool 的用途、权限、版本、验证和使用记录。
- 用户能选中一个具体 Tool，用自然语言要求 JOKER 定向修改。
- 修改失败时继续使用旧稳定版本，不让当前任务被半成品破坏。
- 用户能停用、重新验证、回滚、导出和删除 Tool。

### 3.2 Agent 目标

- 先查找已有 Tool，避免重复制造。
- 使用结构化 ToolSpec 表达能力缺口，而不是直接自由发挥代码。
- Tool 制造、测试、安装和调用形成证据闭环。
- 新 Tool 成为可发现、可版本化、可审计、可恢复的持久能力。
- Agent 不得通过自造 Tool 绕过当前 workspace 边界、不得扩大自身权限、不得修改安全策略、审批系统或 ToolForge 实现。全信任模型下自造 Tool 执行本身不设审批/权限门（见 §0），该条目指主 JOKER 不得借助 ToolForge 篡改宿主约束。

### 3.3 工程目标

- Generated Tool 不进入 Electron 主进程地址空间。— 全信任实现下改为：在独立 Node 子进程（`fork`）中运行，不载入主进程；子进程以当前用户权限执行，不是能力/策略边界（见 §0）。
- ToolSet 刷新不要求用户重启应用或重新发送任务。
- ForgeJob、ToolVersion、ValidationReport 和运行审计持久化，应用重启后可恢复。
- 所有状态由宿主事实派生，不能由模型文本声称完成。
- 首期测试不访问真实 Provider、外部 MCP、真实凭证或公共网络。
- 新能力可通过功能开关关闭，并可回退到现有静态 ToolSet。

## 4. 非目标

首期不做：

- 允许 JOKER 修改自身主进程、安全策略、审批系统或 ToolForge 实现。
- 自动安装任意 npm、Python、系统级或全局依赖。
- 自动读取系统凭证、浏览器 Cookie、SSH Key 或未声明环境变量。
- 自动发布、部署、付款、通知第三方、删除生产数据或执行其他不可逆操作。
- 构建公共 Tool 市场、评分系统或云同步。
- 让自造 Tool 自动替换内置核心 Tool。
- 承诺生成任意原生能力；首期只支持受控 Tool SDK 和批准的运行时能力。
- 把 Skill 当作 Tool。Skill 仍然是可信指令包，不执行代码，也不授予权限。

## 5. 核心概念

### 5.1 ToolSpec

主 JOKER 对能力缺口的结构化描述，是 ForgeAgent 唯一的制造任务输入。

```ts
interface GeneratedToolSpec {
  id: string
  displayName: string
  goal: string
  reason: string
  requestedBy: {
    sessionId: string
    runId: string
    userMessageId: string
  }
  scope: 'project' | 'user'
  projectId?: string
  inputContract: Record<string, unknown>
  outputContract: Record<string, unknown>
  permissions: GeneratedToolPermissionManifest
  acceptance: string[]
  examples: Array<{
    input: Record<string, unknown>
    expected: string
  }>
}
```

### 5.2 ForgeJob

一次持久化制造或修改任务。它不是临时聊天输出，必须能跨窗口、跨 run、跨应用重启恢复。

```ts
type ForgeJobStatus =
  | 'queued'
  | 'planning'
  | 'building'
  | 'validating'
  | 'awaiting-policy'
  | 'promoting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

interface ForgeJob {
  id: string
  toolId: string
  baseVersionId?: string
  mode: 'create' | 'edit' | 'repair'
  status: ForgeJobStatus
  revision: number
  spec: GeneratedToolSpec
  attempt: number
  maxAttempts: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  currentPhase?: string
  artifactPath: string
  validationReportId?: string
  error?: string
  resumeHint?: string
}
```

### 5.3 GeneratedTool 与 ToolVersion

Tool 是稳定身份，Version 是不可变构建产物。编辑永远创建新草稿版本，不能原地覆盖当前稳定版本。

```ts
type GeneratedToolAvailability =
  | 'available'
  | 'building'
  | 'validating'
  | 'failed'
  | 'disabled'
  | 'changed'
  | 'quarantined'

interface GeneratedToolDescriptor {
  id: string
  displayName: string
  description: string
  scope: 'project' | 'user'
  projectId?: string
  availability: GeneratedToolAvailability
  activeVersionId?: string
  lastStableVersionId?: string
  createdBy: 'joker'
  createdForSessionId?: string
  createdForRunId?: string
  permissionSummary: string[]
  invocationCount: number
  lastInvokedAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

interface GeneratedToolVersion {
  id: string
  toolId: string
  version: number
  fingerprint: string
  manifest: GeneratedToolManifest
  artifactPath: string
  sourceHash: string
  validationReportId: string
  trustState: 'trusted' | 'untrusted' | 'changed'
  createdAt: number
}
```

### 5.4 权限清单

权限必须精确表达范围，不使用“完全文件访问”“允许联网”等模糊描述。

```ts
interface GeneratedToolPermissionManifest {
  filesystem: {
    read: string[]
    write: string[]
  }
  network: {
    hosts: string[]
    methods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
  }
  process: {
    commands: string[]
  }
  environment: {
    keys: string[]
  }
  secrets: {
    handles: string[]
  }
}
```

规则：

- 路径必须在宿主解析后校验真实绝对路径，不能只做字符串前缀比较。
- 网络权限按规范化 hostname 和协议匹配，不接受任意通配符作为默认值。
- 机密只提供 opaque handle，由宿主代为注入或调用；Tool 不读取配置文件中的明文密钥。
- 权限扩大视为新版本且自动失效，必须重新验证和授权。
- Tool 未声明的能力默认拒绝。

## 6. 角色与职责

| 角色 | 负责 | 不负责 |
|---|---|---|
| 主 JOKER | 判断能力缺口、创建 ToolSpec、委派制造、继续原任务 | 直接写 Tool 文件、给 Tool 自授权 |
| ToolSearch | 查重、能力匹配、返回已有 Tool 和差距 | 自动选择高风险替代 Tool |
| ForgeAgent | 在 job 目录生成源码、Schema、测试和说明 | 安装、授信、修改宿主策略 |
| Tool Runner | 隔离运行生成代码、暴露受控能力 | 相信 manifest 自我声明 |
| Validator | 编译、测试、权限、MCP、超时、取消和恢复验证 | 根据模型解释降低验收标准 |
| AuditAgent | 可选的独立语义审查 | 代替确定性验证器 |
| Policy Engine | 根据权限、模式、历史可靠性作出 allow/ask/deny | 读取模型的“安全保证”作为事实 |
| Tool Registry | 版本、指纹、稳定版本、状态和使用统计 | 执行生成代码 |
| Renderer | 展示制造过程、Tool 资产、差异、恢复操作 | 在前端自行决定 Tool 是否可信 |

## 7. ForgeAgent 运行契约

### 7.1 为什么不能复用普通 Agent Tool

普通 `Agent` 的只读边界应继续保持，不应为 ToolForge 放宽。新增独立 `ForgeAgent` 内部运行入口和专用工具集合：

```text
ForgeReadSpec
ForgeReadFile
ForgeListFiles
ForgeWriteFile
ForgeApplyPatch
ForgeRunCheck
ForgeReadCheckResult
ForgeSubmitCandidate
```

这些工具只能操作当前 `ForgeJob.artifactPath`，不能接收或解析任意 workspace 路径。

### 7.2 ForgeAgent 可见状态

- 结构化 ToolSpec。
- 只读 Tool SDK 文档和模板。
- 当前 job 目录文件。
- Validator 返回的结构化失败项。
- 修改任务的基线版本副本和受限 diff。

默认不可见：

- JOKER 源码工作树。
- 用户全部会话历史。
- 配置文件、API Key 和系统环境变量。
- 其他 Tool 的私有实现，除非作为明确只读模板授权。

### 7.3 初始预算与停止条件

以下是首期安全默认值，后续依据验证数据调整，不作为永久产品定律：

- 单个 ForgeJob 最多 3 次“验证失败 → 修复”循环。
- 单次最多生成 32 个文件、总源码不超过 1 MiB。
- 单次制造最长 10 分钟；UI 持续显示阶段和耗时。
- 首期禁止在线安装依赖；只允许 Tool SDK 和内置依赖白名单。
- 连续两次出现相同验证错误且没有新 diff 时停止。
- Validator 报告权限越界、逃逸尝试、审计缺失或产物指纹异常时立即隔离。
- 用户取消只停止后续执行，不等同于删除已生成草稿；草稿可继续修复或删除。

## 8. Tool Runner 与隔离资格

### 8.1 目标

> **v3 注**：本节为 v2 设计期目标，已被 §0 的全信任实现取代。保留作为设计演进记录。

v2 设计期目标：生成代码不能获得与当前 Windows 用户相同的任意文件、网络、环境变量和进程权限。Tool Runner 必须实际强制执行 manifest，而不是只依赖代码约定。

当前实现的偏离：`user-owned-full-trust-v1` 以当前桌面用户权限运行生成代码，不强制 manifest 权限（见 §0）。

### 8.2 P0 技术决策 Spike

> **v3 注**：本节为 v2 设计期的候选运行时资格验证清单。当前实现未做该矩阵并转向全信任子进程模型；下述"禁止安装和执行"的 observe 兜底在当前实现中不生效（策略始终 allow）。保留作为设计演进记录。

实现前必须对以下运行时做小型资格验证：

1. 受限 JavaScript/WASM 运行时，通过 JOKER capability broker 访问文件、网络和结构化数据。
2. 可随应用打包的独立运行时，能够强制声明式文件、网络、进程和环境变量权限。
3. OS 级隔离进程，加 JOKER broker 和资源限制。

资格验证必须证明：

- 工作区外读取被拒绝。
- 未声明网络请求被拒绝。
- 未声明子进程启动被拒绝。
- 环境变量枚举和凭证读取被拒绝。
- 超时、取消和父进程退出会清理 Tool 进程树。
- 生成 Tool 无法调用 JOKER IPC、修改 Tool Registry 或写审计文件。
- Windows 打包产物中行为与开发环境一致。

如果没有候选运行时通过上述验证，首期只能进入 observe 模式：允许生成和验证草稿，但禁止自动安装和执行。普通 child process 隔离不能被描述为安全完成。（**v3 注**：该 observe 兜底属于 v2 设计，全信任实现下不再生效，见 §0。）

#### 8.2.1 资格门禁与运行等级（历史设计，已被全信任覆盖）

> **v3 注**：本节为 v2 设计的分级资格门禁（L0/L1/L2）。当前实现保留该机制代码但策略硬编码 L2 且全信任放行，等级不再影响授权决策（见 §0）。Vertical Slice 验收与完成定义不再区分等级。

P0 产出不是单一布尔值，而是每个候选 Runner 在「开发环境 × Windows 打包环境」两个矩阵上、逐条关键隔离用例的资格清单。依据清单冻结全局运行等级，作为后续所有阶段的固定约束：

| 等级 | 条件 | 允许行为 |
|---|---|---|
| L2 完整运行 | 至少一个 Runner 在开发与 Windows 打包环境全部关键隔离用例通过 | 按 §11.1 策略矩阵自动安装与执行 |
| L1 监督运行 | 仅开发环境通过，或打包环境存在未覆盖的隔离属性 | 制造与验证照常；ToolPromote 与首次执行必须逐次用户批准（即使策略矩阵允许自动）；Windows 打包环境额外要求显式功能开关打开 |
| L0 观察模式 | 无 Runner 通过资格验证 | 只允许生成草稿与验证；禁止安装、执行和续跑调用；UI 展示资格报告并解释不可执行原因 |

规则：

- 运行等级写入持久化状态（Registry 级），L1/L0 状态下重新运行资格验证并通过后，自动升级到 L2，无需改代码。
- 升级必须重新执行全部关键隔离用例，并以新的资格报告为事实依据，不能由模型或用户口头声称。
- 资格报告本身是 ValidationReport 类证据：记录环境、Runner 版本、逐条用例结果、失败日志和结论。
- §21 的 Vertical Slice 按当前等级取验收变体：L2 走完整链路；L1 走“验证通过 → 用户逐次批准 → Promote → 续跑”；L0 的验收以“草稿 + 验证报告 + 明确不可执行原因”为终点并标记受阻塞。
- 等级为 L0/L1 时，UI 和对话事件必须持续显示当前等级与升级条件，避免用户把“制造中”误认为“即将自动可用”。

### 8.3 MCP 的角色

MCP 用于 Tool 发现和调用协议，不等同于安全沙箱。

```text
Generated Tool Source
    ↓ 编译
受控 Tool Runner
    ↓ 暴露 MCP stdio
JOKER mcpManager
    ↓ mcp-bridge
ToolDefinition
```

自造 Tool 的 MCP Server 配置由 Tool Registry 管理，不与用户手工添加的外部 MCP 配置混在同一个编辑模型中，但可以复用底层 client、fingerprint、timeout、recovery 和 audit 实现。

## 9. ToolForge 元工具

主 JOKER 应获得以下内置元工具，而不是通过 Bash 自己拼装目录：

### 9.1 `ToolSearch`

- 输入：目标能力、输入输出特征、权限上限。
- 输出：完全匹配、可组合匹配、相近 Tool、明确缺口。
- 风险：`read`。
- 完成证据：返回 Registry 的真实 Tool ID、版本和可用状态。

### 9.2 `ToolForgeStart`

- 输入：完整 ToolSpec，或已有 `toolId + baseVersion + 修改要求`。
- 行为：创建持久化 ForgeJob，启动 ForgeAgent。
- 风险：`write_local`，但只写隔离 Forge 目录。
- 输出：jobId、阶段、预算和预计的权限等级。

### 9.3 `ToolForgeStatus`

- 输入：jobId。
- 输出：当前阶段、已完成项、验证报告、下一步和阻塞。
- 风险：`read`。

### 9.4 `ToolForgeCancel`

- 输入：jobId。
- 行为：停止 subagent、Validator 和 Tool Runner 子进程，保留可恢复草稿。
- 风险：`write_local`。

### 9.5 `ToolPromote`

- 输入：jobId、validationReportId、候选 fingerprint。
- 行为：重新核对报告和 fingerprint，原子切换稳定版本。
- 风险：根据权限清单推导；不能由 ForgeAgent 调用。
- 输出：toolId、versionId、capabilityRevision。

### 9.6 `ToolRollback`

- 输入：toolId、目标稳定版本。
- 行为：重新验证目标版本仍可运行后原子回滚。
- 风险：`write_local`；若权限与当前版本不同则重新走策略判断。

## 10. 验证链路

### 10.1 ValidationReport

```ts
interface GeneratedToolValidationReport {
  id: string
  toolId: string
  versionId: string
  artifactFingerprint: string
  startedAt: number
  finishedAt: number
  status: 'passed' | 'failed' | 'quarantined'
  checks: Array<{
    id: string
    category: 'schema' | 'build' | 'unit' | 'contract' | 'permission' | 'timeout' | 'recovery' | 'audit'
    status: 'passed' | 'failed' | 'skipped'
    evidencePath?: string
    message: string
  }>
  declaredPermissions: GeneratedToolPermissionManifest
  observedCapabilities: string[]
  logsPath: string
}
```

### 10.2 必须通过的检查

1. Manifest 和 Schema 校验。
2. 构建可复现，禁止隐式在线下载。
3. ForgeAgent 自带单元测试通过。
4. 宿主生成的正常、失败和误导性契约测试通过。
5. MCP initialize、tools/list、tools/call 和错误返回符合约定。
6. 输入 Schema 与真实运行行为一致。
7. 工作区边界、路径穿越、符号链接和大小写变体测试通过。
8. 工作区边界、路径穿越、符号链接和大小写变体测试通过；历史设计还要求"未声明网络、环境变量、子进程和写入能力均被拒绝"（Validator 的越权/权限探测在 v2 是 fail-closed 门禁，全信任实现下仍做越权探测以记录 `observedCapabilities`，但不再据此拒绝执行，见 §0）。
9. 超时、取消、崩溃和应用退出能清理进程与临时资源。
10. 审计包含 proposed、policy、started、finished 和真实结果，不泄露 secret。
11. ValidationReport 的 fingerprint 与待安装产物再次计算结果一致。

### 10.3 完成证据

JOKER 只能在以下证据同时存在时声称 Tool 已可用：

- ForgeJob 已进入 `completed`。
- ValidationReport 为 `passed`，且没有未解释的 skip。
- 产物 fingerprint 与报告一致。
- Policy Engine 返回 allow（全信任实现下对 promote/execute 恒为 allow，见 §0；历史设计中为 allow 或用户明确批准）。
- Registry 已原子切换 activeVersionId。
- 新版本能通过真实 `tools/list` 被发现。
- 最少一次 fixture `tools/call` 成功。
- ToolSet 刷新后，新 Tool 名称出现在当前 Agent 可用能力快照中。

## 11. 策略与自动化等级

### 11.1 首期策略矩阵（历史设计，已被全信任覆盖）

> **v3 注**：下表为 v2 设计的按权限 fail-closed 矩阵。当前实现不按权限/模式分级——`evaluateGeneratedToolPolicy()` 对 promote/execute 一律返回 `allow`（`workspace-full-trust-authorized`，无审批、无硬拒），见 §0。保留作为设计演进记录。

| 权限 | 建议模式 | 自动编辑模式 | 全自动模式 |
|---|---|---|---|
| 当前项目只读、无网络、无进程、无凭证 | 通过验证后自动安装 | 自动安装 | 自动安装 |
| 当前项目受限写入、可回滚 | 请求批准 | 通过验证后自动安装 | 自动安装 |
| 固定域名网络、无凭证 | 请求批准 | 请求批准或按白名单 | 按白名单自动安装 |
| 固定命令或子进程 | 请求批准 | 请求批准 | 仅允许显式策略白名单 |
| 凭证、系统目录、用户目录外写入 | 请求批准 | 请求批准 | 请求批准 |
| 发布、支付、删除、部署、通知第三方 | 禁止自动授权 | 禁止自动授权 | 必须逐次明确授权 |
| 修改 ToolForge、审批、Registry 或 JOKER 主进程 | 拒绝 | 拒绝 | 拒绝 |

### 11.2 单一可用状态

自造 Tool 不暴露互相矛盾的“信任”和“启用”独立开关：

```text
验证通过 + fingerprint 已授信 + 策略允许 → available
内容或权限变化                          → changed，并自动不可用
撤销或手动停用                          → disabled，同时撤销当前指纹授信
验证失败                                → failed；旧稳定版本继续 available
检测到越权或逃逸                        → quarantined
```

UI 中的主动作使用“启用并信任当前版本”“停用并撤销信任”“重新验证”，不出现“已启用但未信任”或“已信任但不可用且无原因”的组合。

## 12. 热加载与原任务续跑

### 12.1 capabilityRevision

新增全局或按窗口维护的单调递增能力版本：

```ts
interface CapabilityRevisionState {
  revision: number
  changedAt: number
  reason: 'tool-promoted' | 'tool-disabled' | 'tool-rolled-back' | 'mcp-refreshed'
  toolIds: string[]
}
```

### 12.2 续跑协议

当前 run 的 ToolSet 已固定，不能在同一个 `streamText` 实例中直接追加 Tool。推荐使用受控续跑：

```text
ToolForgeStart 返回 jobId
  ↓
主 run 等待或轮询 ForgeJob
  ↓
ToolPromote 成功（历史设计中运行等级为 L1 时此处先插入用户逐次批准，见 §8.2.1；全信任实现下无此插入点），capabilityRevision 增加
  ↓
当前 Agent step 写入结构化 capability-changed 结果并正常收尾
  ↓
宿主保存消息、ToolSpec、jobId 和原任务 continuation
  ↓
重新调用 buildCapabilitySnapshot() 与 buildAllTools()
  ↓
创建同一用户任务的 continuation run
  ↓
系统提示中声明新 Tool ID、用途和安装证据
  ↓
主 JOKER 必须调用新 Tool 或明确说明仍无法完成
```

### 12.3 防止重复续跑

- continuation 使用稳定 `continuationId` 和 CAS revision。
- 同一 `jobId + capabilityRevision` 只能触发一次续跑。
- 用户在制造过程中 steer 或取消时，宿主记录新的目标并阻止旧 continuation 抢占。
- 应用重启后，`interrupted` job 和待续跑记录必须显式恢复，不能静默丢失或重复执行。
- 新 Tool 安装成功但调用失败时，不自动无限重新制造；先记录真实失败并进入有限 repair 流程。

## 13. 持久化目录

建议在 JOKER_HOME 下建立独立目录：

```text
~/.joker/
├─ generated-tools/
│  ├─ registry.json
│  ├─ tools/
│  │  └─ <tool-id>/
│  │     ├─ descriptor.json
│  │     ├─ active.json
│  │     └─ versions/
│  │        └─ <version-id>/
│  │           ├─ manifest.json
│  │           ├─ source/
│  │           ├─ dist/
│  │           └─ validation-report.json
│  ├─ jobs/
│  │  └─ <job-id>/
│  │     ├─ job.json
│  │     ├─ workspace/
│  │     ├─ logs/
│  │     └─ evidence/
│  └─ quarantine/
└─ generated-tool-audit.jsonl
```

要求：

- Registry、Job 和 active pointer 使用临时文件、fsync、原子替换与备份恢复模式。
- Version 产物不可变；修改产生新 versionId。
- 删除 Tool 默认先进入可恢复回收区，清楚提示是否仍有会话或项目引用。
- 审计、源码、运行输出和验证证据分离，避免一个文件无限膨胀。
- 测试必须使用隔离 `JOKER_HOME`，不能污染真实用户配置。

## 14. 设置页与 Tool 工作台

### 14.1 信息架构

在现有 Settings 增加一级分区：`自造工具`。

```text
设置
├─ 供应商与模型
├─ 制图
├─ 自造工具
├─ MCP
└─ Skills
```

“自造工具”使用用户能理解的产品语言，不把底层 MCP Server 作为主要概念。

设置 Modal 只承担工具资产扫描与管理入口；源码、权限、测试、版本和自然语言修改属于复杂长流程，应打开独立的 `ToolWorkbench` 全屏工作区，而不是继续堆进 Modal。

### 14.2 自造工具列表

```text
自造工具                                      共 4 个

[搜索工具名称或用途……]       [状态筛选]       [让 JOKER 创建工具]

● QuerySQLite                                      可用
  读取项目内 SQLite 数据库，只允许 SELECT
  为“统计每日任务量”创建
  v3 · 项目只读 · 最近使用 12 分钟前 · 18 次调用
                                                   [查看详情]

● ExportExcel                                    验证失败
  导出统计结果为 Excel
  v2 有 2 项测试失败，当前继续使用稳定版 v1
                                                   [继续修复]
```

列表项必须显示：

- 名称、业务用途和作用域。
- 可用、制造中、验证中、失败、已停用、内容变化、已隔离状态。
- 当前稳定版本与权限摘要。
- 创建原因、最近使用时间、调用次数。
- 失败时显示原因和可执行下一步，不能只写“验证失败”。

空状态文案：

> JOKER 还没有创建自造工具。执行任务时，如果现有能力不足，它会在受控环境中制造并验证新工具。你也可以主动描述想增加的能力。

动作：`让 JOKER 创建工具`。

### 14.3 ToolWorkbench

建议分区：

- 概览：用途、来源、状态、创建任务、调用统计。
- 能力与权限：文件、网络、命令、环境变量和机密范围。
- 输入输出：Schema、示例和错误契约。
- 源码：只读默认，高级模式可编辑草稿。
- 测试：测试项、最近报告、日志和证据。
- 版本：版本 diff、稳定版本、回滚。
- 运行记录：调用时间、会话、耗时、结果摘要和错误。

详情页当前主操作依据状态变化：

| 状态 | 主操作 |
|---|---|
| available | 让 JOKER 修改 |
| building / validating | 查看制造进度 |
| failed | 继续修复 |
| changed | 重新验证并启用 |
| disabled | 启用并信任当前版本 |
| quarantined | 查看风险报告 |

危险操作放在次级区域：停用、回滚、删除。文案必须说明影响对象、当前引用、是否可恢复。

### 14.4 指向性自然语言编辑

用户点击某个 Tool 的“让 JOKER 修改”后，系统固定绑定：

```ts
interface GeneratedToolEditRequest {
  toolId: string
  baseVersionId: string
  baseFingerprint: string
  instruction: string
  requestedFrom: 'settings' | 'conversation'
}
```

输入框明确显示目标：

```text
正在修改：QuerySQLite v3

希望如何修改这个工具？
例如：增加 CSV 输出，但仍然禁止修改数据库。
```

提交后创建 `mode: edit` 的 ForgeJob 和 v4 草稿。v3 在 v4 验证、授权和原子切换完成前继续提供服务。

编辑结果必须展示：

- 用户要求的完成情况。
- Tool Schema diff。
- 权限 diff，权限扩大必须醒目标识。
- 源码和依赖 diff。
- 新增、修改、失败的测试。
- 是否已切换稳定版本；失败时旧版本是否仍可用。

### 14.5 主对话反馈

制造过程必须进入消息流和详情面板，不只是后台日志：

```text
JOKER 发现缺少 SQLite 查询能力
  → 正在查找已有工具
  → 未找到匹配工具，已启动 ToolForge
  → QuerySQLite 正在验证（7/10）
  → 验证通过，已加载 v1
  → 正在使用 QuerySQLite 继续原任务
```

成功事件提供：`查看工具`、`让 JOKER 修改`。

失败事件说明：发生了什么、是否影响原任务、旧版本是否仍可用、下一步是继续修复、改用已有 Tool 还是交还用户。

## 15. IPC 与共享类型

建议新增命名空间：

```text
generated-tool:list
generated-tool:get
generated-tool:versions
generated-tool:validation-report
generated-tool:disable
generated-tool:reenable
generated-tool:rollback
generated-tool:remove
generated-tool:reveal

tool-forge:start
tool-forge:status
tool-forge:cancel
tool-forge:resume
tool-forge:subscribe
```

Renderer 不直接传任意 artifactPath。IPC 只接受稳定 ID，主进程自行解析和校验真实路径。

Preload API 使用窄类型接口，不暴露通用文件执行能力：

```ts
window.joker.generatedTools.list()
window.joker.generatedTools.get(toolId)
window.joker.generatedTools.edit(toolId, baseVersionId, instruction)
window.joker.generatedTools.rollback(toolId, versionId)
window.joker.generatedTools.disable(toolId)
window.joker.toolForge.status(jobId)
window.joker.toolForge.cancel(jobId)
```

## 16. 代码改造地图

### 16.1 Main process

建议新增：

```text
src/main/generated-tools/
├─ types.ts
├─ store.ts
├─ registry.ts
├─ fingerprint.ts
├─ policy.ts
├─ runner.ts
├─ validator.ts
├─ forge-job-store.ts
├─ forge-agent.ts
├─ capability-revision.ts
├─ continuation.ts
└─ *.test.ts

src/main/tools/
├─ tool-search.ts
└─ tool-forge.ts

src/main/ipc/
├─ generated-tools.ts
└─ tool-forge.ts
```

修改：

- `src/main/tools/registry.ts`：扩展 source 类型、generated tool metadata 和版本审计字段。
- `src/main/tools/risk.ts`：风险由 Tool 权限清单派生，而不是未知工具一律只按名称分类。
- `src/main/tools/audit.ts`：增加 toolId、versionId、fingerprint、forgeJobId 和 capabilityRevision。
- `src/main/tools/mcp-bridge.ts`：区分外部 MCP 与 JOKER generated MCP，并绑定版本。
- `src/main/mcp/client.ts`：复用连接能力，但 Generated Tool lifecycle 由专用 Registry 管理。
- `src/main/agent/capabilities.ts`：加入 Generated Tool 摘要、token 预算和精确 allowlist。
- `src/main/agent/execution-contract.ts`：能力缺口存在时允许进入 ToolForge 契约，但不能把“正在制造”当作原任务完成。
- `src/main/agent/loop.ts`：识别 capability-changed 终止原因和 continuation。
- `src/main/stream.ts`：构建 Generated Tool definitions，保存并恢复 continuation run。
- `src/main/store/sessions.ts`：记录 Forge 事件、continuation 和稳定 Tool 引用。
- `src/main/index.ts`：注册 IPC、恢复 Registry、清理 Runner 和中断任务。

### 16.2 Shared 与 Preload

- `src/shared/types.ts`：增加 ToolSpec、ForgeJob、GeneratedTool、ToolVersion、ValidationReport、权限和流事件类型。
- `src/preload/index.ts`：增加 generatedTools 与 toolForge 的窄 IPC bridge。

### 16.3 Renderer

建议新增：

```text
src/renderer/src/components/generated-tools/
├─ GeneratedToolsSettings.tsx
├─ GeneratedToolListItem.tsx
├─ ToolWorkbench.tsx
├─ ToolOverview.tsx
├─ ToolPermissions.tsx
├─ ToolSchema.tsx
├─ ToolSource.tsx
├─ ToolValidation.tsx
├─ ToolVersions.tsx
├─ ToolRuns.tsx
├─ ToolEditComposer.tsx
└─ ForgeProgress.tsx
```

修改：

- `src/renderer/src/components/SettingsModal.tsx`：增加“自造工具”分区和工作台入口，不在 Modal 内承载完整源码编辑。
- `src/renderer/src/components/MessageStream.tsx`：展示 ToolForge 生命周期事件。
- `src/renderer/src/components/DetailPanel.tsx`：展示当前 ForgeJob、验证、权限和续跑状态。
- `src/renderer/src/store.ts`：增加 generated tool inventory、active job 和订阅状态。
- `src/renderer/src/i18n.ts`：补齐中文优先的状态、错误、恢复和危险操作文案。

## 17. 分阶段实施

### P0：契约、运行时 Spike 与 Fixture

目标：在不改变正式 Agent 行为的前提下，证明安全运行和持久化方案可行。

- 冻结 ToolSpec、ForgeJob、PermissionManifest、ValidationReport 和状态机。
- 建立隔离 `JOKER_HOME` fixture。
- 对候选 Tool Runner 做越权、超时、取消、进程清理和打包资格验证。
- 建立一个固定的只读示例 Tool，例如读取 fixture JSON 并统计字段。
- 输出 runtime qualification 报告。

退出条件（历史设计）：产出 §8.2.1 定义的资格矩阵（候选 Runner × 开发/打包环境 × 关键隔离用例），并据矩阵冻结运行等级（L2/L1/L0），资格报告持久化入库。等级为 L0 时，后续阶段只交付草稿与验证能力，不进入自动执行；L1 时后续阶段自动执行替换为逐次批准。（**v3 注**：该资格门禁已被全信任实现取代，见 §0；P0 阶段当前只需产出 qualification 报告作为证据，不决定授权。）

### P1：Generated Tool Registry 与只读管理 UI

目标：先稳定领域、持久化和状态，再接制造流程。

- 实现 Tool/Version/Job/Report store 和原子恢复。
- 实现 fingerprint、状态派生和版本回滚。
- 把固定 fixture Tool 通过 generated MCP bridge 暴露给 ToolSet。
- 设置新增“自造工具”列表与只读 ToolWorkbench。
- 展示 empty、loading、available、failed、changed、disabled、quarantined。

退出条件：重启后工具、版本、状态和验证报告一致；changed 自动不可用；UI 能解释所有不可用原因。

### P2：ForgeAgent 与确定性 Validator

目标：JOKER 能自动制造低风险、项目只读 Tool 草稿。

- 新增 ForgeAgent 专用运行入口和 job 目录工具。
- 新增 ToolSearch、ToolForgeStart、Status、Cancel。
- 使用内置模板与零在线依赖策略。
- Validator 覆盖 schema、build、unit、MCP、权限、超时、恢复和审计。
- 失败报告结构化反馈给 ForgeAgent，最多有限修复轮次。

退出条件：正常、明确失败、假成功、越权和中途中断五类用例均能得出真实状态并恢复。

### P3：策略授权、Promote 与热加载续跑

目标：制造完成后自动安装并继续原任务。

- 实现 Policy Engine 和首期策略矩阵。
- 实现 ToolPromote、capabilityRevision 和 ToolSet 重建。
- 实现 continuation 持久化、CAS、防重复和重启恢复。
- 主对话展示完整制造阶段和新 Tool 调用证据。
- 执行契约要求：Tool 安装成功后，原任务不能以纯文本宣告完成，必须调用新 Tool 或报告具体阻塞。

退出条件：从用户任务开始，真实经过缺口识别、制造、验证、安装、刷新、新 Tool 调用和用户结果反馈，无需用户重新发送消息。

### P4：定向编辑、版本 Diff 与回滚

目标：用户能在设置中选定 Tool 并让 JOKER 修改。

- ToolWorkbench 增加自然语言编辑入口。
- 编辑请求绑定 toolId、baseVersionId 和 fingerprint。
- 修改永远生成新草稿；旧稳定版本继续服务。
- 展示 Schema、权限、源码、依赖和测试 diff。
- 实现重新验证、切换和回滚。

退出条件：修改成功原子切换；修改失败旧版继续可用；权限扩大不会静默通过。

### P5：更高权限与可靠性晋级

目标：在低风险工具积累真实可靠性后，逐步支持受控写入、固定域名网络和命令能力。

- 按 Tool 和权限类型统计成功率、回滚率、越权阻断和人工干预率。
- 仅对通过长期资格验证的能力提升自动化等级。
- 加入可选 AuditAgent，但不替代 Validator。
- 增加导入、导出、迁移和 Tool SDK 版本兼容策略。

## 18. 测试与验收矩阵

### 18.1 单元测试

- ToolSpec、manifest、权限和 IPC 输入校验。
- 路径规范化、workspace 边界、符号链接和大小写处理。
- fingerprint 稳定性与内容变化检测。
- Tool availability 派生，不产生矛盾状态。
- ForgeJob 状态转换、CAS、预算和停止条件。
- Policy Engine 对所有风险组合的 allow/ask/deny。
- capabilityRevision 和 continuation 去重。
- 审计脱敏与 secret key 变体。

### 18.2 本地集成测试

- 真实本地 Tool Runner + MCP stdio fixture。
- tools/list 与 tools/call Schema 保真。
- 工作区外读取、未授权写入、未授权网络、环境变量和子进程全部失败。
- 工具超时、取消、崩溃、重连和进程树清理。
- ForgeAgent 制造固定只读 Tool，Validator 独立通过。
- ForgeAgent 返回假“已通过”但 Validator 失败时不能 Promote。
- Promote 后 ToolSet 重建并真实调用新 Tool。
- 应用重启后恢复 completed、failed、interrupted job。

### 18.3 Electron 真实链路

至少验证：

1. 用户提出一个现有 Tool 无法完成、但首期 Tool SDK 能支持的项目只读任务。
2. JOKER 明确触发 ToolSearch 与 ToolForge，而不是聊天解释做法。
3. 设置页实时出现“制造中”的 Tool 和阶段。
4. 验证通过后状态变为可用，权限摘要与真实 manifest 一致。
5. 原会话自动续跑并真实调用新 Tool。
6. 用户从对话事件进入 ToolWorkbench。
7. 用户定向要求修改，系统绑定正确 Tool 和稳定版本。
8. 修改失败时旧稳定版本仍能完成原调用。
9. 权限变化后 Tool 自动不可用，并显示重新验证方式。
10. 回滚后 ToolSet 和 UI 同步到目标版本。

页面能打开、列表存在、ForgeAgent 声称成功、文件已生成或 MCP 能连接，都不能单独作为验收完成证据。

### 18.4 必备失败用例

- Tool 重复制造：ToolSearch 应命中已有能力。
- 同名 Tool：使用稳定 ID，不按显示名定向编辑。
- ForgeAgent 超预算：任务停止并保留可恢复状态。
- Validator 日志缺失：禁止 Promote。
- fingerprint 在验证后变化：禁止 Promote。
- 工具试图读取工作区外文件：拒绝并隔离。
- 用户在制造时取消：停止运行，原任务不宣称完成。
- 两个会话同时修改同一 Tool：后提交者检测 stale baseVersion。
- 应用在 promoting 中退出：重启后只能恢复到旧稳定版或完整新版本，不能半切换。
- 新 Tool 安装成功但调用失败：记录真实错误，不无限生成新版本。

## 19. 可观测指标

- 能力缺口识别次数与 ToolSearch 命中率。
- ForgeJob 创建、完成、失败、取消和中断数量。
- 首次验证通过率、平均修复轮次和制造耗时。
- 权限越界阻断、隔离和人工批准次数。
- Tool 安装后首次真实调用成功率。
- continuation 成功、重复阻断和恢复次数。
- Tool 调用成功率、P50/P95 耗时、超时和崩溃率。
- 版本回滚率、修改失败时旧版保留率。
- 用户主动修改、停用、删除和导出次数。
- 生成 Tool Schema 带来的上下文 token 增量；工具过多时应渐进发现，不能全部永久注入。

指标只能辅助判断，不能用“生成数量”或“测试通过率”替代真实用户任务完成率。

## 20. 主要风险与应对

| 风险 | 影响 | 应对（v3 按全信任实现更新） |
|---|---|---|
| 生成代码逃逸 | 获得用户级系统权限 | **v3**：全信任模型下生成代码本就以当前用户权限运行（见 §0），"逃逸"不再是授权边界概念；真实威胁变为"生成代码引发非预期外部副作用"。应对：Validator 越权/路径探测、超时/进程树清理、审计留痕、内容变化自动失效与回滚、Agent 提示词约束。 |
| 资格门禁导致长期 L0/L1 | Vertical Slice 无法闭环，用户误以为"制造中=即将可用" | **v3**：分级门禁已移除，不再有 L0/L1 阻塞；该风险不适用（见 §0）。 |
| ForgeAgent 自证成功 | 假完成、错误安装 | 独立 Validator、宿主 fingerprint 和真实 fixture call |
| 工具越造越多 | Tool schema 膨胀、模型选择变差 | ToolSearch、项目作用域、使用统计、渐进式工具发现 |
| 修改破坏稳定版本 | 正在运行的任务失败 | 不可变版本、草稿验证、原子 Promote、自动回滚 |
| 无限修复循环 | 成本与等待失控 | 轮次、时间、文件、体积预算和重复失败停止 |
| 权限描述不真实 | 用户被误导 | manifest 与运行时 observed capability 对比 |
| 续跑重复 | 重复写入或外部副作用 | continuationId、CAS、幂等和 revision fence |
| 多会话并发编辑 | 覆盖他人版本 | baseVersion/fingerprint 乐观并发控制 |
| 配置污染 | 测试改变真实用户环境 | 所有测试使用隔离 JOKER_HOME |
| UI 只展示技术状态 | 用户看不懂影响 | 业务用途、权限范围、失败原因和恢复动作优先 |

## 21. 首个可交付 Vertical Slice

首个端到端样例建议选择“读取项目内固定格式 JSON/CSV 并输出统计”，而不是一开始做 Bash、网络或任意依赖安装。

验收任务示例：

> 统计当前项目 `fixtures/tasks.json` 中各状态的任务数量，并按数量排序。

预期链路：

1. 当前没有专用统计 Tool。
2. ToolSearch 返回无匹配。
3. JOKER 生成只读 ToolSpec。
4. ForgeAgent 创建 `SummarizeTaskJson` Tool。
5. Validator 验证路径边界、JSON 错误、空数组、大文件限制和输出 Schema。
6. Policy Engine 因“项目只读、无网络、无进程、无凭证”自动允许。
7. ToolPromote 安装 v1，capabilityRevision 增加。
8. 同一任务自动续跑并调用 `SummarizeTaskJson`。
9. 用户看到真实统计结果，以及“查看工具”“让 JOKER 修改”。
10. 设置中能查看用途、权限、验证报告、版本和调用记录。

以上链路以当前全信任实现为基准（见 §0），不区分运行等级：Validator 独立验收 → Policy Engine 恒 allow（无审批）→ ToolPromote → 自动续跑并调用。历史设计中的 L1"用户逐次批准"与 L0"不可执行"验收变体已不适用于当前实现，保留在 §0 作为演进记录。

这个 Vertical Slice 完成后，才能证明 JOKER 不是“会写一份工具代码”，而是真的完成了“能力缺口 → 自主制造 → 独立验收 → 热加载 → 使用 → 管理”的闭环。

## 22. 推荐实施顺序

1. 先完成 Registry、版本、指纹、持久化和只读 UI，确保状态可信（历史设计曾要求先做 P0 Runner 资格矩阵并按 §8.2.1 冻结运行等级，该门禁已被全信任实现取代，见 §0）。
2. 再完成 Registry、版本、指纹、持久化和只读 UI，确保状态可信。
3. 再实现 ForgeAgent 与 Validator，保持普通 subagent 只读边界不变。
4. 再实现策略、Promote、capabilityRevision 与 continuation。
5. 完成首个项目只读 Vertical Slice 的真实 Electron 验收。
6. 最后实现自然语言定向编辑、版本 diff 和回滚。
7. 只有低风险链路稳定后，才评估写入、网络、命令和凭证能力。

## 23. 最终完成定义

本计划不能因为新增了 ToolForge 按钮、生成了文件、MCP 能连接或页面能展示 Tool 就标记完成。以下完成定义以当前全信任实现为基准（见 §0），不区分运行等级：

- 主 JOKER 能在真实任务中发现能力缺口并调用 ToolForge 元工具。
- ForgeAgent 只在隔离 job 环境制造 Tool。
- Validator 独立验证行为、权限、失败和恢复。
- 低风险 Tool 可按策略自动 Promote。
- 新 Tool 不重启应用即可进入新的 ToolSet。
- 原用户任务自动续跑并真实调用新 Tool。
- 对话和设置都能解释 Tool 的用途、状态、权限和证据。
- 用户能选中确定 Tool 进行自然语言修改。
- 修改失败保留旧稳定版本；权限或内容变化自动失效。
- 支持停用、重新验证、回滚、删除和重启恢复。
- 越权、假成功、重复续跑、并发修改和半切换场景都有确定性测试证据。

