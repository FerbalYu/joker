import { ipcMain, BrowserWindow } from 'electron'

import {
  GeneratedToolDetailResult,
  GeneratedToolJobStatusResult,
  GeneratedToolEditResult,
  GeneratedToolEnableResult,
  GeneratedToolRevalidateResult,
  GeneratedToolContinuationListResult,
  GeneratedToolsListResult,
  GeneratedToolLifecycleMutationResult,
  GeneratedToolRemoveResult,
  GeneratedToolExportResult,
  GeneratedToolsQualificationOperationResult,
  parseGeneratedToolLifecycleMutationRequest,
  parseGeneratedToolRemoveInput,
  parseGeneratedToolExportInput
} from '../../shared/generated-tools-management'
import {
  handleGeneratedToolGet,
  handleGeneratedToolJobStatus,
  handleGeneratedToolEdit,
  handleGeneratedToolEnable,
  handleGeneratedToolRevalidate,
  type GeneratedToolsMutationHandlers,
  type GeneratedToolsReadModel
} from './generated-tools-handler'
import {
  getForgeJobStatusForManagement,
  getGeneratedToolForManagement,
  listGeneratedToolsForManagement
} from '../generated-tools/management-read-model'
import { GeneratedToolEditService } from '../generated-tools/edit-service'
import { GeneratedToolRevalidateService } from '../generated-tools/revalidate-service'
import { getDefaultForgeController, getDefaultPromotionService } from '../generated-tools/forge-service-runtime'
import { mutateGeneratedToolLifecycle } from '../generated-tools/lifecycle-service'
import { exportGeneratedTool } from '../generated-tools/export-service'
import { readContinuationV2State } from '../generated-tools/continuation-v2'
import {
  getDefaultRuntimeQualificationService,
  setDefaultRuntimeQualificationService
} from '../generated-tools/runtime-qualification-service-runtime'
import { RuntimeQualificationService } from '../generated-tools/runtime-qualification-service'
import { getJokerHomeDir } from '../store/paths'
import { requestExplicitApproval } from '../agent/approval'

function operationView(operation: import('../generated-tools/qualification-operation-store').QualificationOperationRecord): import('../../shared/generated-tools-management').GeneratedToolsQualificationOperationView {
  return {
    attemptId: operation.attemptId,
    status: operation.status,
    ...(operation.phase ? { phase: operation.phase } : {}),
    completedChecks: operation.completedChecks,
    totalChecks: operation.totalChecks,
    ...(operation.startedAt !== undefined ? { startedAt: operation.startedAt } : {}),
    updatedAt: operation.updatedAt,
    ...(operation.finishedAt !== undefined ? { finishedAt: operation.finishedAt } : {}),
    ...(operation.error ? { error: operation.error } : {})
  }
}

export function getRuntimeQualificationService(): RuntimeQualificationService {
  const existing = getDefaultRuntimeQualificationService()
  if (existing) return existing
  const service = new RuntimeQualificationService({ jokerHome: getJokerHomeDir() })
  setDefaultRuntimeQualificationService(service)
  return service
}

export function createGeneratedToolsReadModel(
  jokerHome = getJokerHomeDir()
): GeneratedToolsReadModel {
  return {
    list: () => listGeneratedToolsForManagement(jokerHome),
    get: (toolId) => getGeneratedToolForManagement(toolId, jokerHome),
    jobStatus: (jobId) => getForgeJobStatusForManagement(jobId, jokerHome)
  }
}

export function listGeneratedToolContinuations(jokerHome = getJokerHomeDir()): GeneratedToolContinuationListResult {
  try {
    return {
      success: true,
      data: readContinuationV2State(jokerHome).continuations.map((continuation) => ({
        id: continuation.id,
        jobId: continuation.jobId,
        toolId: continuation.toolId,
        versionId: continuation.versionId,
        fingerprint: continuation.fingerprint,
        sessionId: continuation.sessionId,
        sourceRunId: continuation.sourceRunId,
        ...(continuation.continuationRunId ? { continuationRunId: continuation.continuationRunId } : {}),
        fromCapabilityRevision: continuation.fromCapabilityRevision,
        toCapabilityRevision: continuation.toCapabilityRevision,
        status: continuation.status,
        attempt: continuation.attempt,
        createdAt: continuation.createdAt,
        updatedAt: continuation.updatedAt,
        ...(continuation.startedAt !== undefined ? { startedAt: continuation.startedAt } : {}),
        ...(continuation.finishedAt !== undefined ? { finishedAt: continuation.finishedAt } : {}),
        ...(continuation.error ? { error: continuation.error.slice(0, 2_000) } : {})
      }))
    }
  } catch {
    return { success: false, error: { code: 'read-failed', message: 'Unable to read Generated Tool continuations' } }
  }
}
export function createGeneratedToolsMutationHandlers(): GeneratedToolsMutationHandlers {
  const jokerHome = getJokerHomeDir()
  const editService = new GeneratedToolEditService({ jokerHome, controller: getDefaultForgeController() })
  const revalidateService = new GeneratedToolRevalidateService({ jokerHome })
  return {
    edit: (input, sessionId, runId) => editService.start(input, sessionId, runId),
    revalidate: (input) => revalidateService.revalidate(input),
    enable: async (input, requestApproval) => {
      const service = getDefaultPromotionService()
      if (!service) {
        return {
          success: false,
          error: {
            code: 'read-failed',
            message: 'Generated Tool enable service is unavailable'
          }
        }
      }
      try {
        const result = await service.advance(input.jobId, requestApproval ? { requestApproval } : undefined)
        return {
          success: true,
          data: {
            jobId: result.job.id,
            toolId: result.job.toolId,
            status: result.job.status,
            action: result.action === 'promoted' ? 'enabled' : result.action === 'approval-required' ? 'permission-required' : 'denied',
            reason: result.reason,
            originalTaskComplete: false
          }
        }
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'read-failed',
            message: error instanceof Error ? error.message : 'Generated Tool enable failed'
          }
        }
      }
    }
  }
}

export function registerGeneratedToolsIpc(
  readModel = createGeneratedToolsReadModel(),
  mutationHandlers = createGeneratedToolsMutationHandlers()
): void {
  ipcMain.handle('generated-tools:list', (): GeneratedToolsListResult => readModel.list())
  ipcMain.handle(
    'generated-tools:get',
    (_event, input: unknown): GeneratedToolDetailResult => handleGeneratedToolGet(readModel, input)
  )
  ipcMain.handle(
    'generated-tools:job-status',
    (_event, input: unknown): GeneratedToolJobStatusResult => handleGeneratedToolJobStatus(readModel, input)
  )
  ipcMain.handle(
    'generated-tools:enable',
    async (event, input: unknown): Promise<GeneratedToolEnableResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const requestApproval = win
        ? (request: import('../tools/registry').HostApprovalRequest) => requestExplicitApproval({
            toolName: request.toolName,
            input: request.input,
            scope: { windowId: event.sender.id, sessionId: request.sessionId, runId: request.runId },
            sendRequest: (approvalRequest) => {
              if (win.isDestroyed() || event.sender.isDestroyed()) throw new Error('Approval owner is unavailable')
              event.sender.send('approval:request', approvalRequest)
            },
            notifyResolved: (resolved) => {
              if (!win.isDestroyed() && !event.sender.isDestroyed()) event.sender.send('approval:resolved', resolved)
            }
          }).then((grant) => grant ? { ...grant, webContentsId: grant.windowId } : null)
        : undefined
      return handleGeneratedToolEnable(mutationHandlers, input, requestApproval)
    }
  )
  ipcMain.handle(
    'generated-tools:edit',
    (_event, input: unknown): GeneratedToolEditResult => handleGeneratedToolEdit(mutationHandlers, input, String((_event.sender as { id?: number }).id ?? 'renderer'))
  )
  ipcMain.handle('generated-tools:remove', (_event, input: unknown): GeneratedToolRemoveResult => {
    try {
      const parsed = parseGeneratedToolRemoveInput(input)
      return mutateGeneratedToolLifecycle('remove', parsed)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid Generated Tool remove request' }
    }
  })
  ipcMain.handle('generated-tools:export', (_event, input: unknown): GeneratedToolExportResult => {
    try {
      const parsed = parseGeneratedToolExportInput(input)
      return exportGeneratedTool(parsed.toolId, parsed.versionId, getJokerHomeDir())
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid Generated Tool export request' }
    }
  })
  ipcMain.handle('generated-tools:disable', (_event, input: unknown): GeneratedToolLifecycleMutationResult => {
    try {
      const parsed = parseGeneratedToolLifecycleMutationRequest(input)
      return mutateGeneratedToolLifecycle('disable', parsed)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid lifecycle request' }
    }
  })
  ipcMain.handle('generated-tools:reenable', (_event, input: unknown): GeneratedToolLifecycleMutationResult => {
    try {
      const parsed = parseGeneratedToolLifecycleMutationRequest(input)
      return mutateGeneratedToolLifecycle('reenable', parsed)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid lifecycle request' }
    }
  })
  ipcMain.handle('generated-tools:rollback', (_event, input: unknown): GeneratedToolLifecycleMutationResult => {
    try {
      const parsed = parseGeneratedToolLifecycleMutationRequest(input)
      return mutateGeneratedToolLifecycle('rollback', parsed)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid lifecycle request' }
    }
  })
  ipcMain.handle('generated-tools:revalidate', (_event, input: unknown): GeneratedToolRevalidateResult => handleGeneratedToolRevalidate(mutationHandlers, input))
  ipcMain.handle('generated-tools:continuations', (): GeneratedToolContinuationListResult => listGeneratedToolContinuations())
  ipcMain.handle('generated-tools:qualification-start', (): GeneratedToolsQualificationOperationResult => {
    try {
      const operation = getRuntimeQualificationService().start()
      return { success: true, data: operationView(operation) }
    } catch (error) {
      return { success: false, error: { code: 'read-failed', message: error instanceof Error ? error.message : 'Unable to start ToolForge verification' } }
    }
  })
  ipcMain.handle('generated-tools:qualification-cancel', (): GeneratedToolsQualificationOperationResult => {
    try {
      const operation = getRuntimeQualificationService().cancel()
      return { success: true, data: operation ? operationView(operation) : null }
    } catch (error) {
      return { success: false, error: { code: 'read-failed', message: error instanceof Error ? error.message : 'Unable to cancel ToolForge verification' } }
    }
  })
}
