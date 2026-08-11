import type { HostApprovalRequest } from '../tools/registry'
import type {
  GeneratedToolDetailResult,
  GeneratedToolEditResult,
  GeneratedToolJobStatusResult,
  GeneratedToolEnableInput,
  GeneratedToolEnableResult,
  GeneratedToolRevalidateInput,
  GeneratedToolRevalidateResult,
  GeneratedToolEditRequest,
  GeneratedToolContinuationListResult,
  GeneratedToolsListResult
} from '../../shared/generated-tools-management'
import { parseGeneratedToolEditRequest, parseGeneratedToolEnableInput, parseGeneratedToolGetInput, parseGeneratedToolJobStatusInput, parseGeneratedToolRevalidateInput } from '../../shared/generated-tools-management'

export interface GeneratedToolsReadModel {
  list: () => GeneratedToolsListResult
  get: (toolId: string) => GeneratedToolDetailResult
  jobStatus: (jobId: string) => GeneratedToolJobStatusResult
}

export interface GeneratedToolsMutationHandlers {
  enable: (input: GeneratedToolEnableInput, requestApproval?: (request: HostApprovalRequest) => Promise<import('../tools/registry').HostApprovalGrant | null>) => GeneratedToolEnableResult | Promise<GeneratedToolEnableResult>
  revalidate?: (input: GeneratedToolRevalidateInput) => GeneratedToolRevalidateResult
  edit?: (input: GeneratedToolEditRequest, sessionId: string, runId?: string) => GeneratedToolEditResult
}

export interface GeneratedToolsContinuationHandlers {
  list: () => GeneratedToolContinuationListResult
  cancel: (input: unknown) => GeneratedToolContinuationListResult
}
export function handleGeneratedToolGet(
  readModel: GeneratedToolsReadModel,
  input: unknown
): GeneratedToolDetailResult {
  try {
    const parsed = parseGeneratedToolGetInput(input)
    return readModel.get(parsed.toolId)
  } catch {
    return {
      success: false,
      error: {
        code: 'invalid-input',
        message: 'Invalid Generated Tool request'
      }
    }
  }
}

export function handleGeneratedToolJobStatus(
  readModel: GeneratedToolsReadModel,
  input: unknown
): GeneratedToolJobStatusResult {
  try {
    const parsed = parseGeneratedToolJobStatusInput(input)
    return readModel.jobStatus(parsed.jobId)
  } catch {
    return {
      success: false,
      error: {
        code: 'invalid-input',
        message: 'Invalid ForgeJob request'
      }
    }
  }
}

export function handleGeneratedToolEdit(
  handlers: GeneratedToolsMutationHandlers,
  input: unknown,
  sessionId: string,
  runId?: string
): GeneratedToolEditResult {
  try {
    const parsed = parseGeneratedToolEditRequest(input)
    if (!handlers.edit) return { success: false, error: { code: 'read-failed', message: 'Generated Tool edit service is unavailable' } }
    return handlers.edit(parsed, sessionId, runId)
  } catch (error) {
    return { success: false, error: { code: 'invalid-input', message: error instanceof Error ? error.message : 'Invalid Generated Tool edit request' } }
  }
}

export async function handleGeneratedToolEnable(
  handlers: GeneratedToolsMutationHandlers,
  input: unknown,
  requestApproval?: (request: HostApprovalRequest) => Promise<import('../tools/registry').HostApprovalGrant | null>
): Promise<GeneratedToolEnableResult> {
  let parsed: GeneratedToolEnableInput
  try {
    parsed = parseGeneratedToolEnableInput(input)
  } catch {
    return {
      success: false,
      error: {
        code: 'invalid-input',
        message: 'Invalid Generated Tool enable request'
      }
    }
  }

  try {
    return await handlers.enable(parsed, requestApproval)
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

export function handleGeneratedToolRevalidate(
  handlers: GeneratedToolsMutationHandlers,
  input: unknown
): GeneratedToolRevalidateResult {
  let parsed: GeneratedToolRevalidateInput
  try {
    parsed = parseGeneratedToolRevalidateInput(input)
  } catch {
    return {
      success: false,
      error: {
        code: 'invalid-input',
        message: 'Invalid Generated Tool revalidation request'
      }
    }
  }

  try {
    if (!handlers.revalidate) return { success: false, error: { code: 'read-failed', message: 'Generated Tool revalidation service is unavailable' } }
    return handlers.revalidate(parsed)
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'read-failed',
        message: error instanceof Error ? error.message : 'Generated Tool revalidation failed'
      }
    }
  }
}
