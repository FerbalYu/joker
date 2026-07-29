# JOKER 里程碑

更新时间：2026-07-27

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
- `.github/workflows/ci.yml` 在 Ubuntu 和 Windows 上执行 `npm ci`、`typecheck`、lint、脚本语法检查、单元测试、确定性 integration、coverage 和 `build`，并上传 coverage 与 `out/` artifact；不启动 Electron，不提供真实凭据，也不调用真实 Provider/MCP。
- `npm run test:e2e:electron` 是 opt-in 的本地 Windows Electron harness：在隔离 `JOKER_HOME` 和 Electron user-data 目录中启动 fake Provider，使用 CDP 验证 renderer/preload、配置保存、会话创建、关闭后重启恢复，并输出截图与 JSON report。
- `npm run test:e2e:electron:approval` 是 opt-in 的双窗口审批 harness：通过测试专用 `JOKER_E2E_MULTIWINDOW=1` 启动两个真实主窗口，验证两个 renderer 的审批请求包含不同 `windowId`、跨窗口响应被拒绝、自窗口响应成功，以及关闭窗口后其 pending approval 被取消并回传拒绝结果。
- `npm run test:qualification:stream` 是 opt-in 的 Windows Electron MessagePort qualification harness：已用真实 transferred MessagePort、512 chunks × 2 burst、2ms 慢消费者和中途 abort 运行通过；现已验证应用层 ACK/credit bounded window：`highWaterMark: 32`、`terminalReserve: 3`，pending + in-flight queue depth 不超过 HWM，ACK 计数完全对账，blocked/resumed/drain 均被观测，最终 queue depth 为 0 且无 late event；普通模式与 `--strict` 均通过。该证据按事件 envelope 数量计，不等于 Electron 内部字节级队列或生产 SLA。
- 真实浏览器 WebRead contract 依赖本机 Chrome/Edge；缺少可执行文件时仅显式 skip，不作为默认 CI 浏览器门禁。Ubuntu CI 的 Electron bundle build 不等于 Linux 原生包安装/启动，electron-builder 的 macOS/Linux target 配置也不构成对应平台验收。

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

