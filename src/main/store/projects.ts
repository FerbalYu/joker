import { basename, dirname, join, normalize, resolve, sep } from 'node:path'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type { ProjectEntry, ProjectState } from '../../shared/types'
import { getJokerHomeDir } from './paths'

const MAX_PROJECTS = 32
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/

function getDataDir(): string {
  return join(getJokerHomeDir(), '.joker')
}

export function getProjectsPath(): string {
  return join(getDataDir(), 'projects.json')
}

function normalizePathForComparison(value: string): string {
  const normalized = normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function canonicalizeProjectPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null
  const candidate = resolve(value)
  try {
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return null
    return realpathSync.native(candidate)
  } catch {
    return null
  }
}

function isValidProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
}

function normalizeProject(value: unknown): ProjectEntry | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ProjectEntry>
  const path = canonicalizeProjectPath(candidate.path)
  if (!path || !isValidProjectId(candidate.id)) return null
  const name = typeof candidate.name === 'string' && candidate.name.trim()
    ? candidate.name.trim().slice(0, 120)
    : basename(path)
  const lastUsedAt = typeof candidate.lastUsedAt === 'number' && Number.isFinite(candidate.lastUsedAt)
    ? candidate.lastUsedAt
    : 0
  return { id: candidate.id, name, path, lastUsedAt }
}

export function normalizeProjectState(raw: unknown): ProjectState {
  if (!raw || typeof raw !== 'object') return { projects: [], activeProjectId: null }
  const value = raw as Partial<ProjectState>
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  const projects = (Array.isArray(value.projects) ? value.projects : [])
    .map(normalizeProject)
    .filter((project): project is ProjectEntry => {
      if (!project) return false
      const pathKey = normalizePathForComparison(project.path)
      if (seenIds.has(project.id) || seenPaths.has(pathKey)) return false
      seenIds.add(project.id)
      seenPaths.add(pathKey)
      return true
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_PROJECTS)

  const activeProjectId = typeof value.activeProjectId === 'string' && projects.some((project) => project.id === value.activeProjectId)
    ? value.activeProjectId
    : projects[0]?.id ?? null
  return { projects, activeProjectId }
}

function ensureDataDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function loadProjectState(): ProjectState {
  let state: ProjectState
  const path = getProjectsPath()
  if (!existsSync(path)) {
    state = { projects: [], activeProjectId: null }
  } else {
    try {
      state = normalizeProjectState(JSON.parse(readFileSync(path, 'utf-8')))
    } catch {
      state = { projects: [], activeProjectId: null }
    }
  }

  return state
}

export function saveProjectState(state: ProjectState): void {
  ensureDataDir()
  writeFileSync(getProjectsPath(), JSON.stringify(normalizeProjectState(state), null, 2), 'utf-8')
}

export function addProject(projectPath: string): ProjectState {
  const canonical = canonicalizeProjectPath(projectPath)
  if (!canonical) throw new Error('Selected path is not an existing folder')
  const state = loadProjectState()
  const existing = state.projects.find((project) => normalizePathForComparison(project.path) === normalizePathForComparison(canonical))
  const now = Date.now()
  const project = existing
    ? { ...existing, lastUsedAt: now }
    : { id: crypto.randomUUID(), name: basename(canonical) || dirname(canonical), path: canonical, lastUsedAt: now }
  const projects = [project, ...state.projects.filter((item) => item.id !== project.id)].slice(0, MAX_PROJECTS)
  const next = { projects, activeProjectId: project.id }
  saveProjectState(next)
  return next
}

export function selectProject(projectId: string): ProjectState {
  const state = loadProjectState()
  if (!isValidProjectId(projectId)) throw new Error('Invalid project')
  const selected = state.projects.find((project) => project.id === projectId)
  if (!selected) throw new Error('Project not found')
  const canonical = canonicalizeProjectPath(selected.path)
  if (!canonical) throw new Error('Project folder is no longer available')
  const next: ProjectState = {
    projects: state.projects.map((project) => project.id === projectId ? { ...project, path: canonical, lastUsedAt: Date.now() } : project),
    activeProjectId: projectId
  }
  saveProjectState(next)
  return next
}

export function resolveProjectPath(projectId: string): string | null {
  const state = loadProjectState()
  if (!isValidProjectId(projectId)) return null
  const selected = state.projects.find((project) => project.id === projectId)
  return selected ? canonicalizeProjectPath(selected.path) : null
}

export function isPathInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const root = normalizePathForComparison(resolve(workspacePath))
  const target = normalizePathForComparison(resolve(targetPath))
  return target === root || target.startsWith(`${root}${sep}`)
}

export function resolveWorkspacePath(workspacePath: string, targetPath: string, allowMissingTarget = false): string {
  const root = realpathSync.native(workspacePath)
  const absoluteTarget = isAbsolutePath(targetPath) ? targetPath : join(root, targetPath)
  const resolvedTarget = resolve(absoluteTarget)
  const targetExists = existsSync(resolvedTarget)
  if (!targetExists && !allowMissingTarget) throw new Error(`Path does not exist: ${targetPath}`)
  const canonicalTarget = targetExists
    ? realpathSync.native(resolvedTarget)
    : resolveMissingPath(resolvedTarget)
  if (!isPathInsideWorkspace(root, canonicalTarget)) throw new Error(`Path outside workspace: ${targetPath}`)
  return canonicalTarget
}

export function resolveWorkspacePathForSearch(workspacePath: string, targetPath: string): string {
  return resolveWorkspacePath(workspacePath, targetPath)
}

export function isWorkspaceEntryDirectory(root: string, entryPath: string): boolean {
  if (lstatSync(entryPath).isSymbolicLink()) return false
  return statSync(entryPath).isDirectory() && isPathInsideWorkspace(root, realpathSync.native(entryPath))
}

function resolveMissingPath(path: string): string {
  const parent = dirname(path)
  if (parent === path) return path
  const canonicalParent = existsSync(parent) ? realpathSync.native(parent) : resolveMissingPath(parent)
  return join(canonicalParent, basename(path))
}

function isAbsolutePath(value: string): boolean {
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/')
}

export { MAX_PROJECTS }
