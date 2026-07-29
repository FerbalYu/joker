import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Plus, Trash2, X } from 'lucide-react'
import type { ApiFormat, AppConfig, ImageProviderConfig, ImageProviderEntry, McpServerConfig, McpServerRuntime, ModelConfig, ProviderEntry, SkillDescriptor } from '@shared/types'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'

interface Props {
  onClose: () => void
}

type SettingsTab = 'provider' | 'image' | 'mcp' | 'skills'

const API_FORMATS: ApiFormat[] = ['anthropic-messages', 'chat-completions', 'responses']

function defaultModel(): ModelConfig {
  const name = 'gpt-4o'
  return { id: name, name, enabled: true, maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS }
}

function createProvider(index: number): ProviderEntry {
  const model = defaultModel()
  return {
    id: `provider-${Date.now()}-${index}`,
    name: 'Custom provider',
    type: 'openai-compatible',
    apiFormat: 'chat-completions',
    modelsPath: '/v1/models',
    enabled: true,
    apiKey: '',
    baseUrl: 'https://api.example.com/v1',
    models: [model],
    currentModelId: model.id
  }
}

function createImageProvider(index: number): ImageProviderEntry {
  return {
    id: `image-provider-${Date.now()}-${index}`,
    name: 'Custom image provider',
    enabled: false,
    protocol: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    modelsPath: '/models',
    defaultSize: '1024x1024',
    defaultAspectRatio: '1:1',
    defaultResolution: '1k',
    responseFormat: 'url'
  }
}

export default function SettingsModal({ onClose }: Props): React.JSX.Element {
  const storeConfig = useStore((s) => s.config)
  const setStoreConfig = useStore((s) => s.setConfig)
  const language = useStore((s) => s.language)
  const setLanguage = useStore((s) => s.setLanguage)
  const [config, setLocalConfig] = useState<AppConfig | null>(storeConfig)
  const [selectedId, setSelectedId] = useState(storeConfig?.activeProviderId || storeConfig?.providers[0]?.id || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testingProvider, setTestingProvider] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [activeTab, setActiveTab] = useState<SettingsTab>('provider')
  const [mcpServers, setMcpServers] = useState<McpServerRuntime[]>([])
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [imageConfig, setImageConfig] = useState<ImageProviderConfig | null>(null)
  const [selectedImageId, setSelectedImageId] = useState('')
  const selectedImageIdRef = useRef('')
  const [imageTesting, setImageTesting] = useState(false)
  const [imageFetchingModels, setImageFetchingModels] = useState<Record<string, boolean>>({})
  const [imageModelsByProvider, setImageModelsByProvider] = useState<Record<string, string[]>>({})
  const [imageModelMenuOpen, setImageModelMenuOpen] = useState(false)
  const [imageModelShowAll, setImageModelShowAll] = useState(false)
  const [imageModelActiveIndex, setImageModelActiveIndex] = useState(0)
  const imageModelMenuRef = useRef<HTMLDivElement>(null)
  const [imageStatus, setImageStatus] = useState('')
  const [mcpDraft, setMcpDraft] = useState<McpServerConfig>({ id: '', name: '', enabled: true, transport: 'stdio', autoConnect: true })

  useEffect(() => {
    if (storeConfig) {
      setLocalConfig(storeConfig)
      setSelectedId(storeConfig.activeProviderId || storeConfig.providers[0]?.id || '')
      return
    }
    window.joker.config.get().then((loaded) => {
      setStoreConfig(loaded)
      setLocalConfig(loaded)
      setSelectedId(loaded.activeProviderId || loaded.providers[0]?.id || '')
    })
  }, [storeConfig, setStoreConfig])

  useEffect(() => {
    void window.joker.mcp.list().then(setMcpServers)
    void window.joker.skill.list().then(setSkills)
    void window.joker.imageConfig.get().then((loaded) => {
      setImageConfig(loaded)
      setSelectedImageId(loaded.activeProviderId || loaded.providers[0]?.id || '')
    })
  }, [])

  const selectedProvider = useMemo(
    () => config?.providers.find((provider) => provider.id === selectedId) ?? null,
    [config, selectedId]
  )
  const selectedImageProvider = useMemo(
    () => imageConfig?.providers.find((provider) => provider.id === selectedImageId) ?? null,
    [imageConfig, selectedImageId]
  )

  const selectedImageModels = useMemo(
    () => selectedImageProvider ? imageModelsByProvider[selectedImageProvider.id] ?? [] : [],
    [imageModelsByProvider, selectedImageProvider]
  )
  const filteredImageModels = useMemo(() => {
    const query = selectedImageProvider?.model.trim().toLowerCase() ?? ''
    return query && !imageModelShowAll
      ? selectedImageModels.filter((model) => model.toLowerCase().includes(query))
      : selectedImageModels
  }, [imageModelShowAll, selectedImageModels, selectedImageProvider?.model])

  useEffect(() => {
    if (!imageModelMenuOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!imageModelMenuRef.current?.contains(event.target as Node)) setImageModelMenuOpen(false)
    }
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', handlePointerDown), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [imageModelMenuOpen])

  useEffect(() => {
    selectedImageIdRef.current = selectedImageId
    setImageModelMenuOpen(false)
    setImageModelShowAll(false)
    setImageModelActiveIndex(0)
  }, [selectedImageId])

  const updateImageProvider = (updates: Partial<ImageProviderEntry>): void => {
    if (!imageConfig || !selectedImageProvider) return
    setImageConfig({
      ...imageConfig,
      providers: imageConfig.providers.map((provider) =>
        provider.id === selectedImageProvider.id ? { ...provider, ...updates } : provider
      )
    })
  }

  const addImageProvider = (): void => {
    if (!imageConfig) return
    const provider = createImageProvider(imageConfig.providers.length)
    setImageConfig({
      ...imageConfig,
      providers: [...imageConfig.providers, provider],
      activeProviderId: provider.id
    })
    setSelectedImageId(provider.id)
    setImageStatus('')
  }

  const removeImageProvider = (): void => {
    if (!imageConfig || !selectedImageProvider || imageConfig.providers.length <= 1) return
    const providers = imageConfig.providers.filter((provider) => provider.id !== selectedImageProvider.id)
    const activeProviderId = imageConfig.activeProviderId === selectedImageProvider.id
      ? providers[0].id
      : imageConfig.activeProviderId
    setImageConfig({ ...imageConfig, providers, activeProviderId })
    setSelectedImageId(activeProviderId)
    setImageStatus('')
  }

  const addMcpServer = async (): Promise<void> => {
    const result = await window.joker.mcp.add(mcpDraft)
    if (!result.success) {
      setError(result.error ?? 'MCP error')
      return
    }
    setMcpServers(await window.joker.mcp.list())
    setMcpDraft({ id: '', name: '', enabled: true, transport: 'stdio', autoConnect: true })
  }

  const refreshMcpServers = async (): Promise<void> => {
    setMcpServers(await window.joker.mcp.list())
  }

  const changeMcpTrust = async (server: McpServerRuntime): Promise<void> => {
    setError('')
    const result = server.trustState === 'trusted'
      ? await window.joker.mcp.revokeTrust(server.id)
      : await window.joker.mcp.trust(server.id)
    if (!result.success) {
      setError(result.error ?? t(language, 'settings.mcpTrustFailed'))
      return
    }
    await refreshMcpServers()
  }

  const changeMcpPermission = async (server: McpServerRuntime): Promise<void> => {
    setError('')
    const permission = server.permission === 'allow' ? 'deny' : 'allow'
    const result = await window.joker.mcp.setPermission(server.id, permission)
    if (!result.success) {
      setError(result.error ?? t(language, 'settings.mcpPermissionFailed'))
      return
    }
    await refreshMcpServers()
  }

  const toggleSkill = async (skill: SkillDescriptor): Promise<void> => {
    const changed = skill.enabled ? await window.joker.skill.disable(skill.id) : await window.joker.skill.enable(skill.id)
    if (changed) setSkills(await window.joker.skill.list())
  }

  const reloadSkills = async (): Promise<void> => {
    setSkills(await window.joker.skill.reload())
  }

  const updateProvider = (updates: Partial<ProviderEntry>): void => {
    if (!config || !selectedProvider) return
    setLocalConfig({
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === selectedProvider.id ? { ...provider, ...updates } : provider
      )
    })
  }

  const addProvider = (): void => {
    if (!config) return
    const provider = createProvider(config.providers.length)
    setLocalConfig({ ...config, providers: [...config.providers, provider] })
    setSelectedId(provider.id)
  }

  const removeProvider = (): void => {
    if (!config || config.providers.length <= 1 || !selectedProvider) return
    const providers = config.providers.filter((provider) => provider.id !== selectedProvider.id)
    const activeProviderId = config.activeProviderId === selectedProvider.id ? providers[0].id : config.activeProviderId
    setLocalConfig({ ...config, providers, activeProviderId })
    setSelectedId(activeProviderId)
  }

  const addModel = (): void => {
    if (!selectedProvider) return
    const model: ModelConfig = { id: `model-${Date.now()}`, name: 'new-model', enabled: true, maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS }
    updateProvider({ models: [...selectedProvider.models, model], currentModelId: model.id })
  }

  const updateModel = (modelId: string, updates: Partial<ModelConfig>): void => {
    if (!selectedProvider) return
    updateProvider({
      models: selectedProvider.models.map((model) => (model.id === modelId ? { ...model, ...updates } : model))
    })
  }

  const removeModel = (modelId: string): void => {
    if (!selectedProvider || selectedProvider.models.length <= 1) return
    const models = selectedProvider.models.filter((model) => model.id !== modelId)
    updateProvider({
      models,
      currentModelId: selectedProvider.currentModelId === modelId ? models[0].id : selectedProvider.currentModelId
    })
  }

  const fetchModels = async (): Promise<void> => {
    if (!selectedProvider) return
    setFetchingModels(true)
    setError('')
    setStatusMessage('')
    try {
      const result = await window.joker.config.fetchModels(selectedProvider)
      if (!result.success) {
        setError(result.error ?? t(language, 'settings.fetchModels'))
        return
      }
      const currentIds = new Set(result.models.map((model) => model.id))
      const currentModel = selectedProvider.models.find((model) => model.id === selectedProvider.currentModelId)
      const models = result.models.length > 0 ? result.models : selectedProvider.models
      updateProvider({
        models,
        currentModelId: currentModel && currentIds.has(currentModel.id) ? currentModel.id : models[0]?.id ?? selectedProvider.currentModelId
      })
      setStatusMessage(t(language, 'settings.modelsFetched', { count: result.models.length, latency: result.latencyMs ?? 0 }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFetchingModels(false)
    }
  }

  const testCurrentModel = async (): Promise<void> => {
    if (!selectedProvider) return
    setTestingProvider(true)
    setError('')
    setStatusMessage('')
    try {
      const result = await window.joker.config.testProvider(selectedProvider, selectedProvider.currentModelId)
      setStatusMessage(
        result.success
          ? t(language, 'settings.testSuccess', { latency: result.latencyMs ?? 0 })
          : t(language, 'settings.testFailed', { message: result.message })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTestingProvider(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (activeTab === 'image') {
      if (!imageConfig) return
      setSaving(true)
      setError('')
      try {
        await window.joker.imageConfig.save(imageConfig)
        const loaded = await window.joker.imageConfig.get()
        setImageConfig(loaded)
        setSelectedImageId(
          loaded.providers.some((provider) => provider.id === selectedImageId)
            ? selectedImageId
            : loaded.activeProviderId || loaded.providers[0]?.id || ''
        )
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
      return
    }
    if (!config) return
    setSaving(true)
    setError('')
    try {
      await window.joker.config.save(config)
      setStoreConfig(config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const fetchImageModels = async (): Promise<void> => {
    if (!selectedImageProvider) return
    const providerId = selectedImageProvider.id
    setImageFetchingModels((current) => ({ ...current, [providerId]: true }))
    setImageStatus('')
    setError('')
    try {
      const result = await window.joker.imageConfig.fetchModels(selectedImageProvider)
      if (!result.success) {
        setError(result.error ?? t(language, 'settings.fetchImageModels'))
        return
      }
      setImageModelsByProvider((current) => ({ ...current, [providerId]: result.models }))
      setImageStatus(t(language, 'settings.imageModelsFetched', {
        count: result.models.length,
        latency: result.latencyMs ?? 0
      }))
      if (selectedImageIdRef.current === providerId) {
        setImageModelShowAll(true)
        setImageModelActiveIndex(0)
        setImageModelMenuOpen(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImageFetchingModels((current) => ({ ...current, [providerId]: false }))
    }
  }

  const selectImageModel = (model: string): void => {
    updateImageProvider({ model })
    setImageModelMenuOpen(false)
    setImageModelShowAll(false)
    setImageModelActiveIndex(0)
  }

  const handleImageModelKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setImageModelMenuOpen(false)
      return
    }
    if (event.key === 'Tab') {
      setImageModelMenuOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
    if (filteredImageModels.length === 0) return

    if (!imageModelMenuOpen) {
      if (event.key === 'Enter') return
      event.preventDefault()
      setImageModelMenuOpen(true)
      setImageModelActiveIndex(event.key === 'ArrowUp' ? filteredImageModels.length - 1 : 0)
      return
    }

    event.preventDefault()
    if (event.key === 'Enter') {
      selectImageModel(filteredImageModels[imageModelActiveIndex] ?? filteredImageModels[0])
      return
    }
    setImageModelActiveIndex((current) => event.key === 'ArrowDown'
      ? (current + 1) % filteredImageModels.length
      : (current - 1 + filteredImageModels.length) % filteredImageModels.length)
  }

  const testImageConfig = async (): Promise<void> => {
    if (!selectedImageProvider) return
    setImageTesting(true)
    setImageStatus('')
    setError('')
    try {
      const result = await window.joker.imageConfig.test(selectedImageProvider)
      setImageStatus(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImageTesting(false)
    }
  }

  if (!config) return <div className="fixed inset-0 z-50 bg-black/70" />

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div
        className="settings-modal flex h-[min(720px,90vh)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
          <div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">{t(language, 'settings.title')}</h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t(language, 'settings.modelSettings')}</p>
          </div>
          <button aria-label={t(language, 'settings.close')} onClick={onClose} className="rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
            <X size={18} />
          </button>
        </header>

        <nav className="flex border-b border-[var(--color-border)] px-6" aria-label={t(language, 'settings.sections')}>
          {(['provider', 'image', 'mcp', 'skills'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition ${activeTab === tab ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}
            >
              {t(language, `settings.section.${tab}`)}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 flex-1">
          {(activeTab === 'provider' || activeTab === 'image') && (
            <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              {activeTab === 'provider' ? (
                <>
                  <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.providers')}</span>
                    <button onClick={addProvider} title={t(language, 'settings.addProvider')} className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="flex-1 space-y-1 overflow-y-auto">
                    {config.providers.map((provider) => (
                      <button
                        key={provider.id}
                        onClick={() => {
                          setSelectedId(provider.id)
                          setLocalConfig({ ...config, activeProviderId: provider.id })
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${selectedId === provider.id ? 'bg-[var(--color-surface-active)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${provider.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]'}`} />
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        {config.activeProviderId === provider.id && <span className="text-[10px] text-[var(--color-accent)]">●</span>}
                      </button>
                    ))}
                  </div>
                  <button onClick={addProvider} className="mt-3 flex items-center gap-2 px-2 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                    <Plus size={15} /> {t(language, 'settings.addProvider')}
                  </button>
                </>
              ) : imageConfig ? (
                <>
                  <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.imageProviders')}</span>
                    <button type="button" onClick={addImageProvider} title={t(language, 'settings.addImageProvider')} className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="flex-1 space-y-1 overflow-y-auto">
                    {imageConfig.providers.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => {
                          setSelectedImageId(provider.id)
                          setImageConfig({ ...imageConfig, activeProviderId: provider.id })
                          setImageStatus('')
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition ${selectedImageId === provider.id ? 'bg-[var(--color-surface-active)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${provider.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]'}`} />
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        {imageConfig.activeProviderId === provider.id && <span className="text-[10px] text-[var(--color-accent)]">●</span>}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={addImageProvider} className="mt-3 flex items-center gap-2 px-2 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                    <Plus size={15} /> {t(language, 'settings.addImageProvider')}
                  </button>
                </>
              ) : null}
            </aside>
          )}

          <main className="min-w-0 flex-1 overflow-y-auto p-6">
            {activeTab === 'provider' && (
              <>
                <div className="mb-5 flex items-start justify-between gap-4">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.providerName')}</label>
                <input
                  value={selectedProvider?.name ?? ''}
                  onChange={(event) => updateProvider({ name: event.target.value })}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base font-medium text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                />
              </div>
              <button onClick={removeProvider} disabled={config.providers.length <= 1} title={t(language, 'settings.deleteProvider')} className="mt-5 rounded-md p-2 text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30">
                <Trash2 size={17} />
              </button>
            </div>

            {selectedProvider && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.apiFormat')}</label>
                    <select
                      value={selectedProvider.apiFormat}
                      onChange={(event) => updateProvider({ apiFormat: event.target.value as ApiFormat })}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                    >
                      {API_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {t(language, `settings.${format === 'chat-completions' ? 'chatCompletions' : format === 'responses' ? 'responses' : 'anthropicMessages'}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.language')}</label>
                    <select value={language} onChange={(event) => setLanguage(event.target.value as 'zh' | 'en')} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none">
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                  <span className="text-sm text-[var(--color-text-primary)]">{t(language, 'settings.enabled')}</span>
                  <button onClick={() => updateProvider({ enabled: !selectedProvider.enabled })} className={`rounded-full px-3 py-1 text-xs font-medium ${selectedProvider.enabled ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'bg-[var(--color-surface-active)] text-[var(--color-text-secondary)]'}`}>
                    {selectedProvider.enabled ? t(language, 'settings.enabled') : t(language, 'settings.disabled')}
                  </button>
                </div>

                <div className="mt-4">
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.modelsPath')}</label>
                  <input value={selectedProvider.modelsPath ?? '/v1/models'} onChange={(event) => updateProvider({ modelsPath: event.target.value })} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
                </div>

                <div className="mt-4">
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.baseUrl')}</label>
                  <input value={selectedProvider.baseUrl ?? ''} onChange={(event) => updateProvider({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
                </div>

                <div className="mt-4">
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.apiKey')}</label>
                  <input type="password" value={selectedProvider.apiKey ?? ''} onChange={(event) => updateProvider({ apiKey: event.target.value })} placeholder="sk-..." className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
                </div>

                <div className="mt-6">
                  <div className="mb-2 flex items-center justify-between">
                    <label className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.models')}</label>
                    <div className="flex items-center gap-2">
                      <button onClick={fetchModels} disabled={fetchingModels} className="rounded-md bg-[var(--color-surface-active)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40">
                        {fetchingModels ? t(language, 'settings.fetchingModels') : t(language, 'settings.fetchModels')}
                      </button>
                      <button onClick={testCurrentModel} disabled={testingProvider} className="rounded-md bg-[var(--color-accent)]/20 px-2.5 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30 disabled:opacity-40">
                        {testingProvider ? t(language, 'settings.testingProvider') : t(language, 'settings.testProvider')}
                      </button>
                      <span className="text-xs text-[var(--color-text-muted)]">{selectedProvider.models.length}</span>
                    </div>
                  </div>
                  {statusMessage && <p className={`mb-2 text-xs ${statusMessage.includes('不可用') || statusMessage.includes('unavailable') ? 'text-red-400' : 'text-[var(--color-accent)]'}`}>{statusMessage}</p>}
                  <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
                    {selectedProvider.models.map((model) => (
                      <div key={model.id} className="flex items-center gap-2 border-b border-[var(--color-border)] p-2 last:border-b-0">
                        <input value={model.name} onChange={(event) => updateModel(model.id, { name: event.target.value, id: event.target.value })} className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
                        <input type="number" min={1} step={1} value={model.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS} onChange={(event) => updateModel(model.id, { maxContextTokens: Number(event.target.value) })} title={t(language, 'settings.maxContextTokens')} placeholder={String(DEFAULT_MAX_CONTEXT_TOKENS)} className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
                        <button onClick={() => updateProvider({ currentModelId: model.id })} className={`rounded px-2 py-1 text-xs ${selectedProvider.currentModelId === model.id ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}>
                          {selectedProvider.currentModelId === model.id ? t(language, 'settings.active') : t(language, 'settings.use')}
                        </button>
                        <button onClick={() => updateModel(model.id, { enabled: !model.enabled })} className={`h-2 w-2 rounded-full ${model.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]'}`} title={model.enabled ? t(language, 'settings.disableModel') : t(language, 'settings.enableModel')} />
                        <button onClick={() => removeModel(model.id)} disabled={selectedProvider.models.length <= 1} className="rounded p-1 text-[var(--color-text-muted)] hover:text-red-400 disabled:opacity-30"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                  <button onClick={addModel} className="mt-2 flex items-center gap-2 rounded-md bg-[var(--color-surface-active)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><Plus size={15} /> {t(language, 'settings.addModel')}</button>
                </div>
              </>
            )}
            </>
            )}

            {activeTab === 'image' && selectedImageProvider && imageConfig && (
              <section aria-labelledby="image-settings-title">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'settings.providerName')}</label>
                    <input value={selectedImageProvider.name} onChange={(event) => updateImageProvider({ name: event.target.value })} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base font-medium text-[var(--color-text-primary)]" />
                    <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t(language, 'settings.imageDescription')}</p>
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <button type="button" onClick={() => void testImageConfig()} disabled={imageTesting} className="min-h-10 rounded-md bg-[var(--color-accent)]/20 px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30 disabled:opacity-40">{imageTesting ? t(language, 'settings.testingProvider') : t(language, 'settings.testProvider')}</button>
                    <button type="button" onClick={removeImageProvider} disabled={imageConfig.providers.length <= 1} title={t(language, 'settings.deleteImageProvider')} className="rounded-md p-2 text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30"><Trash2 size={17} /></button>
                  </div>
                </div>
                {imageStatus && <p className="mb-3 text-xs text-[var(--color-accent)]">{imageStatus}</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.imageProtocol')}</span><select value={selectedImageProvider.protocol} onChange={(event) => updateImageProvider({ protocol: event.target.value as ImageProviderEntry['protocol'] })} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value="openai-images">OpenAI Images</option><option value="grok-images">Grok Images Compatible</option></select></label>
                  <div ref={imageModelMenuRef} className="relative text-xs text-[var(--color-text-muted)]">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span>{t(language, 'settings.imageModel')}</span>
                      <button
                        type="button"
                        onClick={() => void fetchImageModels()}
                        disabled={imageFetchingModels[selectedImageProvider.id] === true}
                        className="rounded px-2 py-1 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
                      >
                        {imageFetchingModels[selectedImageProvider.id]
                          ? t(language, 'settings.fetchingImageModels')
                          : t(language, 'settings.fetchImageModels')}
                      </button>
                    </div>
                    <div className="flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-accent)]">
                      <input
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={imageModelMenuOpen}
                        aria-controls={`image-model-list-${selectedImageProvider.id}`}
                        aria-activedescendant={imageModelMenuOpen && filteredImageModels[imageModelActiveIndex]
                          ? `image-model-option-${selectedImageProvider.id}-${imageModelActiveIndex}`
                          : undefined}
                        value={selectedImageProvider.model}
                        onChange={(event) => {
                          updateImageProvider({ model: event.target.value })
                          setImageModelShowAll(false)
                          setImageModelActiveIndex(0)
                          if (selectedImageModels.length > 0) setImageModelMenuOpen(true)
                        }}
                        onFocus={() => {
                          if (selectedImageModels.length > 0) setImageModelMenuOpen(true)
                        }}
                        onKeyDown={handleImageModelKeyDown}
                        placeholder={selectedImageProvider.protocol === 'grok-images' ? 'grok-imagine-image' : 'gpt-image-1'}
                        className="min-w-0 flex-1 rounded-l-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setImageModelShowAll(true)
                          setImageModelActiveIndex(0)
                          setImageModelMenuOpen((open) => selectedImageModels.length > 0 && !open)
                        }}
                        disabled={selectedImageModels.length === 0}
                        aria-label={t(language, 'settings.selectImageModel')}
                        aria-expanded={imageModelMenuOpen}
                        className="flex w-10 items-center justify-center rounded-r-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
                      >
                        <ChevronDown size={15} />
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t(language, 'settings.imageModelHint')}</p>
                    {imageModelMenuOpen && (
                      <div
                        id={`image-model-list-${selectedImageProvider.id}`}
                        role="listbox"
                        aria-label={t(language, 'settings.imageModelSuggestions')}
                        className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-[var(--color-border-light)] bg-[var(--color-surface)] p-1 shadow-xl"
                      >
                        {filteredImageModels.length > 0 ? filteredImageModels.map((model, index) => (
                          <button
                            key={model}
                            id={`image-model-option-${selectedImageProvider.id}-${index}`}
                            type="button"
                            role="option"
                            aria-selected={imageModelActiveIndex === index}
                            onMouseEnter={() => setImageModelActiveIndex(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => selectImageModel(model)}
                            className={`block w-full rounded px-3 py-2 text-left text-sm ${imageModelActiveIndex === index ? 'bg-[var(--color-surface-active)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
                          >
                            {model}
                          </button>
                        )) : (
                          <p className="px-3 py-2 text-sm text-[var(--color-text-muted)]">{t(language, 'settings.noMatchingImageModels')}</p>
                        )}
                      </div>
                    )}
                  </div>
                  <label className="text-xs text-[var(--color-text-muted)] sm:col-span-2"><span className="mb-1 block">{t(language, 'settings.baseUrl')}</span><input value={selectedImageProvider.baseUrl} onChange={(event) => updateImageProvider({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label>
                  <label className="text-xs text-[var(--color-text-muted)] sm:col-span-2"><span className="mb-1 block">{t(language, 'settings.apiKey')}</span><input type="password" value={selectedImageProvider.apiKey} onChange={(event) => updateImageProvider({ apiKey: event.target.value })} placeholder="sk-..." className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label>
                  <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.modelsPath')}</span><input value={selectedImageProvider.modelsPath} onChange={(event) => updateImageProvider({ modelsPath: event.target.value })} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label>
                  {selectedImageProvider.protocol === 'openai-images' ? <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.imageDefaultSize')}</span><input value={selectedImageProvider.defaultSize} onChange={(event) => updateImageProvider({ defaultSize: event.target.value })} placeholder="1024x1024" className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label> : <><label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.imageAspectRatio')}</span><input value={selectedImageProvider.defaultAspectRatio} onChange={(event) => updateImageProvider({ defaultAspectRatio: event.target.value })} placeholder="1:1" className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label><label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.imageResolution')}</span><select value={selectedImageProvider.defaultResolution} onChange={(event) => updateImageProvider({ defaultResolution: event.target.value })} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option></select></label></>}
                  <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.imageResponseFormat')}</span><select value={selectedImageProvider.responseFormat} onChange={(event) => updateImageProvider({ responseFormat: event.target.value as ImageProviderEntry['responseFormat'] })} className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value="url">URL</option><option value="b64_json">Base64 JSON</option></select></label>
                </div>
                <div className="mt-4 flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"><span className="text-sm text-[var(--color-text-primary)]">{t(language, 'settings.imageEnabled')}</span><button type="button" onClick={() => updateImageProvider({ enabled: !selectedImageProvider.enabled })} className={`rounded-full px-3 py-1 text-xs font-medium ${selectedImageProvider.enabled ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'bg-[var(--color-surface-active)] text-[var(--color-text-secondary)]'}`}>{selectedImageProvider.enabled ? t(language, 'settings.enabled') : t(language, 'settings.disabled')}</button></div>
              </section>
            )}

            {activeTab === 'mcp' && (
              <section aria-labelledby="mcp-settings-title">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <h3 id="mcp-settings-title" className="text-lg font-semibold text-[var(--color-text-primary)]">{t(language, 'settings.mcp')}</h3>
                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t(language, 'settings.mcpDescription')}</p>
                  </div>
                  <span className="tabular-nums text-sm text-[var(--color-text-muted)]">{mcpServers.length}</span>
                </div>
                <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
                  {mcpServers.length === 0 && <p className="px-2 py-3 text-sm text-[var(--color-text-muted)]">{t(language, 'settings.noMcp')}</p>}
                  {mcpServers.map((server) => (
                    <div key={server.id} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${server.status === 'connected' ? 'bg-[var(--color-accent)]' : server.status === 'error' ? 'bg-red-400' : 'bg-[var(--color-text-muted)]'}`} />
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">{server.name}</span>
                          <span className="text-xs text-[var(--color-text-muted)]">{t(language, `settings.mcp${server.status[0].toUpperCase()}${server.status.slice(1)}`)}</span>
                          <span data-testid={`mcp-trust-state-${server.id}`} className={`text-xs ${server.trustState === 'trusted' ? 'text-[var(--color-accent)]' : 'text-amber-400'}`}>{t(language, server.trustState === 'trusted' ? 'settings.mcpTrusted' : server.trustState === 'changed' ? 'settings.mcpIdentityChanged' : 'settings.mcpUntrusted')}</span>
                          <span data-testid={`mcp-permission-state-${server.id}`} className="text-xs text-[var(--color-text-muted)]">{t(language, server.permission === 'allow' ? 'settings.mcpAllowed' : 'settings.mcpDenied')}</span>

                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
                        <span>{t(language, 'settings.mcpTools', { count: server.toolCount })}</span>
                        <div className="flex items-center gap-2">
                          <button type="button" data-testid={`mcp-trust-${server.id}`} aria-label={t(language, server.trustState === 'trusted' ? 'settings.mcpRevokeTrust' : 'settings.mcpTrust')} onClick={() => void changeMcpTrust(server)} className="min-h-10 rounded px-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">{server.trustState === 'trusted' ? t(language, 'settings.mcpRevokeTrust') : t(language, 'settings.mcpTrust')}</button>
                          <button type="button" data-testid={`mcp-permission-${server.id}`} aria-label={t(language, server.permission === 'allow' ? 'settings.mcpDeny' : 'settings.mcpAllow')} onClick={() => void changeMcpPermission(server)} disabled={server.trustState !== 'trusted'} className="min-h-10 rounded px-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40">{server.permission === 'allow' ? t(language, 'settings.mcpDeny') : t(language, 'settings.mcpAllow')}</button>
                          <button type="button" data-testid={`mcp-reconnect-${server.id}`} aria-label={t(language, 'settings.mcpReconnect')} onClick={() => void window.joker.mcp.reconnect(server.id).then(refreshMcpServers)} className="min-h-10 rounded px-2 text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]">{t(language, 'settings.mcpReconnect')}</button>
                          <button type="button" onClick={() => void window.joker.mcp.remove(server.id).then(async () => setMcpServers(await window.joker.mcp.list()))} className="min-h-10 rounded p-2 text-[var(--color-text-muted)] hover:text-red-400" aria-label={language === 'zh' ? '删除 MCP 服务' : 'Delete MCP server'}><Trash2 size={14} /></button>
                        </div>
                      </div>
                      {server.error && <p className="mt-2 text-xs text-red-400">{server.error}</p>}
                    </div>
                  ))}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">ID</span><input value={mcpDraft.id} onChange={(event) => setMcpDraft({ ...mcpDraft, id: event.target.value })} placeholder="server-id" className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label>
                    <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.mcpName')}</span><input value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} placeholder={t(language, 'settings.mcpName')} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /></label>
                    <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{t(language, 'settings.mcpTransport')}</span><select value={mcpDraft.transport} onChange={(event) => setMcpDraft({ ...mcpDraft, transport: event.target.value as McpServerConfig['transport'] })} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]"><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>
                    <label className="text-xs text-[var(--color-text-muted)]"><span className="mb-1 block">{mcpDraft.transport === 'stdio' ? t(language, 'settings.mcpCommand') : t(language, 'settings.mcpUrl')}</span>{mcpDraft.transport === 'stdio' ? <input value={mcpDraft.command ?? ''} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} placeholder={t(language, 'settings.mcpCommand')} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" /> : <input value={mcpDraft.url ?? ''} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.target.value })} placeholder={t(language, 'settings.mcpUrl')} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]" />}</label>
                  </div>
                  <button type="button" onClick={() => void addMcpServer()} className="mt-1 flex min-h-10 items-center gap-1 rounded bg-[var(--color-surface-active)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><Plus size={14} /> {t(language, 'settings.addMcp')}</button>
                </div>
              </section>
            )}

            {activeTab === 'skills' && (
              <section aria-labelledby="skills-settings-title">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <h3 id="skills-settings-title" className="text-lg font-semibold text-[var(--color-text-primary)]">{t(language, 'settings.skills')}</h3>
                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t(language, 'settings.skillsDescription')}</p>
                  </div>
                  <button type="button" onClick={() => void reloadSkills()} className="min-h-10 rounded px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]">{t(language, 'settings.reloadSkills')}</button>
                </div>
                <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
                  {skills.length === 0 && <div className="space-y-2 rounded-md bg-[var(--color-bg)] p-3 text-sm text-[var(--color-text-muted)]"><p>{t(language, 'settings.noSkills')}</p><p>{t(language, 'settings.skillDirectories')}</p><code className="block whitespace-pre-wrap rounded border border-[var(--color-border)] p-2 text-xs">{t(language, 'settings.skillExample')}</code><p>{t(language, 'settings.skillSafety')}</p></div>}
                  {skills.map((skill) => <div key={skill.id} className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3"><div className="min-w-0 flex-1"><p className="truncate font-medium text-[var(--color-text-primary)]">{skill.name}</p><p className="mt-1 text-sm text-[var(--color-text-muted)]">{skill.description}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{skill.source === 'external' ? t(language, 'settings.skillSourceExternal') : skill.source}{skill.version ? ` · v${skill.version}` : ''}</p></div><button type="button" onClick={() => void toggleSkill(skill)} className={`min-h-10 rounded px-3 py-2 text-sm ${skill.enabled ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'bg-[var(--color-surface-active)] text-[var(--color-text-secondary)]'}`}>{skill.enabled ? t(language, 'settings.enabled') : t(language, 'settings.disabled')}</button></div>)}
                </div>
              </section>
            )}
          </main>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-[var(--color-border)] px-6 py-3">
          {error && <span className="mr-auto text-xs text-red-400">{error}</span>}
          {saved && <span className="mr-auto flex items-center gap-1 text-sm text-[var(--color-accent)]"><Check size={14} /> {t(language, 'settings.saved')}</span>}
          <button onClick={handleSave} disabled={saving} className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40">{saving ? t(language, 'settings.saving') : t(language, 'settings.save')}</button>
        </footer>
      </div>
    </div>
  )
}
