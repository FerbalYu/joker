import type { SkillDescriptor } from '@shared/types'

export interface SlashToken {
  start: number
  end: number
  query: string
}

export function findSlashToken(text: string, caret: number): SlashToken | null {
  const beforeCaret = text.slice(0, caret)
  const match = /(?:^|\s)\/([A-Za-z0-9._-]*)$/.exec(beforeCaret)
  if (!match || match.index < 0) return null
  const start = match.index + match[0].length - match[1].length - 1
  return { start, end: caret, query: match[1] }
}

export function filterSkills(skills: readonly SkillDescriptor[], query: string): SkillDescriptor[] {
  const normalized = query.trim().toLowerCase()
  return skills.filter((skill) => {
    if (!normalized) return true
    return [skill.id, skill.name, skill.description].some((value) => value.toLowerCase().includes(normalized))
  })
}
