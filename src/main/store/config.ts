import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { ApiFormat, AppConfig, McpServerConfig, ModelConfig, ProviderConfig, ProviderEntry, ProviderType, TrustedSkillRecord } from '../../shared/types'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'
import { normalizeContextOptimizationMode } from '../../shared/context'
import { getJokerHomeDir } from './paths'

function getConfigDir(): string {
  return join(getJokerHomeDir(), '.joker')
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

function createModel(name: string): ModelConfig {
  return { id: name, name, enabled: true, maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS }
}

function normalizeMaxContextTokens(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_CONTEXT_TOKENS
}

function normalizeMcpServer(value: unknown, index: number): McpServerConfig | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<McpServerConfig>
  const id = typeof candidate.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(candidate.id) ? candidate.id : `mcp-${index + 1}`
  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim().slice(0, 120) : id
  const transport = candidate.transport === 'http' ? 'http' : candidate.transport === 'stdio' ? 'stdio' : null
  if (!transport) return null
  const args = Array.isArray(candidate.args) ? candidate.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 50) : undefined
  const headers = candidate.headers && typeof candidate.headers === 'object'
    ? Object.fromEntries(Object.entries(candidate.headers).filter(([key, val]) => /^[A-Za-z0-9-]{1,80}$/.test(key) && typeof val === 'string').slice(0, 30))
    : undefined
  return {
    id,
    name,
    enabled: candidate.enabled !== false,
    transport,
    command: typeof candidate.command === 'string' ? candidate.command.trim().slice(0, 240) : undefined,
    args,
    url: typeof candidate.url === 'string' ? candidate.url.trim().slice(0, 2048) : undefined,
    headers,
    autoConnect: candidate.autoConnect !== false,
    trustState: candidate.trustState === 'trusted' ? 'trusted' : candidate.trustState === 'changed' ? 'changed' : 'untrusted',
    trustedFingerprint: typeof candidate.trustedFingerprint === 'string' && /^[a-f0-9]{32}$/.test(candidate.trustedFingerprint) ? candidate.trustedFingerprint : undefined,
    permission: candidate.permission === 'allow' ? 'allow' : 'deny',
    initializeTimeoutMs: typeof candidate.initializeTimeoutMs === 'number' && Number.isFinite(candidate.initializeTimeoutMs) ? Math.min(120_000, Math.max(100, Math.floor(candidate.initializeTimeoutMs))) : 30_000,
    callTimeoutMs: typeof candidate.callTimeoutMs === 'number' && Number.isFinite(candidate.callTimeoutMs) ? Math.min(120_000, Math.max(100, Math.floor(candidate.callTimeoutMs))) : 30_000,
    recovery: candidate.recovery && typeof candidate.recovery === 'object' ? {
      maxRetries: typeof candidate.recovery.maxRetries === 'number' ? Math.min(5, Math.max(0, Math.floor(candidate.recovery.maxRetries))) : 3,
      baseDelayMs: typeof candidate.recovery.baseDelayMs === 'number' ? Math.min(120_000, Math.max(100, Math.floor(candidate.recovery.baseDelayMs))) : 250,
      maxDelayMs: typeof candidate.recovery.maxDelayMs === 'number' ? Math.min(120_000, Math.max(100, Math.floor(candidate.recovery.maxDelayMs))) : 10_000
    } : undefined
  }
}

function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.map((item, index) => normalizeMcpServer(item, index)).filter((server): server is McpServerConfig => {
    if (!server || seen.has(server.id)) return false
    seen.add(server.id)
    return true
  })
}

function normalizeTrustedSkills(value: unknown): TrustedSkillRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const records: TrustedSkillRecord[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<TrustedSkillRecord>
    if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(candidate.id)) continue
    if (typeof candidate.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.fingerprint)) continue
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    records.push({ id: candidate.id, fingerprint: candidate.fingerprint })
  }
  return records
}

function defaultApiFormat(type: ProviderType): ApiFormat {
  return type === 'anthropic' ? 'anthropic-messages' : type === 'openai' ? 'responses' : 'chat-completions'
}

function getDefaults(): AppConfig {
  const model = createModel('gpt-4o')
  return {
    providers: [
      {
        id: 'openai-default',
        name: 'OpenAI',
        type: 'openai',
        apiFormat: 'chat-completions',
        modelsPath: '/v1/models',
        enabled: true,
        apiKey: process.env['OPENAI_API_KEY'] ?? '',
        includeUsage: true,
        promptCache: true,
        models: [model],
        currentModelId: model.id
      }
    ],
    activeProviderId: 'openai-default',
    contextOptimizationMode: 'legacy',
    mcpServers: [],
    trustedSkills: [],
    skillStateVersion: 1
  }
}

function normalizeProvider(raw: Partial<ProviderEntry>, index: number): ProviderEntry {
  const models = Array.isArray(raw.models)
    ? raw.models
        .filter((model) => Boolean(model && typeof model === 'object'))
        .map((model, modelIndex) => {
          const candidate = model as Partial<ModelConfig>
          const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : `model-${modelIndex + 1}`
          return {
            id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : name,
            name,
            enabled: candidate.enabled !== false,
            maxContextTokens: normalizeMaxContextTokens(candidate.maxContextTokens)
          }
        })
    : []
  const fallbackModel = createModel('gpt-4o')
  const safeModels = models.length > 0 ? models : [fallbackModel]
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `provider-${index + 1}`
  const type: ProviderType =
    raw.type === 'anthropic' || raw.type === 'ollama' || raw.type === 'openai-compatible' ? raw.type : 'openai'
  const apiFormat: ApiFormat =
    raw.apiFormat === 'chat-completions' || raw.apiFormat === 'responses' || raw.apiFormat === 'anthropic-messages'
      ? raw.apiFormat
      : defaultApiFormat(type)
  const currentModelId = safeModels.some((model) => model.id === raw.currentModelId)
    ? (raw.currentModelId as string)
    : safeModels[0].id

  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : type,
    type,
    apiFormat,
    modelsPath: typeof raw.modelsPath === 'string' && raw.modelsPath.trim() ? raw.modelsPath.trim() : '/v1/models',
    enabled: raw.enabled !== false,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    includeUsage: raw.includeUsage !== false,
    promptCache: raw.promptCache !== false,
    models: safeModels,
    currentModelId
  }
}

export function normalizeConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') return getDefaults()
  const value = raw as Partial<AppConfig> & { provider?: ProviderConfig & { provider?: ProviderType } }

  if (Array.isArray(value.providers)) {
    const providers = value.providers.map((provider, index) => normalizeProvider(provider, index))
    const safeProviders = providers.length > 0 ? providers : getDefaults().providers
    const activeProviderId = safeProviders.some((provider) => provider.id === value.activeProviderId)
      ? (value.activeProviderId as string)
      : safeProviders[0].id
    const disabledSkills = new Set(
      Array.isArray(value.disabledSkills)
        ? value.disabledSkills.filter((skill): skill is string => typeof skill === 'string')
        : []
    )
    const trustedSkills = normalizeTrustedSkills(value.trustedSkills)
      .filter((record) => !disabledSkills.has(record.id))
    return {
      providers: safeProviders,
      activeProviderId,
      contextOptimizationMode: normalizeContextOptimizationMode(value.contextOptimizationMode),
      mcpServers: normalizeMcpServers(value.mcpServers),
      trustedSkills,
      skillStateVersion: 1
    }
  }

  if (value.provider && typeof value.provider === 'object') {
    const legacy = value.provider
    const modelName = legacy.model || 'gpt-4o'
    const type: ProviderType =
      legacy.provider === 'anthropic' || legacy.provider === 'ollama' || legacy.provider === 'openai-compatible'
        ? legacy.provider
        : 'openai'
    const migrated: ProviderEntry = {
      id: 'legacy-provider',
      name: type === 'openai-compatible' ? 'Custom provider' : type,
      type,
      apiFormat: legacy.apiFormat ?? defaultApiFormat(type),
      modelsPath: legacy.modelsPath ?? '/v1/models',
      enabled: true,
      apiKey: legacy.apiKey ?? '',
      baseUrl: legacy.baseUrl,
      includeUsage: legacy.includeUsage !== false,
      promptCache: legacy.promptCache !== false,
      models: [createModel(modelName)],
      currentModelId: modelName
    }
    return { providers: [migrated], activeProviderId: migrated.id, contextOptimizationMode: 'legacy', mcpServers: [], trustedSkills: [], skillStateVersion: 1 }
  }

  return getDefaults()
}

export function preserveSkillConfigState(incoming: AppConfig, existing: AppConfig): AppConfig {
  return {
    ...incoming,
    trustedSkills: existing.trustedSkills,
    skillStateVersion: 1
  }
}

export function loadConfig(): AppConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return getDefaults()
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return getDefaults()
  }
}

export function saveConfig(config: AppConfig): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getConfigPath(), JSON.stringify(normalizeConfig(config), null, 2), 'utf-8')
}

export function resolveActiveProvider(config: AppConfig): ProviderEntry {
  const active = config.providers.find((provider) => provider.id === config.activeProviderId && provider.enabled)
  const fallback = active ?? config.providers.find((provider) => provider.enabled)
  if (!fallback) throw new Error('No enabled provider is configured')
  return fallback
}

export function resolveActiveModel(config: AppConfig): ProviderConfig {
  const provider = resolveActiveProvider(config)
  const model = provider.models.find((candidate) => candidate.id === provider.currentModelId && candidate.enabled) ?? provider.models.find((candidate) => candidate.enabled)
  if (!model) throw new Error(`No enabled model is configured for provider: ${provider.name}`)

  return {
    provider: provider.type,
    apiFormat: provider.apiFormat,
    model: model.name,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    modelsPath: provider.modelsPath,
    includeUsage: provider.includeUsage !== false,
    promptCache: provider.promptCache !== false
  }
}

export type { AppConfig }
