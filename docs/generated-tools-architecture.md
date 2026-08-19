# Generated Tools 技术增强记录

## 当前架构

Generated Tools 由 `CordisRuntime` 装配，核心服务包括：

- `ForgeService`：生成、验证和调度 ForgeJob
- `PromotionService`：候选版本校验、注册、Promotion 和 Continuation
- `ContinuationScheduler`：跨运行恢复和继续执行
- `RuntimeQualificationService`：运行时资格验证
- `GeneratedToolsEventBus`：领域事件
- `MemoryTraceSink`：本地结构化 Trace

持久化 registry、promotion journal、continuation 和 invocation journal 仍然是行为事实源，Cordis 只负责依赖装配和生命周期，不是安全边界。

## 已加入

### 领域事件

事件命名：

- `forge.job.queued`
- `forge.job.phase`
- `forge.job.completed`
- `forge.job.failed`
- `generated-tool.promoted`
- `generated-tool.invoked`

监听器异常会被隔离，不阻断 Forge 主链。

### Forge 状态机

`forge-state-machine.ts` 集中声明 ForgeJob 合法迁移，并拒绝终态回退。

### Trace

`trace.ts` 提供 `TraceSink`、`MemoryTraceSink` 和 span API。当前不上传远程数据，避免桌面端引入外部依赖。

### Policy Engine

`policy-engine.ts` 提供可替换的 allow/ask/deny 策略接口。现有 `policy.ts` durable decision 仍是权威策略实现，Policy Engine 作为后续替换和测试边界。

### IPC 生命周期

Generated Tools IPC 注册函数现在返回 disposer，并支持重复注册前清理旧 handlers。主进程在退出前移除 handlers。

### 统一契约

`contract.ts` 提供 Generated Tool 生命周期命令的 Zod 契约，后续可被 IPC、Workbench 和工作流复用。

## 安全边界

- Cordis 不提供代码沙箱。
- `worker_threads` 不应被视为安全边界。
- 生成工具的权限仍由 manifest、runtime runner、policy、approval 和 durable registry 共同决定。
- `user-owned-full-trust-v1` 仍代表明确授权的高权限执行模式。

## 暂不引入的重型设施

SQLite、Temporal、BullMQ、OPA、WASI 和 Actor Model 暂不替换现有事实源。当前 JSON + CAS + journal 已覆盖桌面应用的恢复和审计需求。若未来出现以下信号再引入：

- 多进程并发写入显著增加
- Workbench 需要复杂历史查询
- ForgeJob 需要跨机器或长时间调度
- 生成代码需要更严格的系统级隔离

## 验收标准

每次增强至少运行：

```powershell
npm run typecheck:node
npm run build
node --test --import=tsx src/main/generated-tools/cordis-plugin.test.ts src/main/generated-tools/observability.test.ts
```

涉及用户链路时，还必须运行 ToolForge vertical slice 和 Generated Tools settings smoke。
