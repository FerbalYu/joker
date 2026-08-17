import { useState } from 'react'
import { useStore } from '../store'
import { t } from '../i18n'
import { HelpCircle, Check, X, Send } from 'lucide-react'
import type { UserQuestionRequest } from '@shared/types'

interface Props {
  question: UserQuestionRequest
}

export default function UserQuestionPanel({ question }: Props): React.JSX.Element {
  const removeUserQuestion = useStore((s) => s.removeUserQuestion)
  const language = useStore((s) => s.language)
  const [selected, setSelected] = useState<string[]>([])
  const [freeText, setFreeText] = useState('')
  const [responding, setResponding] = useState(false)

  const toggle = (id: string): void => {
    if (question.multiSelect) {
      setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    } else {
      setSelected((current) => (current.length === 1 && current[0] === id ? [] : [id]))
    }
  }

  const submit = async (cancelled: boolean): Promise<void> => {
    if (responding) return
    setResponding(true)
    const text = !cancelled && freeText.trim() ? freeText.trim() : null
    try {
      const accepted = await window.joker.userQuestion.answer({
        requestId: question.requestId,
        sessionId: question.sessionId,
        runId: question.runId,
        selectedIds: cancelled ? [] : selected,
        freeText: text,
        ...(cancelled ? { cancelled: true } : {})
      })
      if (accepted) removeUserQuestion(question.requestId)
    } finally {
      setResponding(false)
    }
  }

  const canSubmit = question.options.length === 0 || selected.length > 0 || Boolean(freeText.trim())

  return (
    <div data-user-question-panel className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <HelpCircle size={16} className="text-[var(--color-accent)]" />
          <p className="text-sm font-medium text-[var(--color-text-primary)]">
            {question.header ? `${question.header} — ` : ''}{t(language, 'question.assistantAsks')}
          </p>
        </div>
        <p className="text-sm leading-6 text-[var(--color-text-primary)]">{question.question}</p>
      </div>

      {question.options.length > 0 && (
        <div className="flex flex-col gap-2" data-question-options>
          {question.options.map((option) => {
            const isSelected = selected.includes(option.id)
            return (
              <button
                key={option.id}
                type="button"
                data-question-option={option.id}
                aria-pressed={isSelected}
                onClick={() => toggle(option.id)}
                className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition ${
                  isSelected
                    ? 'border-[var(--color-accent)] bg-[var(--color-surface-active)]'
                    : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-surface-active)]/60'
                }`}
              >
                <span className={`text-sm font-medium ${isSelected ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>
                  {isSelected && <Check size={13} className="mr-1 inline" />}{option.label}
                </span>
                {option.description && <span className="text-xs leading-4 text-[var(--color-text-muted)]">{option.description}</span>}
              </button>
            )
          })}
        </div>
      )}

      {question.allowFreeText && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'question.freeInputLabel')}</p>
          <textarea
            data-question-free-text
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            rows={2}
            className="w-full resize-none rounded-md bg-[var(--color-bg)] px-3 py-2 text-sm leading-5 text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void submit(true)}
          disabled={responding}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-bg)] disabled:cursor-wait disabled:opacity-50"
        >
          <X size={13} />
          {t(language, 'question.skip')}
        </button>
        <button
          type="button"
          data-question-submit
          onClick={() => void submit(false)}
          disabled={responding || !canSubmit}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-wait disabled:opacity-50"
        >
          <Send size={13} />
          {t(language, 'question.submit')}
        </button>
      </div>
    </div>
  )
}
