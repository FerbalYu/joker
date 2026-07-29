import { useStore } from '../store'
import { t, toolLabel } from '../i18n'
import { ShieldAlert, Check, X } from 'lucide-react'
import type { ApprovalRequest } from '@shared/types'

interface Props {
  approval: ApprovalRequest
}

export default function ApprovalPanel({ approval }: Props): React.JSX.Element {
  const removeApproval = useStore((s) => s.removeApproval)
  const language = useStore((s) => s.language)

  const handleRespond = (approved: boolean): void => {
    window.joker.approval.respond(approval.requestId, approved, approval.sessionId, approval.runId)
    removeApproval(approval.requestId)
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <ShieldAlert size={16} className="text-[var(--color-accent)]" />
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{t(language, 'approval.required')}</p>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(language, approval.toolName === 'WebRead'
            ? 'approval.description.webRead'
            : approval.toolName === 'WebSearch'
              ? 'approval.description.webSearch'
              : approval.toolName === 'GenerateImage'
                ? 'approval.description.generateImage'
                : 'approval.description')}
        </p>
      </div>

      {/* Tool name */}
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'approval.tool')}</p>
        <p className="rounded-md bg-[var(--color-bg)] px-3 py-2 text-sm font-medium text-[var(--color-accent)]">
          {toolLabel(language, approval.toolName)}
        </p>
      </div>

      {/* Input */}
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'approval.arguments')}</p>
        <pre className="max-h-64 overflow-auto rounded-md bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-primary)]">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      </div>

      {/* Actions */}
      <div className="mt-2 flex flex-col gap-2">
        <button
          onClick={() => handleRespond(true)}
          className="flex items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-bg)] transition hover:bg-[var(--color-accent-hover)]"
        >
          <Check size={16} />
          {t(language, 'approval.allow')}
        </button>
        <button
          onClick={() => handleRespond(false)}
          className="flex items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-500"
        >
          <X size={16} />
          {t(language, 'approval.deny')}
        </button>
      </div>
    </div>
  )
}
