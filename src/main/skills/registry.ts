import { join } from 'node:path'
import { discoverSkills } from './loader'
import type { ParsedSkill } from './types'
import { loadConfig, saveConfig } from '../store/config'
import type { AppConfig, SkillDescriptor, SkillTrustState } from '../../shared/types'
import { getJokerHomeDir } from '../store/paths'

interface SkillRegistryOptions {
  loadConfig: () => AppConfig
  saveConfig: (config: AppConfig) => void
  roots: () => { builtin: string; external: string; user: string }
}

const defaultOptions: SkillRegistryOptions = {
  loadConfig,
  saveConfig,
  roots: () => ({
    builtin: join(process.cwd(), 'skills'),
    external: join(process.env['USERPROFILE'] ?? getJokerHomeDir(), '.agents', 'skills'),
    user: join(getJokerHomeDir(), '.joker', 'skills')
  })
}

export class SkillRegistry {
  private skills = new Map<string, ParsedSkill>()

  constructor(private readonly options: SkillRegistryOptions = defaultOptions) {}

  reload(): void {
    const roots = this.options.roots()
    const builtin = discoverSkills(roots.builtin, 'builtin')
    const external = discoverSkills(roots.external, 'external')
    const user = discoverSkills(roots.user, 'user')
    this.skills.clear()
    for (const skill of [...builtin, ...external, ...user]) {
      if (!this.skills.has(skill.id) || skill.source === 'external' || skill.source === 'user') this.skills.set(skill.id, skill)
    }
  }

  list(): SkillDescriptor[] {
    this.reload()
    const config = this.options.loadConfig()
    return [...this.skills.values()].map((skill) => this.toDescriptor(skill, config))
  }

  getActive(): ParsedSkill[] {
    this.reload()
    const config = this.options.loadConfig()
    return [...this.skills.values()]
      .map((skill) => this.applyConfig(skill, config))
      .filter((skill) => skill.enabled)
  }

  getInvokableByIds(ids: readonly string[]): ParsedSkill[] {
    this.reload()
    const requested = new Set(ids)
    const config = this.options.loadConfig()
    return [...this.skills.values()]
      .filter((skill) => requested.has(skill.id))
      .map((skill) => this.applyConfig(skill, config))
      .filter((skill) => skill.enabled)
  }

  setEnabled(id: string, enabled: boolean): SkillDescriptor {
    this.reload()
    const skill = this.requireSkill(id)
    const config = this.options.loadConfig()
    const trustedSkills = (config.trustedSkills ?? []).filter((record) => record.id !== id)
    if (enabled) trustedSkills.push({ id, fingerprint: skill.fingerprint })
    const updated = { ...config, trustedSkills, skillStateVersion: 1 as const }
    this.options.saveConfig(updated)
    return this.toDescriptor(skill, updated)
  }

  trust(id: string): SkillDescriptor {
    return this.setEnabled(id, true)
  }

  revokeTrust(id: string): SkillDescriptor {
    return this.setEnabled(id, false)
  }

  private requireSkill(id: string): ParsedSkill {
    if (typeof id !== 'string' || !id) throw new Error('Invalid Skill id')
    const skill = this.skills.get(id)
    if (!skill) throw new Error(`Skill not found: ${id}`)
    return skill
  }

  private trustState(skill: ParsedSkill, config: AppConfig): SkillTrustState {
    const record = (config.trustedSkills ?? []).find((candidate) => candidate.id === skill.id)
    if (!record) return 'untrusted'
    return record.fingerprint === skill.fingerprint ? 'trusted' : 'changed'
  }

  private applyConfig(skill: ParsedSkill, config: AppConfig): ParsedSkill {
    const trustState = this.trustState(skill, config)
    const enabled = trustState === 'trusted'
    return {
      ...skill,
      enabled,
      trusted: enabled,
      trustState
    }
  }

  private toDescriptor(skill: ParsedSkill, config: AppConfig): SkillDescriptor {
    const { path: _path, ...descriptor } = this.applyConfig(skill, config)
    return descriptor
  }
}

export const skillRegistry = new SkillRegistry()
skillRegistry.reload()
