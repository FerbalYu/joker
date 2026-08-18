import { useRef, useState } from 'react'
import { useStore } from '../store'
import { t, toolLabel } from '../i18n'
import { ShieldAlert, Check, X } from 'lucide-react'
import type { ApprovalRequest } from '@shared/types'

interface Props {
  approval: ApprovalRequest
}

export default function ApprovalPanel({ approval }: Props): React.JSX.Element {
  const language = useStore((s) => s.language)
  const [responding, setResponding] = useState(false)
  const respondingRef = useRef(false)

  const handleRespond = async (approved: boolean): Promise<void> => {
    if (respondingRef.current) return
    respondingRef.current = true
    setResponding(true)
    try {
      await window.joker.approval.respond(approval.requestId, approved, approval.sessionId, approval.runId)
    } finally {
      respondingRef.current = false
      setResponding(false)
    }
  }

  const isGeneratedToolEnable = approval.toolName === 'GeneratedToolEnable'
  const generatedToolName = typeof approval.input.toolId === 'string' ? approval.input.toolId : t(language, 'toolforge.generatedTool')

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <ShieldAlert size={16} className="text-[var(--color-accent)]" />
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{t(language, 'approval.required')}</p>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(language, isGeneratedToolEnable
            ? 'approval.description.generatedToolEnable'
            : approval.toolName === 'ResearchWebAccess'
              ? 'approval.description.researchWebAccess'
              : approval.toolName === 'WebRead'
                ? 'approval.description.webRead'
                : approval.toolName === 'WebSearch'
                  ? 'approval.description.webSearch'
                  : approval.toolName === 'GenerateImage'
                    ? 'approval.description.generateImage'
                    : 'approval.description')}
        </p>
      </div>

      {isGeneratedToolEnable ? (
        <div className="rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-3">
          <p className="text-xs text-[var(--color-text-muted)]">{t(language, 'approval.generatedTool')}</p>
          <p className="mt-1 text-sm font-medium text-[var(--color-text-primary)]">{generatedToolName}</p>
        </div>
      ) : (
        <>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'approval.tool')}</p>
            <p className="rounded-md bg-[var(--color-bg)] px-3 py-2 text-sm font-medium text-[var(--color-accent)]">
              {toolLabel(language, approval.toolName)}
            </p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'approval.arguments')}</p>
            <pre className="max-h-64 overflow-auto rounded-md bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-primary)]">
              {JSON.stringify(approval.input, null, 2)}
            </pre>
          </div>
        </>
      )}

      {/* Actions */}
      <div className="mt-2 flex flex-col gap-2">
        <button
          onClick={() => void handleRespond(true)}
          disabled={responding}
          className="flex items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-bg)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-wait disabled:opacity-50"
        >
          <Check size={16} />
          {t(language, isGeneratedToolEnable ? 'approval.allowEnable' : 'approval.allow')}
        </button>
        <button
          onClick={() => void handleRespond(false)}
          disabled={responding}
          className="flex items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-50"
        >
          <X size={16} />
          {t(language, isGeneratedToolEnable ? 'approval.keepDisabled' : 'approval.deny')}
        </button>
      </div>
    </div>
  )
}
