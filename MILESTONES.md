# JOKER 里程碑

更新时间：2026-08-16

## M10：拖放附件、Lightbox 缩放与轮级产出文件（DSH ui-attachment/ui-deliverables 对标，2026-08-16）

D 档三块，全部通过真实 Electron 验收（`npm run test:e2e:electron:ui-d`，`scripts/electron-ui-d-slice-smoke.mjs`，13 项检查 + 截图）：

**D1. 整窗图片拖放（DropOverlay）**
- document 级 dragenter/over/leave/drop（深度计数防抖动），拖文件悬停时全屏 portal 浮层（active/blocked 两态，research 模式显示禁用态）；松手走 composer 统一的图片 ingest 链（校验/缩放/base64 全复用粘贴路径）。
- InputBox 提炼 `ingestImageFiles` 供粘贴与拖放共用，handle 暴露 `ingestFiles`；research 模式拖放同样拒绝。

**D2. Lightbox 缩放**
- 既有全屏预览升级：滚轮缩放（100%–800%）、+/- 按钮、百分比读数、重置、放大后拖拽平移（pointer capture）、Esc 关闭不变。

**D3. 轮级产出文件（ProducedFiles，对标 DSH ProducedFiles 的 Turn 语义）**
- 每条 assistant 消息尾部渲染"本轮产出"文件 chips：聚合该轮（上一条 user 之后的所有 assistant 消息）Write/Edit 成功调用的去重路径，点击经 `file.reveal` 打开位置。
- 关键实现：多步 run 中工具调用分布在 step 消息而总结在 final 消息——按"轮"而非按"消息"聚合才能对齐 DSH 的 Turn 语义。

验证：ui-d smoke 13/13（chips 双文件、拖放浮层+附件轨、缩放 100→140→重置、Esc、带图消息发送后在会话流渲染）；electron-smoke、runtime-contract、ui-ab、ui-c 全部 exit 0；lint / typecheck / 680 单测通过。

## M9：时间线视图与结构化提问（DSH Trajectory/QuestionComposer 对标，2026-08-16）

C 档两块，全部通过真实 Electron 验收（`npm run test:e2e:electron:ui-c`，`scripts/electron-ui-c-slice-smoke.mjs`，15 项检查 + 截图）：

**C1. 会话时间线（minimap 升级为耗时比例时间块）**
- `ChatMessage.durationMs` 打通持久化链：loop snapshot 记录 wall-clock → assistant 消息落盘（chat + goal 两条路径）。
- minimap 条目按各轮真实耗时比例布局（上限 40% 防单轮占满；无耗时会话回退等高线）；tooltip/aria 增加"耗时 + 工具调用次数"（排除 detail-only 与内部 ToolForge 工具）。
- 修复一个潜伏缺陷：minimap 的 ResizeObserver 绑定 effect 依赖缺失，首帧 return null 后 trackRef 永不挂载 → trackHeight 永 0 → minimap 从不显示条目。实测验收前该组件在真实窗口从未工作过。

**C2. AskUserQuestion 结构化提问工具（模型 → 用户 → 模型全链路）**
- 新 builtin 工具 `AskUserQuestion`（risk: read 免审批）：模型可发起 带标题/多选/选项描述/自由输入 的结构化提问。
- 独立 `user-question` IPC 通道（pending 表 + 窗口推送 + 24h 超时 + run abort 自动取消），复用审批的窗口归属语义但答案承载结构化 payload（selectedIds + freeText + cancelled）。
- UserQuestionPanel 弹窗卡片：选项按下态、多选切换、自由输入、跳过；答案作为工具结果回填模型继续生成（dismissed 有独立文案路径）。
- 验收实测：选项选择→aria-pressed→提交→工具结果含 'Fast mode' 回到第二个模型请求→模型回答引用选择；跳过路径同样闭环；无 console/page error。

验证：ui-c smoke 15/15、electron-smoke（含 goal 两轮）、runtime-contract、ui-slice、ui-ab 全部 exit 0；lint / typecheck / 680 单测（新增 minimap 布局 3 项）通过。

## M8：Token 账本与侧栏分组（借鉴 DSH Trajectory/Workspace，2026-08-14）

A、B 两档改动，全部通过真实 Electron 验收（`npm run test:e2e:electron:ui-ab`，`scripts/electron-ui-ab-slice-smoke.mjs`，19 项检查 + 截图）：

**A. Token 计算器（DetailPanel 双列账本，对标 DSH TrajectoryTable 的 This request / Session cumulative）**
- `StreamUsage` 新增 `firstTokenMs` / `generationMs`；loop 在首个 text-delta 记 TTFT 起点，message-end 时把计时并入最终 usage。
- step 消息持久化时写入 step usage；最终 run usage（含计时）通过 `mergeFinalUsageIntoLastAssistant` merge 进最后一条 assistant 消息 —— 修复"持久化消息无 usage、重开会话账本为空"的数据链缺口。
- DetailPanel 渲染：本次 / 会话累计 双列 ×（总输入、缓存命中、缓存写入、未缓存输入、总输出、Token 总计、模型调用、首字延迟、吞吐 tok/s）+ 运行计数。实测（fake provider 回报 prompt 520 / cached 300）：账本逐项精确一致，TTFT 66ms，吞吐 2000 tok/s。
- Goal 集成：`USAGE_KEYS` 白名单纳入计时键；`addGoalUsage` 对 firstTokenMs 取 min、generationMs 累加 —— 修复计时字段导致 goal execution commit 被 `isValidStreamUsage` 拒绝、goal 永卡 executing 的回归（electron-smoke goal 两轮全绿复验）。

**B. 侧栏项目分组 + 搜索（对标 DSH Workspace tree）**
- 按 `session.projectId` 分组渲染项目头（可折叠、带计数），未绑定会话排末尾；标题实时过滤 + 无结果提示 + 清除按钮。
- 修复两个真实缺陷：`session:create` 与 `session:set-project` IPC 此前不推送 `summary-changed`——preload/外部创建的会话与项目绑定不会出现在任何已开窗口的侧栏。

验证：ui-ab smoke 19/19（账本数值断言、分组互斥、折叠、搜索过滤、无 console/page error）、electron-smoke（goal 流程）、runtime-contract 全部 exit 0；lint / typecheck / 677 单测通过。

## M7：界面重排第一切片（2026-08-14）

注意力层级驱动的三处改动，全部通过真实 Electron 验收（`npm run test:e2e:electron:ui-slice`，`scripts/electron-ui-slice-smoke.mjs`）：

- **阅读宽度上限**：会话流 `max-w-3xl` 居中，1800px 宽窗实测内容列 768px，composer 同宽对齐；修复宽屏一行 markdown 拉满 2400px+ 的可读性缺陷。
- **输入区瘦身**：project 选择器 + Git 徽章收进 composer 顶沿一条 ~20px 紧凑行（原来独立占一整行）；审批三态从常驻控制行移入 provider 弹出菜单尾部分隔区；控制行只剩 运行模式 | context | reasoning | provider。
- **冷启动空态**：从一行灰字升级为 logo + 欢迎语 + 当前 provider 名 + 选工作文件夹 CTA（未绑定时）+ 三个可点击示例 prompt（点击直接填入输入框）+ `/` `+` 命令提示。
- 配套：`i18n` 新增 approval.mode.label 与 welcome.* 双语键；App 监听 `joker:welcome-insert` / `joker:welcome-pick-folder` 自定义事件（沿用 generated-tools workbench 的事件模式）。

验证：ui-slice smoke 10/10（含 boundingBox 几何断言与 popover 可达性）、electron-smoke 全绿无回归、lint/typecheck/i18n 测试通过。

## M1：应用骨架与流式聊天 — 已完成

- Electron + React + TypeScript 三栏桌面应用
- MessageChannel/MessagePort 流式消息
- Provider/model 运行时选择
- 基础错误与中止处理

## M2：工具系统与审批 — 已实现，关键链路已测试

- Read、Write、Edit、Bash、Grep、Glob、TodoWrite、Agent 工具
- 工具执行前审批 gate
- 审批允许/拒绝及超时
- 工具调用卡片和文件 diff 展示
- 工具上下文已携带真实 `sessionId`

## M3：多 Provider、MCP 与子 Agent — 已实现，运行覆盖仍有限

- 多 Provider 配置和模型管理
- MCP 工具发现与桥接
- 子 Agent 并发执行
- Provider 辅助函数有单元测试
- 真实外部 Provider、MCP 连接和子 Agent 端到端验证尚未纳入自动化门禁

## M4：会话持久化、上下文压缩与发行 — 部分完成

已完成：

- JSON 文件会话存储
- 会话创建、加载、切换、重命名、删除
- 侧栏真实会话列表
- 用户消息和 assistant 消息持久化
- `sessionId` 从 renderer → stream → Agent → ToolContext/Todo/审批事件贯通
- 模型级最大上下文 Token 配置
- 自动压缩始终启用，仅按估算 Token 接近模型上限时触发
- 压缩失败保留原始上下文，避免静默丢失历史
- DetailPanel 已移除固定目标、78% 进度、计划和进程演示数据
- 聊天区域显示本次请求的输入/输出/总 token 与缓存读取 token，assistant 消息持久化 usage
- 思考等级支持自动/关闭/低/中/高，Ctrl+T 循环切换，并通过 Agent 请求的统一 reasoning 参数传递
- 输入区常驻底部，审批模式和思考等级使用图标控件
- 支持剪贴板图片粘贴、预览、JSON base64 持久化和 AI SDK 多模态转换
- 输入缩略图使用 `object-cover`，消息图片使用 `object-contain`，支持点击打开预览；超大 GIF 缩放为静态 PNG
- M4 的会话存储已具备版本化 envelope、临时文件 + 备份恢复、内容校验和单进程内 per-session 写入锁；`fsync` 在当前 Windows 文件系统上采用 best-effort，不宣称跨平台绝对持久性。
- 审批请求按 `windowId + sessionId + runId` 隔离，窗口/会话/运行取消会拒绝待处理审批；多窗口真实运行仍需单独验收。
- Skill/MCP 能力采用最小权限边界：Skill 显式启用且只注入可信指令；存在 Skill 约束时 MCP 只允许精确 allowlist，空 allowlist 不授予工具；外部 Skill 源只读。
- 子 Agent 只接收 Read/Grep/Glob/Git 只读工具，禁止写文件、Bash、WebRead/WebSearch、图片工具和 MCP。
- `electron-builder.yml` 将 `src/image/logo.ico` 作为 Windows installer icon，并复制为 packaged app 的 `resources/logo.ico`，与 `src/main/index.ts` 的 packaged runtime icon 路径一致；`npm run build:dist` 先构建 `out/` 再调用 electron-builder。Windows v0.1.0 → v0.1.1 覆盖安装、启动、配置/session 保留和卸载后用户数据保留已在隔离目录完成真实验证，证据见 `release-verification.md`。v0.1.1 使用未签名构建，因为当前环境没有签名凭据；默认资源编辑在本机的 unsigned `rcedit` 路径失败，验证构建显式关闭 `signAndEditExecutable`。

- MCP 配置纳入 `~/.joker/config.json`，支持启动恢复和退出断开
- MCP stdio/HTTP 连接状态、错误状态、重连和工具数量展示
- MCP 工具使用稳定 server ID 命名并保留基础 JSON Schema
- MCP 工具结果限制长度并保留错误/非文本内容摘要
- MCP 工具继续经过统一审批 gate
- 受信任 Markdown Skill 发现、解析和显式启用/停用，包含 `C:\Users\ecgoi\.agents\skills\` 的只读外部 Skill 来源
- 外部 Skill 兼容 BOM/CRLF 和缺失 `id`（使用目录名作为稳定 ID），停用不会修改或删除源文件
- Skill 指令注入 Agent 请求上下文
- WebRead 内置网页读取工具：HTTP fetch 优先，JavaScript 页面使用隔离浏览器渲染兜底
- WebRead 仅允许公开 HTTP/HTTPS，限制 SSRF、超时、响应大小、重定向和输出长度
- WebRead 不携带登录 Cookie 或任意请求头，网页内容按不可信资料处理
- 独立 text-to-image Provider 配置，支持多个 OpenAI Images / Grok-compatible 制图供应商和当前制图供应商选择
- 制图供应商独立保存于 `~/.joker/image-provider.json`，不进入聊天 Provider 类型或聊天模型菜单
- GenerateImage 使用审批 gate、安全图片落盘和 ToolCard 本地预览

待完成或验证：

- 真实 Electron 双窗口审批归属、关闭取消：已通过 `npm run test:e2e:electron:approval`；Settings → MCP/Skill → restart → tool-call 闭环也已在同一隔离 harness 中通过。
- 外部 MCP 进程的产品级命令信任、权限和异常回收策略：manager-driven 本地 qualification 已通过 `npm run test:qualification:mcp`（15/15）；真实 Electron Settings UI 的 Trust/Revoke、Allow/Deny、Reconnect、重启持久化闭环已通过 `npm run test:e2e:electron:mcp-settings`（11/11）。该证据仅覆盖本地 loopback/stdio fixture，不等同于外部生产 MCP soak；native runner、真实凭据和长期运行边界仍单独审计
- WebRead 在真实 Chrome/Edge 中的动态页面 fallback 和浏览器 request guard：已通过条件式本地 loopback contract；无可执行浏览器时显式 skip，默认 CI 不提供真实浏览器门禁
- MessagePort 应用层 bounded backpressure：已接入 ACK/credit、32-event high-water mark、3-event terminal reserve、pending + in-flight queue-depth、blocked/resumed/drain telemetry；普通与 `--strict` qualification 均已通过
- 长时间 Electron stream、长会话恢复和多窗口压力验证
- 真实跨进程 session 写并发：已新增 `npm run test:qualification:session-concurrency`；最新独立 4 进程 × 30 轮的隔离实测通过（120 acknowledged、最终 120 条、0 条缺失），并检查 primary/backup envelope、`.tmp` 和 `.lock` 残留；当前 session mutation 已使用跨进程 per-session 事务锁。该证据不扩展到 config/project/image store，也不解决 stale full-snapshot replace 的冲突策略
- macOS/Linux 原生发行包安装与启动：Linux qualification 已在隔离 Ubuntu 22.04 WSL2 runner 上真实执行，`.qa/native-linux-wsl-20260729/native-package-report.json` 为 `pass: 13`、`fail: 0`、`skip: 0`、`not-verified: 0`，覆盖 AppImage/deb 安装、启动、session 创建、重启恢复、卸载和清理；workflow 也已在 native job 中使用 `xvfb-run`。当前没有 hosted GitHub Actions artifact 可检查，macOS runner 仍未执行，不能把 Linux WSL 证据扩展为 macOS 或 hosted CI 证据
- 正式发行签名：已准备 fail-closed sign+verify workflow；签名 secrets 已从 job-level env 收敛到导入/qualification 步骤，报告仍只记录 secret 名称和 `secretValuesLogged=false`。当前无 CSC/GPG/Apple 凭据，`npm run test:qualification:signed-release` 最新真实结果为 `signed.credentials.present=fail`、`secretValuesLogged=false` 和 exit 1，未形成正式签名 pass 证据


- 完成会话前端闭环
- 贯通真实 sessionId
- DetailPanel 改为真实运行状态
- 增加 Todo、工具上下文和 renderer store 测试
- 同步 README 与里程碑文档

## 明确不做

Provider 类型选择功能不在本次范围内，按用户要求取消，后续也不作为本项目计划项。现有 Settings/Provider 类型实现保持不变。

## 工程化验证边界（P2）

- `npm run lint` 仅提供仓库内置的最小源码卫生检查，不虚称替代 ESLint/Prettier 等完整风格工具。
- `npm run test:unit` 运行本地确定性单元测试；当前 Windows runner 已纳入 session store、generated-image 和 WebRead 单元/契约测试，fsync 失败按 best-effort 处理并通过确定性的临时文件、备份恢复断言覆盖。`npm run test:integration` 运行 Provider loopback fake-server、MCP stdio/HTTP wire contract、WebRead loopback、审批和 capability 合约测试，不调用真实 Provider、MCP 或其他外部服务。
- `npm run test:coverage` 使用 Node 内置实验性覆盖率能力，打印真实覆盖率表并写入 `coverage/test-manifest.json`，记录实际测试集合和排除项；当前 manifest 的 `excludedTestFiles` 为空，不把 Windows/Node 24 的既有排除项当作现状。
- `.github/workflows/ci.yml` 在当前 Windows runner 上执行 `npm ci`、`typecheck`、lint、脚本语法检查、单元测试、确定性 integration、coverage 和 `build`，并上传 coverage 与 `out/` artifact；不启动 Electron，不提供真实凭据，也不调用真实 Provider/MCP。（注：README/MILESTONES 旧文曾称"Ubuntu 和 Windows"，实际 ci.yml 当前只有单个 Windows `verify` job；Linux 原生证据仍是隔离 WSL2 本地证据，见 M4。）
- `npm run test:e2e:electron` 是 opt-in 的本地 Windows Electron harness：在隔离 `JOKER_HOME` 和 Electron user-data 目录中启动 fake Provider，使用 CDP 验证 renderer/preload、配置保存、会话创建、关闭后重启恢复，并输出截图与 JSON report。
- `npm run test:e2e:electron:approval` 是 opt-in 的双窗口审批 harness：通过测试专用 `JOKER_E2E_MULTIWINDOW=1` 启动两个真实主窗口，验证两个 renderer 的审批请求包含不同 `windowId`、跨窗口响应被拒绝、自窗口响应成功，以及关闭窗口后其 pending approval 被取消并回传拒绝结果。
- `npm run test:qualification:stream` 是 opt-in 的 Windows Electron MessagePort qualification harness：已用真实 transferred MessagePort、512 chunks × 2 burst、2ms 慢消费者和中途 abort 运行通过；现已验证应用层 ACK/credit bounded window：`highWaterMark: 32`、`terminalReserve: 3`，pending + in-flight queue depth 不超过 HWM，ACK 计数完全对账，blocked/resumed/drain 均被观测，最终 queue depth 为 0 且无 late event；普通模式与 `--strict` 均通过。该证据按事件 envelope 数量计，不等于 Electron 内部字节级队列或生产 SLA。
- 真实浏览器 WebRead contract 依赖本机 Chrome/Edge；缺少可执行文件时仅显式 skip，不作为默认 CI 浏览器门禁。Ubuntu CI 的 Electron bundle build 不等于 Linux 原生包安装/启动，electron-builder 的 macOS/Linux target 配置也不构成对应平台验收。

## M5：ToolForge 自造工具与热加载 — 已实现（全信任运行时，2026-08）

已完成：

- 能力缺口发现（ToolSearch）、ForgeAgent 独立制造、宿主 Validator 独立验收、ToolPromote、capabilityRevision 热加载与原任务自动续跑闭环。
- “设置 → 自造工具”管理页：版本、验证证据、运行状态、定向自然语言编辑、回滚/停用/删除/重启恢复。
- Generated Tool 在独立 Node 子进程（`fork`）运行，不载入 Electron 主进程地址空间。

安全模型决策（2026-08-14 确认维持）：

- 采用 **`user-owned-full-trust-v1` 全信任运行时**：生成代码以当前桌面用户账户权限执行，子进程只隔离取消语义，**不是能力或策略边界**；`policy.ts` 对 promote/execute 一律返回 `allow`（`workspace-full-trust-authorized`），无审批门、无权限门。
- 原计划中的分级资格门禁（L0/L1/L2）与按权限 fail-closed 策略矩阵**不再参与授权决策**（代码保留机制但策略硬编码 L2 且全信任放行）；`TOOL-FORGE-PLAN.md` 已修订为 v3 并标注历史设计段落。
- 仍然生效的防护：ForgeAgent 无自证权（宿主 Validator 独立事实验收：编译/测试/越权与路径探测/超时/取消/进程树清理/审计），生成代码无法调用 JOKER IPC、改 Registry 或写审计文件，内容或权限变化自动失效并可回滚。
- 产品/Agent 层约束（非运行时强制）：不允许修改宿主/审批/Registry/ToolForge 实现、自动读取系统凭证/Cookie/SSH Key、或执行发布/支付/删除生产数据等不可逆操作。

未纳入验证门禁（沿用 M3/M4 边界）：

- 真实外部 Provider/MCP/网络调用不纳入自动化门禁；Generated Tool 的真实 Electron UI 全链路（制造→调用→ToolCard→终态）验收以 opt-in smoke/qualification 脚本为准。

## M6：运行时可靠性改进（2026-08，借鉴 DeepSeek Harness 语义）

已完成：

- **文件乐观并发**：`Read` 返回 SHA-256 `version`；`Edit`/`Write` 支持可选 `expectedVersion`（不匹配即拒绝并提示重新 Read）；`Write` 对已存在文件做版本 CAS、对不存在文件 create-if-absent；不传版本时保持原覆盖行为。
- **Timeout/cancel quiescence**：`executeToolDefinition` 不再 `Promise.race` 后抛弃工具 promise——超时/取消发出 abort 后在默认 5s（`quiescenceGraceMs` 可配）grace 内等待工具真正 settle，再以 timed-out/cancelled 终态返回；grace 超时强返回时明确该工具可能仍在收尾。
- **Operation journal 与恢复语义**：每个 run 写旁路 `<sessionId>.operations.jsonl`（request-prepared/dispatched、tool-proposed、approval-asked/decided、tool-started/result、step-committed、run-terminal），`tool-started` 在工具 body 之前落盘。重启时对未记录 `run-terminal` 的 run 分类：`TOOL_NOT_STARTED`（可安全重发）与 `TOOL_OUTCOME_UNKNOWN`（副作用可能已发生，绝不自动重试，注入下一次请求的恢复提示）。
- **单调 guard 链**：`ToolContext.guards` 在审批 allow 之后、执行边界收紧（只能 deny，不能重新放行）；Generated Tool 挂 `generatedToolExecutionGuard`，在最终执行边界重新验证 fingerprint、pointer/capability revision、active version（workspace trust 授权由已确认的全信任 policy 表达，guard 不做矛盾重查）；`assertSnapshotStillExecutable` 同步补强 fingerprint/capabilityRevision 快照比对。
- **确定性测试补强**：operation journal 因果顺序契约（tool-started 早于 body）、quiescence settle 证据、guard 单调性、request reconstruction（模型可见消息 = 日志消息 + 工具结果重建）、torn-tail 崩溃容忍与 unknown-outcome 分类。

验证状态：lint/typecheck 通过；单测 677/677；真实 Electron smoke 在改动后于本机运行（见验收记录）。真实外部 Provider/MCP 链路不纳入自动化门禁（沿用 M3/M4 边界）。

### M6 补充验收（运行时契约真实链路，2026-08-14）

新增 `npm run test:e2e:electron:runtime-contract`（`scripts/electron-runtime-contract-smoke.mjs`），两段真实 Electron + fake provider 驱动：

- **fs-optimistic-concurrency 相位**：真实会话驱动 Read → 带 stale `expectedVersion` 的 Write（被拒，报 `expectedVersion mismatch` 并提示重读）→ 重 Read → 带新鲜 digest 的 Edit（成功）；workspace 文件最终是编辑后内容而非碰撞覆盖；聊天渲染工具工作流；无 console/page error。
- **invoke-fallback 相位**：纯文本描述工具（"invoke TodoWrite with todos is ..."）经 fallback 真实执行 TodoWrite 与 Read，工具结果进入后续模型请求；会话 JSON 持久化工具调用（TodoWrite:done、Read:done）；UI 可见；无 console/page error。
- 该 smoke 首跑暴露并修复一个真实缺陷：invoke-fallback 在 `onStepEnd` 之后执行，`abort()+continue` 绕过 step commit，工具调用不写入会话持久化（重启即丢）。修复：fallback 工具完成后以独立工具段消息调用 `onStepCommitted`（loop.ts），并补单元断言。

## 验证命令

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:coverage
npm run build
npm run check
```

