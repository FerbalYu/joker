import { join } from 'node:path'
import { discoverSkills } from './loader'
import type { ParsedSkill } from './types'
import { loadConfig, saveConfig } from '../store/config'
import type { SkillDescriptor } from '../../shared/types'
import { getJokerHomeDir } from '../store/paths'

class SkillRegistry {
  private skills = new Map<string, ParsedSkill>()

  reload(): void {
    const builtin = discoverSkills(join(process.cwd(), 'skills'), 'builtin')
    const external = discoverSkills(join(process.env['USERPROFILE'] ?? getJokerHomeDir(), '.agents', 'skills'), 'external')
    const user = discoverSkills(join(getJokerHomeDir(), '.joker', 'skills'), 'user')
    this.skills.clear()
    for (const skill of [...builtin, ...external, ...user]) {
      if (!this.skills.has(skill.id) || skill.source === 'external' || skill.source === 'user') this.skills.set(skill.id, skill)
    }
  }

  list(): SkillDescriptor[] {
    const disabled = new Set(loadConfig().disabledSkills ?? [])
    return [...this.skills.values()].map(({ path: _path, ...skill }) => ({ ...skill, enabled: !disabled.has(skill.id) }))
  }

  getActive(): ParsedSkill[] {
    const disabled = new Set(loadConfig().disabledSkills ?? [])
    return [...this.skills.values()].filter((skill) => !disabled.has(skill.id) && skill.trusted)
  }

  getInvokableByIds(ids: readonly string[]): ParsedSkill[] {
    const requested = new Set(ids)
    const disabled = new Set(loadConfig().disabledSkills ?? [])
    return [...this.skills.values()].filter((skill) => requested.has(skill.id) && !disabled.has(skill.id) && skill.trusted)
  }

  setEnabled(id: string, enabled: boolean): boolean {
    if (!this.skills.has(id)) return false
    const config = loadConfig()
    const disabled = new Set(config.disabledSkills ?? [])
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    saveConfig({ ...config, disabledSkills: [...disabled] })
    return true
  }
}

export const skillRegistry = new SkillRegistry()
skillRegistry.reload()
