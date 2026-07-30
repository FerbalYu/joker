import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ArrowLeft, Brain, Check, ChevronDown, FileText, FolderOpen, GitBranch, Globe, MessageSquare, PencilLine, SearchCheck, Send, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react'
import type { AppConfig, ChatImagePart, ContextUsage, GitStatus, ProviderEntry, ReasoningLevel, RunMode, SkillDescriptor } from '@shared/types'
import { ALLOWED_IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGES_PER_MESSAGE, MAX_MESSAGE_IMAGE_BYTES, base64ByteSize, getImageResizeDimensions } from '@shared/messages'
import { useStore } from '../store'
import { t } from '../i18n'
import ImagePreview from './ImagePreview'
import ContextUsageIndicator from './ContextUsageIndicator'
import { filterSkills, findSlashToken, type SlashToken } from '../slash'
import { classifyLink, linkLabel, splitUrls } from '../url-preview'

type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto'

export interface InputBoxHandle {
  insertLink: (url: string) => void
  insertText: (value: string) => void
}

type InputLink = {
  id: string
  url: string
  kind: 'web' | 'file'
  label: string
}

interface Props {
  onSend: (draft: { text: string; images: ChatImagePart[]; skillIds?: string[]; links?: string[]; runMode: RunMode }) => boolean | Promise<boolean>
  onAbort: () => void
  streaming: boolean
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

const InputBox = forwardRef<InputBoxHandle, Props>(function InputBox({ onSend, onAbort, streaming, contextUsage, reasoningLevel, onReasoningLevelChange, runMode, onRunModeChange, onProjectChange, onProjectClear, onProjectPick, gitStatus, gitStatusLoading }, ref): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ChatImagePart[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [mode, setMode] = useState<ApprovalMode>('suggest')
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [selectedSkills, setSelectedSkills] = useState<SkillDescriptor[]>([])
  const [links, setLinks] = useState<InputLink[]>([])
  const [slashToken, setSlashToken] = useState<SlashToken | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
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

  useEffect(() => {
    void window.joker.skill.list().then(setSkills)
  }, [])

  useEffect(() => {
    if (runMode !== 'research') return
    setSelectedSkills([])
    setImages([])
    setLinks((current) => current.filter((link) => link.kind === 'web'))
    setImageError(null)
    setSlashToken(null)
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

  const filteredSkills = useMemo(
    () => runMode === 'chat'
      ? filterSkills(skills.filter((skill) => !selectedSkills.some((selected) => selected.id === skill.id)), slashToken?.query ?? '')
      : [],
    [runMode, selectedSkills, skills, slashToken?.query]
  )
  const activeProvider = config ? resolveActiveProvider(config) : null
  const activeModel = activeProvider ? resolveActiveModel(activeProvider) : null
  const hoveredProvider =
    config?.providers.find((provider) => provider.id === hoveredProviderId && provider.enabled) ??
    activeProvider

  const addLink = (url: string): boolean => {
    const classification = classifyLink(url)
    if ((classification.kind !== 'web' && classification.kind !== 'file') || (runMode === 'research' && classification.kind !== 'web') || url.length > 4096) return false
    const kind = classification.kind
    if (links.some((link) => link.url === url) || links.length >= MAX_INPUT_LINKS) return false
    setLinks((current) => [...current, { id: `${url}-${crypto.randomUUID()}`, url, kind, label: linkLabel(url) }])
    return true
  }

  useImperativeHandle(ref, () => ({
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
    }
  }), [links, text])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashToken && filteredSkills.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filteredSkills.length) % filteredSkills.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashToken(null)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        selectSkill(filteredSkills[slashIndex])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  const updateSlashToken = (value: string, caret: number): void => {
    if (runMode !== 'chat') {
      setSlashToken(null)
      return
    }
    const token = findSlashToken(value, caret)
    setSlashToken(token)
    setSlashIndex(0)
  }

  const selectSkill = (skill: SkillDescriptor): void => {
    if (!slashToken) return
    const nextText = text.slice(0, slashToken.start) + text.slice(slashToken.end)
    setText(nextText)
    setSelectedSkills((current) => [...current, skill])
    setSlashToken(null)
    setSlashIndex(0)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      const caret = slashToken.start + text.slice(slashToken.end).length
      element.focus()
      element.setSelectionRange(caret, caret)
    })
  }

  const handleSend = (): void => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0 && links.length === 0) || streaming || submitting) return
    const commandText = runMode === 'chat' && selectedSkills.length > 0 ? text.replace(/(?:^|\s)\/[A-Za-z0-9._-]+/g, ' ').replace(/\s{2,}/g, ' ').trim() : trimmed
    const linkText = links.map((link) => link.url).join('\n')
    const messageText = [commandText, linkText].filter(Boolean).join('\n')
    setSubmitting(true)
    void Promise.resolve(onSend({ text: messageText, images: runMode === 'chat' ? images : [], skillIds: runMode === 'chat' ? selectedSkills.map((skill) => skill.id) : undefined, links: links.map((link) => link.url), runMode }))
      .then((accepted) => {
        if (!accepted) return
        setText('')
        setSelectedSkills([])
        setLinks([])
        setSlashToken(null)
        setImages([])
        setImageError(null)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      })
      .finally(() => setSubmitting(false))
  }

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (streaming) return
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
    setImageError(null)
    const available = MAX_IMAGES_PER_MESSAGE - images.length
    if (available <= 0) {
      setImageError(t(language, 'input.imageTooMany'))
      return
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
    if (next.length > 0) setImages((current) => [...current, ...next])
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

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-[35px] py-3 shrink-0">
      <div className="relative w-full">
        <div className="relative mb-2 flex items-center justify-end px-1" ref={projectMenuRef}>
          <div className="flex min-w-0 items-center gap-2">
            {runMode === 'research' ? (
              <span className="max-w-80 text-right text-[10px] leading-4 text-[var(--color-text-muted)]">{t(language, 'research.mode.publicWebOnly')}</span>
            ) : (
              <>
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'project.current')}</span>
                <button type="button" disabled={streaming || projectLoading} onClick={() => setProjectMenuOpen((open) => !open)} title={projects.find((project) => project.id === activeProjectId)?.path} className="flex min-h-9 max-w-64 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
                  <FolderOpen size={13} className="shrink-0 text-[var(--color-accent)]" />
                  <span className="max-w-44 truncate">{projects.find((project) => project.id === activeProjectId)?.name ?? t(language, 'project.none')}</span>
                  <ChevronDown size={13} className={`shrink-0 transition-transform ${projectMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                <GitStatusBadge status={gitStatus} loading={gitStatusLoading} language={language} />
              </>
            )}
            {projectMenuOpen && runMode === 'chat' && (
              <div className="absolute bottom-full right-0 z-50 mb-2 w-72 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-2xl">
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
        </div>
        <div data-input-composer className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          {(images.length > 0 || selectedSkills.length > 0 || links.length > 0) && (
            <div data-input-attachments className="mb-2 flex min-h-6 flex-wrap gap-2">
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
                  <button type="button" aria-label={`移除 /${skill.id}`} onClick={() => setSelectedSkills((current) => current.filter((item) => item.id !== skill.id))} className="ml-1 rounded px-1 hover:bg-[var(--color-accent)]/20">×</button>
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
          <div className="flex items-end gap-2">
            <div className="relative min-w-0 flex-1">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  updateSlashToken(event.target.value, event.target.selectionStart)
                }}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={(event) => void handlePaste(event)}
                rows={1}
                placeholder={t(language, runMode === 'research' ? 'research.mode.placeholder' : 'input.placeholder')}
                className="w-full resize-none bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                disabled={streaming || submitting}
              />
              {slashToken && filteredSkills.length > 0 && (
                <div ref={slashMenuRef} className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-2xl">
                  <div className="border-b border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'input.skillCommands')}</div>
                  {filteredSkills.map((skill, index) => (
                    <button key={skill.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectSkill(skill)} className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${index === slashIndex ? 'bg-[var(--color-surface-active)]' : 'hover:bg-[var(--color-surface-hover)]'}`}>
                      <span className="min-w-0 shrink-0 truncate text-sm font-medium text-[var(--color-accent)]">/{skill.id}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">{skill.description}</span>
                      <span className="shrink-0 text-[9px] text-[var(--color-text-muted)]/60">{skill.source === 'external' ? t(language, 'input.skillSourceExternal') : skill.source === 'builtin' ? t(language, 'input.skillSourceBuiltin') : t(language, 'input.skillSourceUser')}</span>
                    </button>
                  ))}
                  <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">{t(language, 'input.skillCommandHints')}</div>
                </div>
              )}
            </div>
            {streaming ? (
              <button
                type="button"
                onClick={onAbort}
                className="flex shrink-0 items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500"
              >
                <Square size={12} className="fill-current" />
                {t(language, 'input.stop')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={submitting || (!text.trim() && images.length === 0 && links.length === 0)}
                className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
              >
                <Send size={12} />
                {t(language, 'input.send')}
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-[var(--color-text-muted)]">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex gap-1 rounded-md bg-[var(--color-bg)] p-0.5">
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
  return <button type="button" aria-label={label} title={label} onClick={onClick} className={`flex h-7 w-7 items-center justify-center rounded transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${active ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'}`}>{children}</button>
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
