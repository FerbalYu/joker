# ToolForge §23 最终证据映射

生成日期：2026-08-06

权威状态来源：`.qa/gate5-audit-report.json`。该报告只接受 `.qa/` 与 `coverage/` 中可解析、保留、校验和绑定的直接检查证据；每个 §23 子组必须由不同的 passed check 满足。

## 最终状态

- §23 状态：`pass`
- 条目：11 / 11 passed
- packaged Windows ToolForge：passed
- packaged Windows Gate 4 edit：passed
- strict qualification bundle：passed

## 逐条映射

| §23 完成定义 | 审计 claim | 主要实现 | 直接验证命令 | 保留证据 |
|---|---|---|---|---|
| 主 JOKER 在真实任务中发现缺口并调用 ToolForge | `real-task-gap-and-forge` | `src/main/tools/tool-forge.ts`, `src/main/agent/loop.ts` | `npm run test:e2e:electron:toolforge-vertical-slice -- --retain-dir=.qa/toolforge-gate3-electron`; `npm run test:qualification:toolforge-vertical-slice -- --retain-dir=.qa/toolforge-gate3-node` | `.qa/toolforge-gate3-electron/electron-toolforge-vertical-slice-report.json`; `.qa/toolforge-gate3-node/vertical-slice-report.json` |
| ForgeAgent 只在隔离 job 环境制造 | `isolated-manufacturing` | `src/main/generated-tools/forge-agent.ts`, `forge-workspace.ts`, `forge-tools.ts` | Node vertical slice；runtime qualification | `.qa/toolforge-gate3-node/vertical-slice-report.json`; `.qa/runtime-qualification-current/.joker/qualification/runtime-qualification.json` |
| Validator 独立验证行为、权限、失败和恢复 | `independent-validation` | `src/main/generated-tools/validator.ts`, `forge-service.ts`, `validation-report-store.ts` | Node/Electron vertical slices；Settings qualification | `.qa/toolforge-gate3-node/vertical-slice-report.json`; `.qa/toolforge-gate3-electron/home/.joker/generated-tools/reports/*/report.json`; `.qa/toolforge-settings-electron/home/.joker/generated-tools/tools/summarize-task-json/versions/v1/validation-report.json` |
| 低风险 Tool 按策略 Promote | `policy-promotion` | `src/main/generated-tools/policy.ts`, `promotion-service.ts`, `version-assembler.ts` | Gate 3 vertical slices；Gate 4 edit | `.qa/toolforge-gate3-electron/electron-toolforge-vertical-slice-report.json`; `.qa/toolforge-gate4-electron/success-run/report.json` |
| 新 Tool 不重启进入新 ToolSet | `hot-toolset-refresh` | `src/main/generated-tools/adapter.ts`, `continuation-scheduler.ts`, `src/main/agent/capabilities.ts` | Electron Gate 3 | `.qa/toolforge-gate3-electron/electron-toolforge-vertical-slice-report.json` |
| 原任务自动续跑并真实调用新 Tool | `continuation-real-call` | `src/main/generated-tools/continuation-v2.ts`, `continuation-scheduler.ts`, `src/main/agent/loop.ts` | Electron/Node Gate 3 | `.qa/toolforge-gate3-electron/electron-toolforge-vertical-slice-report.json`; `.qa/toolforge-gate3-node/vertical-slice-report.json` |
| 对话和设置解释用途、状态、权限、证据 | `conversation-settings-explainability` | `src/renderer/src/components/ToolCard.tsx`, `ToolCallList.tsx`, `generated-tools/ToolWorkbench.tsx` | Electron Gate 3；Generated Tools Settings smoke | `.qa/toolforge-gate3-electron/electron-toolforge-vertical-slice-report.json`; `.qa/toolforge-settings-electron/report.json`; screenshots in the same retained directories |
| 用户选中确定 Tool 做自然语言修改 | `targeted-natural-language-edit` | `src/main/generated-tools/edit-service.ts`, `src/renderer/src/components/generated-tools/ToolWorkbench.tsx` | `npm run test:e2e:electron:toolforge-edit -- --retain-dir=.qa/toolforge-gate4-electron/success-run` | `.qa/toolforge-gate4-electron/success-run/report.json`; `.qa/toolforge-settings-electron/report.json` |
| 修改失败保留稳定版；权限/内容变化自动失效 | `failed-edit-and-invalidation` | `src/main/generated-tools/edit-lifecycle.ts`, `lifecycle-service.ts`, `management-read-model.ts` | Gate 4 failure Electron；lifecycle tests | `.qa/toolforge-gate4-electron/failure.json`; `.qa/toolforge-lifecycle/report.json` |
| 停用、重新验证、回滚、删除、重启恢复 | `lifecycle-and-restart-recovery` | `src/main/generated-tools/lifecycle-service.ts`, `registry.ts`, `version-store.ts` | lifecycle deterministic tests；Settings restart smoke | `.qa/toolforge-lifecycle/report.json`; `.qa/toolforge-settings-electron/report.json` |
| 越权、假成功、重复续跑、并发修改、半切换都有确定性证据 | `deterministic-security-and-race-tests` | runtime broker/qualification；`promotion-service.ts`; `continuation-scheduler.ts`; `edit-lifecycle.ts` | runtime qualification；Gate 2；promotion/continuation recovery；concurrent-edit qualification | `.qa/runtime-qualification-current/.joker/qualification/runtime-qualification.json`; `.qa/toolforge-gate2/report.json`; `.qa/toolforge-race-recovery/report.json`; `.qa/toolforge-concurrent-edit/report.json` |

## Packaged Windows

- ToolForge runtime qualification：`.qa/toolforge-packaged-windows/packaged-toolforge-report.json`
- Gate 4 immutable edit lifecycle：`.qa/toolforge-gate4-package/packaged-gate4-edit-report.json`
- Unpacked application used for qualification：`dist/win-unpacked/JOKER.exe`

## Crash / restart recovery

`PromotionService` covers durable phase crashes at `policy-resolved`, `assembled`, `published`, `registered`, `pointer-switched`, and `continuation-ready`. It also resumes a durable `interrupted` journal after pointer switch by re-validating the active pointer/capability revision, restoring the durable phase, and completing the same promotion without re-registering, re-promoting, or incrementing `capabilityRevision` twice.

## Audit and bundle

- Strict §23 audit: `node --import=tsx scripts/gate5-audit.mjs --strict`
- Strict bundle: `npm run test:qualification:bundle -- --strict --run-id=<unique-id>`
- Latest verified bundle in this workspace: `output/qualification/toolforge-final-scope-check-v3/`
- Expected-negative `node-vm` / `child-process` evidence remains retained but is scoped as a control, not treated as authoritative QuickJS failure.
- Expected Gate 4 failure-scenario artifacts remain retained as required negative evidence.
- Missing/non-passing release signing is reported separately as a release-readiness gap and is not converted into a ToolForge §23 failure.
