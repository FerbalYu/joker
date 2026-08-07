import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ParsedSkill } from './types'

const MAX_SKILL_BYTES = 128 * 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
type SkillSource = 'builtin' | 'user' | 'external'

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) throw new Error('Skill must start with frontmatter')
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) throw new Error('Skill frontmatter is not closed')
  const fields: Record<string, string> = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { fields, body: normalized.slice(end + 4).trim() }
}

export function parseSkillFile(path: string, source: SkillSource, fallbackId?: string): ParsedSkill {
  const raw = readFileSync(path, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) throw new Error('Skill file is too large')
  const { fields, body } = parseFrontmatter(raw)
  const id = fields.id ?? fallbackId ?? ''
  const name = fields.name ?? id
  const description = fields.description ?? ''
  if (!ID_PATTERN.test(id)) throw new Error('Invalid skill id')
  if (!name || !description || !body) throw new Error('Skill requires id, name, description, and instructions')
  const allowedMcpTools = (fields.allowedMcpTools ?? '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 100)
  const fingerprint = createHash('sha256').update(source).update('\0').update(id).update('\0').update(raw).digest('hex')
  return {
    id,
    name: name.slice(0, 120),
    description: description.slice(0, 500),
    version: fields.version?.slice(0, 40),
    source,
    instructions: body,
    allowedMcpTools,
    enabled: false,
    trusted: false,
    fingerprint,
    trustState: 'untrusted',
    path
  }
}

export function discoverSkills(root: string, source: SkillSource): ParsedSkill[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root)
  const skills: ParsedSkill[] = []
  for (const entry of entries) {
    const directory = join(root, entry)
    if (!statSync(directory).isDirectory()) continue
    const path = join(directory, 'SKILL.md')
    if (!existsSync(path)) continue
    try {
      skills.push(parseSkillFile(path, source, source === 'external' ? basename(directory) : undefined))
    } catch {
      // Invalid skills are omitted from the active registry.
    }
  }
  return skills
}
