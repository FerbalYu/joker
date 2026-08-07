import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ApiFormat, ModelConfig, ProviderConfig, ProviderEntry, ProviderTestResult } from '../../shared/types'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'
import { normalizeOpenAIStreamingToolCallFetch } from './stream-normalizer'

export function createLanguageModel(config: ProviderConfig): LanguageModel {
  switch (config.apiFormat) {
    case 'chat-completions': {
      if (config.provider === 'openai') {
        const openai = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch: normalizeOpenAIStreamingToolCallFetch() })
        return openai.chat(config.model)
      }
      const compatible = createOpenAICompatible({
        baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
        apiKey: config.apiKey,
        name: config.provider,
        includeUsage: config.includeUsage !== false,
        fetch: normalizeOpenAIStreamingToolCallFetch()
      })
      return compatible.chatModel(config.model)
    }
    case 'responses': {
      const openai = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })
      return openai.responses(config.model)
    }
    case 'anthropic-messages': {
      const anthropic = createAnthropic({
        apiKey: config.apiKey,
        baseURL: normalizeAnthropicBaseUrl(config.baseUrl)
      })
      return anthropic(config.model)
    }
    default:
      throw new Error(`Unknown API format: ${config.apiFormat satisfies never}`)
  }
}

export interface ProviderModelDraft {
  id: string
  name: string
  apiFormat: ApiFormat
  modelsPath?: string
  apiKey?: string
  baseUrl?: string
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function normalizeAnthropicBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined
  const normalized = normalizeBaseUrl(baseUrl)
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`
}

function appendApiPath(base: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const safePath = base.endsWith('/v1') && normalizedPath.startsWith('/v1/') ? normalizedPath.slice(3) : normalizedPath
  return `${base}${safePath}`
}
function buildModelsUrl(provider: ProviderModelDraft): string {
  const base = normalizeBaseUrl(provider.baseUrl ?? '')
  return appendApiPath(base, provider.modelsPath?.trim() || '/v1/models')
}
function extractModelNames(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown[] }).models)
        ? (payload as { models: unknown[] }).models
        : []

  const names = new Set<string>()
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim()) names.add(row.trim())
      continue
    }
    if (!row || typeof row !== 'object') continue

    const obj = row as Record<string, unknown>
    // 常见字段
    const direct = String(obj.id ?? obj.name ?? obj.model ?? '').trim()
    if (direct) {
      names.add(direct)
      continue
    }
    // 嵌套：model.id / model.name
    const nested = obj.model
    if (nested && typeof nested === 'object') {
      const nestedName = String((nested as Record<string, unknown>).id ?? (nested as Record<string, unknown>).name ?? '').trim()
      if (nestedName) names.add(nestedName)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export async function requestJson(
  url: string,
  apiKey: string | undefined,
  init: RequestInit,
  timeoutMs: number,
  apiFormat?: ApiFormat
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = new Headers(init.headers)
    if (apiFormat === 'anthropic-messages') {
      headers.set('x-api-key', apiKey ?? '')
      headers.set('anthropic-version', '2023-06-01')
    } else {
      headers.set('Authorization', `Bearer ${apiKey ?? ''}`)
    }
    if (init.body) headers.set('Content-Type', 'application/json')
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers
    })
    const text = await response.text()
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('API 密钥无效或没有权限')
      if (response.status === 404) throw new Error('接口地址或 API 格式不匹配')
      if (response.status === 429) throw new Error('请求过于频繁，请稍后重试')
      if (response.status >= 500) throw new Error('上游服务暂时不可用')
      throw new Error(`请求失败（${response.status}）`)
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('上游返回了无法解析的 JSON')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时')
    if (error instanceof Error) throw error
    throw new Error('无法连接供应商接口')
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchProviderModels(provider: ProviderModelDraft): Promise<{ models: ModelConfig[]; latencyMs: number }> {
  if (!provider.baseUrl?.trim()) throw new Error('请先填写接口地址')
  const started = Date.now()
  const url = buildModelsUrl(provider)
  const payload = await requestJson(url, provider.apiKey, { method: 'GET' }, 8000, provider.apiFormat)
  const names = extractModelNames(payload)
  if (names.length === 0) {
    const preview = JSON.stringify(payload).slice(0, 200)
    throw new Error(`从 ${url} 拉取到 0 个模型。返回内容：${preview}`)
  }
  return {
    latencyMs: Date.now() - started,
    models: names.map((name) => ({ id: name, name, enabled: true, maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS }))
  }
}

export async function testProviderModel(provider: ProviderModelDraft, modelId: string): Promise<ProviderTestResult> {
  const id = modelId.trim()
  if (!provider.baseUrl?.trim() || !provider.apiKey?.trim()) {
    return { success: false, status: 'unconfigured', modelId: id, message: '请先填写接口地址和 API 密钥' }
  }
  if (!id) return { success: false, status: 'unconfigured', modelId: id, message: '请先选择模型' }

  const started = Date.now()
  try {
    const base = normalizeBaseUrl(provider.baseUrl)
    let url: string
    let body: Record<string, unknown>
    if (provider.apiFormat === 'anthropic-messages') {
      url = appendApiPath(base, '/v1/messages')
      body = { model: id, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    } else if (provider.apiFormat === 'responses') {
      url = appendApiPath(base, '/responses')
      body = { model: id, input: 'ping', max_output_tokens: 1 }
    } else {
      url = appendApiPath(base, '/chat/completions')
      body = { model: id, temperature: 0, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    }
    await requestJson(url, provider.apiKey, { method: 'POST', body: JSON.stringify(body) }, 12000, provider.apiFormat)
    return { success: true, status: 'available', modelId: id, latencyMs: Date.now() - started, message: '模型可用' }
  } catch (error) {
    return {
      success: false,
      status: 'unavailable',
      modelId: id,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : '模型不可用'
    }
  }
}

export function mergeFetchedModels(existing: ModelConfig[], fetched: ModelConfig[]): ModelConfig[] {
  const enabledById = new Map(existing.map((model) => [model.id, model.enabled]))
  const contextById = new Map(existing.map((model) => [model.id, model.maxContextTokens]))
  return fetched.map((model) => ({ ...model, enabled: enabledById.get(model.id) ?? true, maxContextTokens: contextById.get(model.id) ?? model.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS }))
}

export function providerEntryToDraft(provider: ProviderEntry): ProviderModelDraft {
  return provider
}
