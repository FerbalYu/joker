import type { SkillDescriptor } from '@shared/types'
import type { SlashToken } from './slash'

export const MAX_SELECTED_SLASH_SKILLS = 16

export type NativeSlashCommandId = 'goal' | 'plan' | 'compact'
export type SlashCommandSection = 'commands' | 'skills'
export type SlashCommandAction = 'select-native' | 'select-skill'

export interface SlashCommandItem {
  id: string
  section: SlashCommandSection
  action: SlashCommandAction
  label: string
  description?: string
  meta?: string
  keywords?: string[]
  nativeCommand?: NativeSlashCommandId
  value?: string
  disabled?: boolean
  disabledReason?: string
}

export interface SlashInsertion {
  text: string
  caret: number
  token: SlashToken
}

export type GoalSlashAction = 'inspect' | 'create' | 'replace' | 'pause' | 'resume' | 'clear'

export interface GoalCommandMatch {
  command: 'goal'
  action: GoalSlashAction
  argument: string
}

export type NativeCommandMatch =
  | GoalCommandMatch
  | { command: 'plan' | 'compact'; argument: string }

export function insertSlashToken(text: string, selectionStart: number, selectionEnd: number): SlashInsertion {
  const start = clamp(selectionStart, 0, text.length)
  const end = clamp(selectionEnd, start, text.length)
  const before = text.slice(0, start)
  const insertion = before.length === 0 || /\s$/.test(before) ? '/' : ' /'
  const nextText = before + insertion + text.slice(end)
  const caret = start + insertion.length
  return {
    text: nextText,
    caret,
    token: { start: caret - 1, end: caret, query: '' }
  }
}

export function removeSlashToken(text: string, token: SlashToken): { text: string; caret: number } {
  const start = clamp(token.start, 0, text.length)
  const end = clamp(token.end, start, text.length)
  return {
    text: text.slice(0, start) + text.slice(end),
    caret: start
  }
}

export function parseNativeSlashCommand(text: string): NativeCommandMatch | null {
  const match = /^\s*\/(goal|plan|compact)(?:\s+([\s\S]*))?\s*$/.exec(text)
  if (!match) return null
  const command = match[1] as NativeSlashCommandId
  const argument = (match[2] ?? '').trim()
  if (command !== 'goal') return { command, argument }
  if (!argument) return { command: 'goal', action: 'inspect', argument: '' }

  const subcommand = /^(replace|pause|resume|clear)(?:\s+([\s\S]*))?$/.exec(argument)
  if (!subcommand) return { command: 'goal', action: 'create', argument }
  const action = subcommand[1] as Exclude<GoalSlashAction, 'inspect' | 'create'>
  const actionArgument = (subcommand[2] ?? '').trim()
  if (action === 'replace') {
    return actionArgument
      ? { command: 'goal', action, argument: actionArgument }
      : null
  }
  return actionArgument
    ? null
    : { command: 'goal', action, argument: '' }
}

export function filterSlashCommands(items: readonly SlashCommandItem[], query: string): SlashCommandItem[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...items]
  return items.filter((item) => [
    item.label,
    item.description ?? '',
    item.meta ?? '',
    item.value ?? '',
    ...(item.keywords ?? [])
  ].some((value) => value.toLowerCase().includes(normalized)))
}

export function nativeCommandItems(options: {
  labels: Record<NativeSlashCommandId, { description: string }>
  unavailableReason: string
  busyReason: string
  goalAvailable: boolean
  planAvailable: boolean
  compactAvailable: boolean
  busy: boolean
}): SlashCommandItem[] {
  const availability: Record<NativeSlashCommandId, boolean> = {
    goal: options.goalAvailable,
    plan: options.planAvailable,
    compact: options.compactAvailable
  }
  return (['goal', 'plan', 'compact'] as const).map((command) => {
    const disabledReason = options.busy
      ? options.busyReason
      : availability[command]
        ? undefined
        : options.unavailableReason
    return {
      id: `native:${command}`,
      section: 'commands',
      action: 'select-native',
      nativeCommand: command,
      label: `/${command}`,
      description: options.labels[command].description,
      keywords: [command],
      disabled: Boolean(disabledReason),
      disabledReason
    }
  })
}

export function skillCommandItems(
  skills: readonly SkillDescriptor[],
  selectedSkillIds: readonly string[],
  labels: { limitReached: string; disabled: string; changed: string }
): SlashCommandItem[] {
  const selected = new Set(selectedSkillIds)
  const limitReached = selected.size >= MAX_SELECTED_SLASH_SKILLS
  return skills
    .filter((skill) => !selected.has(skill.id))
    .map((skill) => {
      const disabledReason = skill.trustState === 'changed'
        ? labels.changed
        : !skill.enabled
          ? labels.disabled
          : limitReached
            ? labels.limitReached
            : undefined
      return {
        id: `skill:${skill.id}`,
        section: 'skills' as const,
        action: 'select-skill' as const,
        label: `/${skill.id}`,
        description: skill.description,
        meta: skill.source,
        keywords: [skill.id, skill.name, skill.description],
        value: skill.id,
        disabled: Boolean(disabledReason),
        disabledReason
      }
    })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
