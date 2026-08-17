import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ArrowLeft, Brain, Check, ChevronDown, FileText, FolderOpen, GitBranch, Globe, ListChecks, MessageSquare, PencilLine, Plus, SearchCheck, Send, ShieldAlert, ShieldCheck, Sparkles, Square, Target, X, Zap } from 'lucide-react'
import type { AppConfig, ChatImagePart, ContextUsage, GitStatus, PendingUserMessage, ProviderEntry, ReasoningLevel, RunMode, SkillDescriptor } from '@shared/types'
import { ALLOWED_IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_IMAGE_BYTES, base64ByteSize, getImageResizeDimensions } from '@shared/messages'
import { useStore } from '../store'
import { t } from '../i18n'
import ImagePreview from './ImagePreview'
import ContextUsageIndicator from './ContextUsageIndicator'
import { findSlashToken, type SlashToken } from '../slash'
import {
  filterSlashCommands,
  insertSlashToken,
  nativeCommandItems,
  parseNativeSlashCommand,
  removeSlashToken,
  skillCommandItems,
  type GoalCommandMatch,
  type NativeSlashCommandId,
  type SlashCommandItem
} from '../slash-commands'
import { classifyLink, linkLabel, splitUrls } from '../url-preview'

type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto'

export type InputCommandIntent = 'plan'

export interface InputDraft {
  text: string
  images: ChatImagePart[]
  skillIds?: string[]
  links?: string[]
  runMode: RunMode
  command?: { type: InputCommandIntent }
}

export interface InputBoxHandle {
  focus: () => void
  insertLink: (url: string) => void
  insertText: (value: string) => void
  ingestFiles: (files: File[]) => Promise<boolean>
}

type InputLink = {
  id: string
  url: string
  kind: 'web' | 'file'
  label: string
}

export interface Props {
  onSend: (draft: InputDraft, action?: 'send' | 'queue' | 'steer') => boolean | Promise<boolean>
  onCancelPending?: (pendingMessageId: string) => void | Promise<void>
  onSteerPending?: (pendingMessageId: string) => void | Promise<void>
  pendingUserMessages?: PendingUserMessage[]
  onGoal?: (command: GoalCommandMatch, draft: Omit<InputDraft, 'command'>) => boolean | Promise<boolean>
  onCompact?: () => boolean | Promise<boolean>
  planCommandAvailable?: boolean
  onAbort: () => void
  streaming: boolean
  goalActive?: boolean
  contextUsage: ContextUsage | null
  reasoningLevel: ReasoningLevel
  onReasoningLevelChange: (level: ReasoningLevel) => void
  runMode: RunMode
  onRunModeChange: (mode: RunMode) => void
  onProjectChange: (projectId: string) => Promise<boolean>
  onProjectClear: () => Promise<boolean>
  onProjectPick: () => Promise<boolean>
  gitStatus: GitStatus | null
  gitStatusLoading: boolean
}

const MAX_INPUT_LINKS = 16

const InputBox = forwardRef<InputBoxHandle, Props>(function InputBox({ onSend, onCancelPending, onSteerPending, pendingUserMessages = [], onGoal, onCompact, planCommandAvailable = false, onAbort, streaming, goalActive = false, contextUsage, reasoningLevel, onReasoningLevelChange, runMode, onRunModeChange, onProjectChange, onProjectClear, onProjectPick, gitStatus, gitStatusLoading }, ref): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ChatImagePart[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [mode, setMode] = useState<ApprovalMode>('full-auto')
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [selectedSkills, setSelectedSkills] = useState<SkillDescriptor[]>([])
  const [selectedCommand, setSelectedCommand] = useState<NativeSlashCommandId | null>(null)
  const [links, setLinks] = useState<InputLink[]>([])
  const [slashToken, setSlashToken] = useState<SlashToken | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashLoading, setSlashLoading] = useState(false)
  const [slashStatus, setSlashStatus] = useState<string | null>(null)
  const [slashExecuting, setSlashExecuting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'providers' | 'models'>('providers')
  const [hoveredProviderId, setHoveredProviderId] = useState<string | null>(null)
  const language = useStore((state) => state.language)
  const config = useStore((state) => state.config)
  const setConfig = useStore((state) => state.setConfig)
  const projects = useStore((state) => state.projects)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const projectLoading = useStore((state) => state.projectLoading)
  const projectError = useStore((state) => state.projectError)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const slashOptionRefs = useRef(new Map<string, HTMLButtonElement>())
  const slashMenuId = 'input-slash-command-list'

  const refreshSlashSources = async (): Promise<void> => {
    setSlashLoading(true)
    try {
      const loadedSkills = await window.joker.skill.list()
      setSkills(loadedSkills)
      const enabledById = new Map(loadedSkills.filter((skill) => skill.enabled).map((skill) => [skill.id, skill]))
      setSelectedSkills((current) => current.flatMap((skill) => {
        const enabled = enabledById.get(skill.id)
        return enabled ? [enabled] : []
      }))
    } catch {
      setSlashStatus(t(language, 'input.commandsLoadFailed'))
    } finally {
      setSlashLoading(false)
    }
  }

  useEffect(() => {
    void refreshSlashSources()
    window.joker.approval.setMode('full-auto')
  }, [])

  useEffect(() => {
    if (runMode !== 'research') return
    setSelectedSkills([])
    setImages([])
    setLinks((current) => current.filter((link) => link.kind === 'web'))
    setImageError(null)
    setSlashToken(null)
    setSelectedCommand(null)
    setSlashStatus(null)
  }, [runMode])

  useEffect(() => {
    if (!projectMenuOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false)
    }
    const timeoutId = window.setTimeout(() => document.addEventListener('pointerdown', handlePointerDown), 0)
    return () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [projectMenuOpen])

  useEffect(() => {
    if (!config) {
      void window.joker.config.get().then((loadedConfig) => {
        setConfig(loadedConfig)
        setHoveredProviderId(resolveActiveProvider(loadedConfig)?.id ?? null)
      })
    }
  }, [config, setConfig])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    const timeoutId = window.setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown)
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [menuOpen])

  const activeProvider = config ? resolveActiveProvider(config) : null
  const activeModel = activeProvider ? resolveActiveModel(activeProvider) : null
  const hoveredProvider =
    config?.providers.find((provider) => provider.id === hoveredProviderId && provider.enabled) ??
    activeProvider
  const selectedSkillIds = useMemo(() => selectedSkills.map((skill) => skill.id), [selectedSkills])
  const slashCommands = useMemo(() => buildSlashCommands({
    language,
    skills,
    selectedSkillIds,
    goalAvailable: Boolean(onGoal),
    planAvailable: planCommandAvailable,
    compactAvailable: Boolean(onCompact),
    busy: streaming || submitting || slashExecuting
  }), [language, onCompact, onGoal, planCommandAvailable, selectedSkillIds, skills, slashExecuting, streaming, submitting])
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashToken?.query ?? ''),
    [slashCommands, slashToken?.query]
  )
  const nativeSlashCommands = filteredSlashCommands.filter((command) => command.section === 'commands')
  const skillSlashCommands = filteredSlashCommands.filter((command) => command.section === 'skills')
  const activeSlashCommand = filteredSlashCommands[slashIndex]
  const skillsEmpty = !slashToken?.query && !slashLoading && !slashCommands.some((command) => command.section === 'skills')

  useEffect(() => {
    if (!slashToken) return
    setSlashIndex((current) => Math.min(current, Math.max(0, filteredSlashCommands.length - 1)))
  }, [filteredSlashCommands.length, slashToken])

  useEffect(() => {
    if (!activeSlashCommand) return
    slashOptionRefs.current.get(activeSlashCommand.id)?.scrollIntoView({ block: 'nearest' })
  }, [activeSlashCommand])

  useEffect(() => {
    if (!slashToken) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!slashMenuRef.current?.contains(target) && !textareaRef.current?.contains(target)) setSlashToken(null)
    }
    const timeoutId = window.setTimeout(() => document.addEventListener('pointerdown', handlePointerDown), 0)
    return () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [slashToken])

  const addLink = (url: string): boolean => {
    const classification = classifyLink(url)
    if ((classification.kind !== 'web' && classification.kind !== 'file') || (runMode === 'research' && classification.kind !== 'web') || url.length > 4096) return false
    const kind = classification.kind
    if (links.some((link) => link.url === url) || links.length >= MAX_INPUT_LINKS) return false
    setLinks((current) => [...current, { id: `${url}-${crypto.randomUUID()}`, url, kind, label: linkLabel(url) }])
    return true
  }

  const ingestRef = useRef<(files: File[]) => Promise<boolean>>(async () => false)

  useImperativeHandle(ref, () => ({
    focus: (): void => {
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    insertLink: (url: string): void => {
      if (!addLink(url)) return
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    insertText: (value: string): void => {
      const element = textareaRef.current
      const start = element?.selectionStart ?? text.length
      const end = element?.selectionEnd ?? start
      const nextText = text.slice(0, start) + value + text.slice(end)
      setText(nextText)
      requestAnimationFrame(() => {
        const current = textareaRef.current
        if (!current) return
        current.focus()
        const caret = start + value.length
        current.setSelectionRange(caret, caret)
        current.style.height = 'auto'
        current.style.height = `${Math.min(current.scrollHeight, 200)}px`
      })
    },
    ingestFiles: (files: File[]): Promise<boolean> => ingestRef.current(files)
  }), [links, text])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (streaming && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend(event.ctrlKey || event.metaKey ? 'steer' : 'queue')
      return
    }
    if (slashToken) {
      if (event.key === 'Escape' || event.key === 'Tab') {
        setSlashToken(null)
        if (event.key === 'Escape') event.preventDefault()
        return
      }
      if (filteredSlashCommands.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        setSlashIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filteredSlashCommands.length) % filteredSlashCommands.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (activeSlashCommand && !activeSlashCommand.disabled) void executeSlashCommand(activeSlashCommand)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const updateSlashToken = (value: string, caret: number): void => {
    if (runMode !== 'chat') {
      setSlashToken(null)
      return
    }
    const token = findSlashToken(value, caret)
    if (token && !slashToken) void refreshSlashSources()
    setSlashToken(token)
    setSlashIndex(0)
    setSlashStatus(null)
  }

  const focusTextareaAt = (caret: number): void => {
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.setSelectionRange(caret, caret)
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 200)}px`
    })
  }

  const closeSlashMenu = (removeToken = true): void => {
    if (removeToken) {
      const element = textareaRef.current
      const currentText = element?.value ?? text
      const caret = element?.selectionStart ?? currentText.length
      const currentToken = findSlashToken(currentText, caret) ?? slashToken
      if (currentToken) {
        const next = removeSlashToken(currentText, currentToken)
        setText(next.text)
        focusTextareaAt(next.caret)
      }
    }
    setSlashToken(null)
    setSlashIndex(0)
  }

  const openSlashMenu = (): void => {
    if (runMode !== 'chat' || streaming || submitting) return
    const element = textareaRef.current
    const start = element?.selectionStart ?? text.length
    const end = element?.selectionEnd ?? start
    const currentToken = findSlashToken(text, start)
    if (currentToken && start === end) {
      setSlashToken(currentToken)
      setSlashIndex(0)
      setSlashStatus(null)
      void refreshSlashSources()
      focusTextareaAt(start)
      return
    }
    const next = insertSlashToken(text, start, end)
    setText(next.text)
    setSlashToken(next.token)
    setSlashIndex(0)
    setSlashStatus(null)
    void refreshSlashSources()
    focusTextareaAt(next.caret)
  }

  const selectSkill = (skill: SkillDescriptor): void => {
    if (!slashToken || selectedSkills.some((selected) => selected.id === skill.id)) return
    const next = removeSlashToken(text, slashToken)
    setText(next.text)
    setSelectedSkills((current) => [...current, skill])
    setSlashToken(null)
    setSlashIndex(0)
    focusTextareaAt(next.caret)
  }

  const selectNativeCommand = (command: NativeSlashCommandId): void => {
    if (!slashToken) return
    if (command === 'compact') {
      if (!onCompact) return
      closeSlashMenu()
      setSlashExecuting(true)
      void Promise.resolve(onCompact()).finally(() => setSlashExecuting(false))
      return
    }
    const nextText = text.slice(0, slashToken.start) + text.slice(slashToken.end)
    const caret = slashToken.start
    setText(nextText)
    setSelectedCommand(command)
    setSlashToken(null)
    setSlashIndex(0)
    focusTextareaAt(caret)
  }

  const executeSlashCommand = (command: SlashCommandItem): void => {
    if (command.disabled || slashExecuting) return
    setSlashStatus(null)
    if (command.action === 'select-native' && command.nativeCommand) {
      selectNativeCommand(command.nativeCommand)
      return
    }
    if (command.action === 'select-skill') {
      const skill = skills.find((candidate) => candidate.id === command.value)
      if (skill) selectSkill(skill)
    }
  }

  const handleSend = async (action: 'send' | 'queue' | 'steer' = streaming ? 'queue' : 'send'): Promise<void> => {
    const trimmed = text.trim()
    const parsedCommand = runMode === 'chat' ? parseNativeSlashCommand(trimmed) : null
    const command = selectedCommand ?? parsedCommand?.command ?? null
    const commandText = parsedCommand ? parsedCommand.argument : trimmed
    const goalCommand: GoalCommandMatch | null = command === 'goal'
      ? parsedCommand?.command === 'goal'
        ? parsedCommand
        : commandText
          ? { command: 'goal', action: 'create', argument: commandText }
          : { command: 'goal', action: 'inspect', argument: '' }
      : null
    if ((command === 'goal' && !onGoal) || (command === 'plan' && !planCommandAvailable)) return
    if (parsedCommand?.command === 'compact') {
      if (!onCompact || streaming || submitting) return
      setSubmitting(true)
      void Promise.resolve(onCompact()).finally(() => setSubmitting(false))
      return
    }
    if (((!commandText && images.length === 0 && links.length === 0) && command !== 'goal' && command !== 'plan') || submitting) return
    if (streaming && (command !== null || selectedSkills.length > 0)) {
      setSlashStatus(t(language, 'input.commandUnavailableBusy'))
      return
    }

    setSubmitting(true)
    let currentSkills = selectedSkills
    if (runMode === 'chat' && selectedSkills.length > 0) {
      try {
        const loadedSkills = await window.joker.skill.list()
        setSkills(loadedSkills)
        const enabledById = new Map(loadedSkills.filter((skill) => skill.enabled).map((skill) => [skill.id, skill]))
        currentSkills = selectedSkills.flatMap((skill) => {
          const enabled = enabledById.get(skill.id)
          return enabled ? [enabled] : []
        })
        if (currentSkills.length !== selectedSkills.length) {
          setSelectedSkills(currentSkills)
          setSlashStatus(t(language, 'input.selectedSkillsUnavailable'))
          setSubmitting(false)
          return
        }
      } catch {
        setSlashStatus(t(language, 'input.commandsLoadFailed'))
        setSubmitting(false)
        return
      }
    }

    const linkText = links.map((link) => link.url).join('\n')
    const messageText = [commandText, linkText].filter(Boolean).join('\n')
    const draft = {
      text: messageText,
      images: runMode === 'chat' ? images : [],
      skillIds: runMode === 'chat' ? currentSkills.map((skill) => skill.id) : undefined,
      links: links.map((link) => link.url),
      runMode
    }
    const send = goalCommand && onGoal
      ? onGoal(goalCommand, draft)
      : onSend({ ...draft, ...(command === 'plan' ? { command: { type: command } } : {}) }, action)
    void Promise.resolve(send)
      .then((accepted) => {
        if (!accepted) return
        setText('')
        setSelectedSkills([])
        setSelectedCommand(null)
        setLinks([])
        setSlashToken(null)
        setSlashStatus(null)
        setImages([])
        setImageError(null)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      })
      .finally(() => setSubmitting(false))
  }

  const ingestImageFiles = async (imageFiles: File[]): Promise<boolean> => {
    if (imageFiles.length === 0) return false
    if (runMode === 'research') {
      setImageError(t(language, 'research.mode.imagesDisabled'))
      return false
    }
    setImageError(null)
    const available = MAX_IMAGES_PER_MESSAGE - images.length
    if (available <= 0) {
      setImageError(t(language, 'input.imageTooMany'))
      return false
    }
    const next: ChatImagePart[] = []
    let totalBytes = images.reduce((total, image) => total + (image.sizeBytes ?? 0), 0)
    for (const file of imageFiles.slice(0, available)) {
      try {
        if (!(ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)) {
          setImageError(t(language, 'input.imageUnsupported'))
          continue
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setImageError(t(language, 'input.imageTooLarge'))
          continue
        }

        const bitmap = await createImageBitmap(file)
        try {
          if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
            setImageError(t(language, 'input.imageTooManyPixels'))
            continue
          }
          const dimensions = getImageResizeDimensions(bitmap.width, bitmap.height)
          const needsResize = dimensions.resized
          let outputBlob: Blob = file
          let outputType = file.type
          let outputName = file.name || 'clipboard-image'

          if (needsResize) {
            const canvas = document.createElement('canvas')
            canvas.width = dimensions.width
            canvas.height = dimensions.height
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Canvas unavailable')
            context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height)
            outputType = file.type === 'image/gif' ? 'image/png' : file.type
            outputBlob = await new Promise<Blob>((resolve, reject) => {
              canvas.toBlob((blob) => {
                if (blob) resolve(blob)
                else reject(new Error('Image encoding failed'))
              }, outputType, outputType === 'image/jpeg' || outputType === 'image/webp' ? 0.86 : undefined)
            })
            if (file.type === 'image/gif') outputName = outputName.replace(/\.gif$/i, '') + '.png'
          }

          const outputBytes = new Uint8Array(await outputBlob.arrayBuffer())
          if (outputBytes.byteLength > MAX_IMAGE_BYTES || totalBytes + outputBytes.byteLength > MAX_MESSAGE_IMAGE_BYTES) {
            setImageError(t(language, 'input.imageTotalTooLarge'))
            continue
          }
          let binary = ''
          for (let i = 0; i < outputBytes.length; i += 0x8000) binary += String.fromCharCode(...outputBytes.subarray(i, i + 0x8000))
          const data = btoa(binary)
          if (base64ByteSize(data) <= 0) continue
          next.push({ type: 'image', data, mediaType: outputType, filename: outputName, sizeBytes: outputBytes.byteLength })
          totalBytes += outputBytes.byteLength
        } finally {
          bitmap.close()
        }
      } catch {
        setImageError(t(language, 'input.imageProcessingFailed'))
      }
    }
    if (next.length > 0) {
      setImages((current) => [...current, ...next])
      return true
    }
    return false
  }
  ingestRef.current = ingestImageFiles

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length > 0 && runMode === 'research') {
      event.preventDefault()
      setImageError(t(language, 'research.mode.imagesDisabled'))
      return
    }
    if (imageFiles.length === 0) {
      const pasted = event.clipboardData.getData('text/plain')
      const tokens = splitUrls(pasted)
      const pastedLinks = tokens.filter((token) => token.type === 'url' && (classifyLink(token.value).kind === 'web' || classifyLink(token.value).kind === 'file'))
      if (pastedLinks.length > 0) {
        event.preventDefault()
        for (const token of pastedLinks) addLink(token.value)
        const plainText = tokens.filter((token) => token.type === 'text').map((token) => token.value).join('')
        if (plainText) setText((current) => current + plainText)
      }
      return
    }
    event.preventDefault()
    await ingestImageFiles(imageFiles)
  }

  const handleInput = (): void => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }

  const handleModeChange = (newMode: ApprovalMode): void => {
    setMode(newMode)
    window.joker.approval.setMode(newMode)
  }

  const handleModelChange = async (providerId: string, modelId: string): Promise<void> => {
    if (!config) return

    const nextConfig: AppConfig = {
      ...config,
      activeProviderId: providerId,
      providers: config.providers.map((provider) =>
        provider.id === providerId ? { ...provider, currentModelId: modelId } : provider
      )
    }

    setConfig(nextConfig)
    setMenuOpen(false)
    setMenuView('providers')

    const saved = await window.joker.config.save(nextConfig)
    if (!saved) {
      setConfig(config)
    }
  }

  const hasQueueableDraft = Boolean(text.trim()) || images.length > 0 || links.length > 0

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-3 shrink-0">
      <div className="relative mx-auto w-full max-w-3xl">
        {pendingUserMessages.length > 0 && (
          <div data-pending-message-list className="mb-2 space-y-1.5 px-1">
            {pendingUserMessages.map((pending, index) => (
              <div key={pending.message.id} data-pending-message={pending.message.id} className="flex min-h-8 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-active)] px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
                <span className="shrink-0 font-medium text-[var(--color-accent)]">{pending.mode === 'steer' ? t(language, 'input.steerQueued') : t(language, 'input.queuePosition', { count: index + 1 })}</span>
                <span className="min-w-0 flex-1 truncate" title={pending.message.content}>{pending.message.content || t(language, 'input.attachmentMessage')}</span>
                {streaming && !goalActive && pending.mode === 'queue' && onSteerPending && (
                  <button
                    type="button"
                    data-steer-pending={pending.message.id}
                    onClick={() => void onSteerPending(pending.message.id)}
                    title={t(language, 'input.steerPendingHint')}
                    className="shrink-0 rounded px-1.5 py-0.5 font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15"
                  >
                    {t(language, 'input.steer')}
                  </button>
                )}
                {onCancelPending && <button type="button" onClick={() => void onCancelPending(pending.message.id)} aria-label={t(language, 'input.cancelQueued')} title={t(language, 'input.cancelQueued')} className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-red-400"><X size={12} /></button>}
              </div>
            ))}
          </div>
        )}
        <div data-input-composer className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          {runMode === 'research' ? (
            <p className="mb-1.5 text-[10px] leading-4 text-[var(--color-text-muted)]">{t(language, 'research.mode.publicWebOnly')}</p>
          ) : (
            <div ref={projectMenuRef} className="relative mb-1.5 flex min-h-6 items-center gap-1.5 text-[11px]">
              <button type="button" disabled={streaming || projectLoading} onClick={() => setProjectMenuOpen((open) => !open)} title={projects.find((project) => project.id === activeProjectId)?.path} className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
                <FolderOpen size={12} className="shrink-0 text-[var(--color-accent)]" />
                <span className="max-w-56 truncate">{projects.find((project) => project.id === activeProjectId)?.name ?? t(language, 'project.none')}</span>
                <ChevronDown size={12} className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${projectMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              <GitStatusBadge status={gitStatus} loading={gitStatusLoading} language={language} />
              {projectMenuOpen && (
                <div className="absolute bottom-full left-0 z-50 mb-1 w-72 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-2xl">
                  <div className="border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'project.workFolder')}</div>
                  {activeProjectId && <button type="button" onClick={() => void onProjectClear().then((saved) => { if (saved) setProjectMenuOpen(false) })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)]"><X size={13} className="shrink-0" />{t(language, 'project.clear')}</button>}
                  {projects.map((project) => (
                    <button key={project.id} type="button" onClick={() => void onProjectChange(project.id).then((saved) => { if (saved) setProjectMenuOpen(false) })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)]">
                      <FolderOpen size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                      <span className="min-w-0 flex-1 truncate" title={project.path}>{project.name}</span>
                      {project.id === activeProjectId && <Check size={14} className="shrink-0 text-[var(--color-accent)]" />}
                    </button>
                  ))}
                  <button type="button" onClick={() => void onProjectPick().then((saved) => { if (saved) setProjectMenuOpen(false) })} className="flex w-full items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-left text-xs text-[var(--color-accent)] transition hover:bg-[var(--color-surface-hover)]">
                    <FolderOpen size={13} />
                    {t(language, 'project.openFolder')}
                  </button>
                  {projectError && <p className="px-3 py-2 text-[10px] text-red-400">{projectError}</p>}
                </div>
              )}
            </div>
          )}
          {(images.length > 0 || selectedSkills.length > 0 || selectedCommand || links.length > 0) && (
            <div data-input-attachments className="mb-2 flex min-h-6 flex-wrap gap-2">
              {selectedCommand && (
                <span data-command-chip={selectedCommand} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 px-2 py-1 text-xs text-[var(--color-accent)]">
                  /{selectedCommand}
                  <button type="button" aria-label={t(language, 'input.removeCommand', { command: `/${selectedCommand}` })} title={t(language, 'input.removeCommand', { command: `/${selectedCommand}` })} onClick={() => setSelectedCommand(null)} className="ml-1 rounded px-1 hover:bg-[var(--color-accent)]/20">×</button>
                </span>
              )}
              {images.map((image, index) => (
                <ImagePreview
                  key={`${image.filename}-${index}`}
                  image={image}
                  language={language}
                  mode="thumbnail"
                  onRemove={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                />
              ))}
              {selectedSkills.map((skill) => (
                <span key={skill.id} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 px-2 py-1 text-xs text-[var(--color-accent)]">
                  ✦ /{skill.id}
                  <button type="button" aria-label={t(language, 'input.removeSkill', { skill: `/${skill.id}` })} title={t(language, 'input.removeSkill', { skill: `/${skill.id}` })} onClick={() => setSelectedSkills((current) => current.filter((item) => item.id !== skill.id))} className="ml-1 rounded px-1 hover:bg-[var(--color-accent)]/20">×</button>
                </span>
              ))}
              {links.map((link) => (
                <span key={link.id} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-active)] px-2 py-1 text-xs text-[var(--color-text-primary)]">
                  {link.kind === 'file' ? <FileText size={13} className="shrink-0 text-[var(--color-accent)]" /> : <Globe size={13} className="shrink-0 text-[var(--color-accent)]" />}
                  <span className="min-w-0 max-w-52 truncate" title={link.url}>{link.label}</span>
                  <button type="button" aria-label={t(language, 'input.removeLink')} title={t(language, 'input.removeLink')} onClick={() => setLinks((current) => current.filter((item) => item.id !== link.id))} className="ml-1 rounded px-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-accent)]"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          {imageError && <p className="mb-2 text-[10px] text-red-400">{imageError}</p>}
          {!slashToken && slashStatus && <p className="mb-2 text-[10px] text-amber-400">{slashStatus}</p>}
          <div className="flex items-end gap-2">
            <div className="relative flex min-w-0 flex-1 items-end gap-2">
              {runMode === 'chat' && (
                <button
                  type="button"
                  data-slash-trigger
                  aria-label={t(language, 'input.openCommands')}
                  title={t(language, 'input.openCommands')}
                  aria-expanded={Boolean(slashToken)}
                  aria-controls={slashToken ? slashMenuId : undefined}
                  disabled={streaming || submitting || slashExecuting}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openSlashMenu}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-border-light)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-40"
                >
                  <Plus size={15} />
                </button>
              )}
              <textarea
                ref={textareaRef}
                role={slashToken ? 'combobox' : undefined}
                aria-autocomplete={slashToken ? 'list' : undefined}
                aria-expanded={slashToken ? true : undefined}
                aria-controls={slashToken ? slashMenuId : undefined}
                aria-activedescendant={slashToken && activeSlashCommand ? `slash-command-option-${slashIndex}` : undefined}
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  updateSlashToken(event.target.value, event.target.selectionStart)
                }}
                onClick={(event) => updateSlashToken(event.currentTarget.value, event.currentTarget.selectionStart)}
                onKeyUp={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateSlashToken(event.currentTarget.value, event.currentTarget.selectionStart)
                }}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={(event) => void handlePaste(event)}
                rows={1}
                placeholder={t(language, runMode === 'research' ? 'research.mode.placeholder' : 'input.placeholder')}
                className="min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                disabled={submitting || slashExecuting}
              />
              {slashToken && (
                <div id={slashMenuId} data-slash-menu ref={slashMenuRef} role="listbox" aria-label={t(language, 'input.commandsAndSkills')} className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(24rem,52vh)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-2xl">
                  {slashLoading && filteredSlashCommands.length === 0 ? (
                    <p className="px-3 py-5 text-center text-xs text-[var(--color-text-muted)]">{t(language, 'input.commandsLoading')}</p>
                  ) : filteredSlashCommands.length > 0 ? (
                    <>
                      {nativeSlashCommands.length > 0 && <SlashCommandSection label={t(language, 'input.commandGroup.commands')} commands={nativeSlashCommands} allCommands={filteredSlashCommands} activeIndex={slashIndex} optionRefs={slashOptionRefs} onHover={setSlashIndex} onSelect={executeSlashCommand} />}
                      {skillSlashCommands.length > 0 && <SlashCommandSection label={t(language, 'input.commandGroup.skills')} commands={skillSlashCommands} allCommands={filteredSlashCommands} activeIndex={slashIndex} optionRefs={slashOptionRefs} onHover={setSlashIndex} onSelect={executeSlashCommand} />}
                    </>
                  ) : (
                    <div className="px-3 py-6 text-center">
                      <p className="text-xs text-[var(--color-text-secondary)]">{t(language, 'input.commandsNoResults')}</p>
                      <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{t(language, 'input.commandsNoResultsHint')}</p>
                    </div>
                  )}
                  {skillsEmpty && (
                    <div className="border-t border-[var(--color-border)] px-3 py-2">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]/70">{t(language, 'input.commandGroup.skills')}</p>
                      <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{t(language, 'input.commandsNoSkills')}</p>
                      <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{t(language, 'input.commandsNoSkillsHint')}</p>
                    </div>
                  )}
                  {slashStatus && <p className="border-t border-[var(--color-border)] px-2 py-1.5 text-[10px] text-[var(--color-accent)]">{slashStatus}</p>}
                  <div className="border-t border-[var(--color-border)] px-2 py-1.5 text-[10px] text-[var(--color-text-muted)]">{t(language, 'input.skillCommandHints')}</div>
                </div>
              )}
            </div>
            {streaming ? (
              hasQueueableDraft ? (
                <button
                  type="button"
                  data-run-action="queue"
                  onClick={() => void handleSend('queue')}
                  disabled={submitting}
                  title={t(language, 'input.queueHint')}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-bg)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
                >
                  <Send size={12} />
                  {t(language, 'input.queue')}
                </button>
              ) : (
                <button
                  type="button"
                  data-run-action="stop"
                  onClick={onAbort}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-red-600 px-3 text-xs font-medium text-white transition hover:bg-red-500"
                >
                  <Square size={12} className="fill-current" />
                  {t(language, goalActive ? 'input.pauseGoal' : 'input.stop')}
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => void handleSend('send')}
                disabled={submitting || (!text.trim() && images.length === 0 && links.length === 0 && selectedCommand !== 'goal' && selectedCommand !== 'plan')}
                className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-bg)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
              >
                <Send size={12} />
                {t(language, 'input.send')}
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-[var(--color-text-muted)]">
          <div className="flex min-w-0 items-center gap-2">
            <div role="radiogroup" aria-label={t(language, 'approval.mode.label')} className="flex gap-1 rounded-md bg-[var(--color-bg)] p-0.5">
              <IconModeButton active={mode === 'suggest'} label={t(language, 'approval.mode.suggest')} onClick={() => handleModeChange('suggest')}><ShieldAlert size={15} /></IconModeButton>
              <IconModeButton active={mode === 'auto-edit'} label={t(language, 'approval.mode.autoEdit')} onClick={() => handleModeChange('auto-edit')}><PencilLine size={15} /></IconModeButton>
              <IconModeButton active={mode === 'full-auto'} label={t(language, 'approval.mode.fullAuto')} onClick={() => handleModeChange('full-auto')}><ShieldCheck size={15} /></IconModeButton>
            </div>
            <div role="radiogroup" aria-label={t(language, 'research.mode.label')} className="flex gap-1 rounded-md bg-[var(--color-bg)] p-0.5">
              <RunModeIconButton selected={runMode === 'chat'} label={t(language, 'research.mode.chat')} onClick={() => onRunModeChange('chat')} disabled={streaming}><MessageSquare size={15} /></RunModeIconButton>
              <RunModeIconButton selected={runMode === 'research'} label={t(language, 'research.mode.research')} onClick={() => onRunModeChange('research')} disabled={streaming}><SearchCheck size={15} /></RunModeIconButton>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {contextUsage && <ContextUsageIndicator usage={contextUsage} />}
            <ReasoningSelector level={reasoningLevel} onChange={onReasoningLevelChange} disabled={streaming} language={language} />
            <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                setMenuView('providers')
                setMenuOpen((open) => !open)
              }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex max-w-60 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)]"
            >
              <span className="truncate">
                {activeProvider?.name ?? t(language, 'input.noProvider')} / {activeModel?.name ?? t(language, 'input.noModel')}
              </span>
              <ChevronDown size={14} className={`shrink-0 transition ${menuOpen ? 'rotate-180' : ''}`} />
            </button>

            {menuOpen && (
              <div className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-2xl">
                {menuView === 'providers' && (
                  <>
                    <div className="border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      {t(language, 'settings.providers')}
                    </div>
                    {config?.providers.filter((provider) => provider.enabled).map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => {
                          setHoveredProviderId(provider.id)
                          setMenuView('models')
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)]"
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${provider.id === activeProvider?.id ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]'}`} />
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        {provider.id === activeProvider?.id && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
                        <ChevronDown size={13} className="shrink-0 -rotate-90 text-[var(--color-text-muted)]" />
                      </button>
                    ))}
                  </>
                )}

                {menuView === 'models' && hoveredProvider && (
                  <>
                    <button
                      type="button"
                      onClick={() => setMenuView('providers')}
                      className="flex w-full items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                    >
                      <ArrowLeft size={13} />
                      <span>{hoveredProvider.name}</span>
                    </button>
                    {hoveredProvider.models.filter((model) => model.enabled).map((model) => {
                      const selected = hoveredProvider.id === activeProvider?.id && model.id === activeModel?.id
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => void handleModelChange(hoveredProvider.id, model.id)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="min-w-0 flex-1 truncate">{model.name}</span>
                          {selected && <Check size={14} className="shrink-0 text-[var(--color-accent)]" />}
                        </button>
                      )
                    })}
                    {hoveredProvider.models.filter((model) => model.enabled).length === 0 && (
                      <p className="px-3 py-3 text-xs text-[var(--color-text-muted)]">{t(language, 'input.noEnabledModels')}</p>
                    )}
                  </>
                )}
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

export default InputBox

function SlashCommandSection({ label, commands, allCommands, activeIndex, optionRefs, onHover, onSelect }: {
  label: string
  commands: SlashCommandItem[]
  allCommands: SlashCommandItem[]
  activeIndex: number
  optionRefs: React.RefObject<Map<string, HTMLButtonElement>>
  onHover: (index: number) => void
  onSelect: (command: SlashCommandItem) => void
}): React.JSX.Element {
  return (
    <div className="py-1">
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]/70">{label}</div>
      {commands.map((command) => {
        const index = allCommands.findIndex((candidate) => candidate.id === command.id)
        const Icon = commandIcon(command)
        return (
          <button
            key={command.id}
            id={`slash-command-option-${index}`}
            ref={(element) => { if (element) optionRefs.current.set(command.id, element); else optionRefs.current.delete(command.id) }}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            aria-disabled={command.disabled}
            data-slash-option={command.id}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { if (!command.disabled) onSelect(command) }}
            title={command.disabledReason}
            className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${index === activeIndex ? 'bg-[var(--color-surface-active)]' : 'hover:bg-[var(--color-surface-hover)]'} ${command.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <Icon size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-[var(--color-text-primary)]">{command.label}</span>
              {(command.disabledReason || command.description) && <span className={`block truncate text-[10px] ${command.disabledReason ? 'text-amber-400/80' : 'text-[var(--color-text-muted)]'}`}>{command.disabledReason ?? command.description}</span>}
            </span>
            {command.meta && <span className="max-w-40 shrink-0 truncate text-[10px] text-[var(--color-text-muted)]">{command.meta}</span>}
          </button>
        )
      })}
    </div>
  )
}

function commandIcon(command: SlashCommandItem): typeof Sparkles {
  if (command.action === 'select-skill') return Sparkles
  if (command.nativeCommand === 'goal') return Target
  if (command.nativeCommand === 'plan') return ListChecks
  return Zap
}

function buildSlashCommands(options: {
  language: import('../i18n').Language
  skills: SkillDescriptor[]
  selectedSkillIds: string[]
  goalAvailable: boolean
  planAvailable: boolean
  compactAvailable: boolean
  busy: boolean
}): SlashCommandItem[] {
  const { language, skills, selectedSkillIds, goalAvailable, planAvailable, compactAvailable, busy } = options
  return [
    ...nativeCommandItems({
      labels: {
        goal: { description: t(language, 'input.commandGoalDescription') },
        plan: { description: t(language, 'input.commandPlanDescription') },
        compact: { description: t(language, 'input.commandCompactDescription') }
      },
      unavailableReason: t(language, 'input.commandUnavailableNotWired'),
      busyReason: t(language, 'input.commandUnavailableBusy'),
      goalAvailable,
      planAvailable,
      compactAvailable,
      busy
    }),
    ...skillCommandItems(skills, selectedSkillIds, {
      limitReached: t(language, 'input.commandSkillLimit'),
      disabled: t(language, 'input.commandSkillDisabled'),
      changed: t(language, 'input.commandSkillChanged')
    }).map((command) => ({
      ...command,
      meta: command.meta === 'external' ? t(language, 'input.skillSourceExternal') : command.meta === 'builtin' ? t(language, 'input.skillSourceBuiltin') : t(language, 'input.skillSourceUser')
    }))
  ]
}

function GitStatusBadge({ status, loading, language }: { status: GitStatus | null; loading: boolean; language: import('../i18n').Language }): React.JSX.Element | null {
  if (loading || !status || !status.available || !status.isRepository) return null
  const label = status.detached ? 'detached' : status.branch ?? 'HEAD'
  const parts = [
    status.changed > 0 ? t(language, 'project.gitChanged', { count: status.changed }) : '',
    status.untracked > 0 ? t(language, 'project.gitUntracked', { count: status.untracked }) : '',
    status.conflicted > 0 ? t(language, 'project.gitConflicted', { count: status.conflicted }) : ''
  ].filter(Boolean)
  return <span className={`inline-flex max-w-52 items-center gap-1 truncate text-[10px] ${status.conflicted > 0 ? 'text-red-400' : status.clean ? 'text-emerald-400' : 'text-amber-400'}`} title={status.error ?? label}><GitBranch size={12} className="shrink-0" /><span className="truncate">{label}{parts.length > 0 ? ` · ${parts.join(' · ')}` : ` · ${t(language, 'project.gitClean')}`}</span></span>
}

function ReasoningSelector({ level, onChange, disabled, language }: { level: ReasoningLevel; onChange: (level: ReasoningLevel) => void; disabled: boolean; language: import('../i18n').Language }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const levels: ReasoningLevel[] = ['auto', 'none', 'low', 'medium', 'high']
  return (
    <div className="relative shrink-0">
      <button type="button" aria-label={t(language, 'thinking.tooltip', { level: t(language, `thinking.${level}`) })} title={`${t(language, 'thinking.tooltip', { level: t(language, `thinking.${level}`) })} Ctrl+T`} disabled={disabled} onClick={() => setOpen((value) => !value)} className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)] disabled:opacity-50"><Brain size={15} /></button>
      {open && !disabled && <div className="absolute bottom-full right-0 z-50 mb-2 w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-xl">{levels.map((item) => <button key={item} type="button" onClick={() => { onChange(item); setOpen(false) }} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${item === level ? 'bg-[var(--color-surface-active)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'}`}>{t(language, `thinking.${item}`)}{item === level && <Check size={12} />}</button>)}</div>}
    </div>
  )
}
function RunModeIconButton({ selected, label, onClick, disabled, children }: { selected: boolean; label: string; onClick: () => void; disabled: boolean; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" role="radio" aria-checked={selected} aria-label={label} title={label} disabled={disabled} onClick={onClick} className={`flex h-7 w-7 items-center justify-center rounded transition-[background-color,color,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50 ${selected ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'}`}>{children}</button>
}

function IconModeButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" aria-pressed={active} aria-label={label} title={label} onClick={onClick} className={`flex h-7 w-7 items-center justify-center rounded transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${active ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'}`}>{children}</button>
}


function resolveActiveProvider(config: AppConfig): ProviderEntry | null {
  return (
    config.providers.find((provider) => provider.id === config.activeProviderId && provider.enabled) ??
    config.providers.find((provider) => provider.enabled) ??
    null
  )
}

function resolveActiveModel(provider: ProviderEntry) {
  return (
    provider.models.find((model) => model.id === provider.currentModelId && model.enabled) ??
    provider.models.find((model) => model.enabled) ??
    null
  )
}
