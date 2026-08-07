import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { readForgeJob } from './forge-job-store'
import { assertPathHasNoSymlink, assertToolForgeId, resolveRootRelativePath } from './paths'
import { readGeneratedToolVersion } from './version-store'
import { generatedToolsRoot, verifyPublishedGeneratedToolBundle } from './store'

export const MAX_FORGE_FILES = 256
export const MAX_FORGE_TOTAL_BYTES = 16 * 1024 * 1024
export const MAX_FORGE_FILE_BYTES = 1024 * 1024
export const MAX_FORGE_CHECK_OUTPUT_BYTES = 64 * 1024
export const FORGE_ALLOWED_EXTENSIONS = new Set(['.json', '.js', '.mjs', '.ts', '.md', '.txt'])

export interface ForgeWorkspaceEntry {
  path: string
  size: number
}

export interface ForgeCheckResult {
  id: string
  kind: 'artifact-structure'
  status: 'passed' | 'failed'
  message: string
  fingerprint?: string
  manifestHash?: string
  sourceHash?: string
  distHash?: string
}

function assertSafeForgePath(value: string): string[] {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error('Forge path must be job-relative with forward slashes')
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Unsafe Forge path')
  return segments
}

function workspaceRoot(jokerHome: string, job: ForgeJob): string {
  const root = generatedToolsRoot(jokerHome)
  const workspace = resolveRootRelativePath(root, job.artifactPath)
  mkdirSync(workspace, { recursive: true })
  assertPathHasNoSymlink(root, workspace)
  if (!lstatSync(workspace).isDirectory()) throw new Error('Forge workspace is not a directory')
  return workspace
}

function copyTrustedBaseIntoWorkspace(jokerHome: string, job: ForgeJob, workspace: string): void {
  if (job.mode !== 'edit' || !job.baseVersionId) return
  const root = generatedToolsRoot(jokerHome)
  const version = readGeneratedToolVersion(jokerHome, job.toolId, job.baseVersionId)
  if (version.trustState !== 'trusted') throw new Error('Generated Tool edit base version is not trusted')
  if (job.baseFingerprint !== version.fingerprint) throw new Error('Generated Tool edit base fingerprint is stale')
  if (version.manifest.toolId !== job.toolId) throw new Error('Generated Tool edit base version tool id does not match ForgeJob')
  if (version.validationReportId.length === 0) throw new Error('Generated Tool edit base version validation binding is missing')
  verifyPublishedGeneratedToolBundle(root, version)
  const base = resolveRootRelativePath(root, version.artifactPath)
  const entries = readdirSync(base, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'version.json' || entry.name === 'validation-report.json' || entry.name === 'evidence' || entry.name === 'logs') continue
    const source = join(base, entry.name)
    assertPathHasNoSymlink(base, source)
    const destination = join(workspace, entry.name)
    if (existsSync(destination)) continue
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  }
  assertPathHasNoSymlink(root, workspace)
}

function resolveWorkspacePath(root: string, logicalPath: string, allowMissingLeaf = false): string {
  const target = resolve(root, ...assertSafeForgePath(logicalPath))
  const rel = relative(root, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Forge path escapes job workspace')
  assertPathHasNoSymlink(root, target, allowMissingLeaf)
  return target
}

function assertWritableExtension(path: string): void {
  if (!FORGE_ALLOWED_EXTENSIONS.has(extname(path).toLocaleLowerCase('en-US'))) {
    throw new Error('Forge file extension is not allowed')
  }
}

function scanWorkspace(root: string): ForgeWorkspaceEntry[] {
  const entries: ForgeWorkspaceEntry[] = []
  const logicalPaths: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'))) {
      const path = join(directory, entry.name)
      const logicalPath = prefix ? `${prefix}/${entry.name}` : entry.name
      logicalPaths.push(logicalPath.normalize('NFC').toLocaleLowerCase('en-US'))
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Forge workspace contains a symlink: ${logicalPath}`)
      if (stat.isDirectory()) visit(path, logicalPath)
      else if (stat.isFile()) entries.push({ path: logicalPath, size: stat.size })
      else throw new Error(`Unsupported Forge workspace entry: ${logicalPath}`)
    }
  }
  visit(root, '')
  if (new Set(logicalPaths).size !== logicalPaths.length) throw new Error('Forge workspace paths must be case-fold unique')
  if (entries.length > MAX_FORGE_FILES) throw new Error('Forge workspace file count exceeds limit')
  if (entries.some((entry) => entry.size > MAX_FORGE_FILE_BYTES)) throw new Error('Forge workspace file exceeds size limit')
  if (entries.reduce((total, entry) => total + entry.size, 0) > MAX_FORGE_TOTAL_BYTES) throw new Error('Forge workspace exceeds total size limit')
  return entries
}

export class ForgeWorkspaceBroker {
  readonly job: ForgeJob
  readonly root: string

  constructor(readonly jokerHome: string, jobId: string) {
    const job = readForgeJob(jokerHome, assertToolForgeId(jobId, 'job id'))
    if (!job) throw new Error(`ForgeJob not found: ${jobId}`)
    if (job.status !== 'planning' && job.status !== 'building') throw new Error('Forge workspace is writable only while planning or building')
    this.job = job
    this.root = workspaceRoot(jokerHome, job)
    copyTrustedBaseIntoWorkspace(jokerHome, job, this.root)
  }

  readSpec(): ForgeJob['spec'] & {
    forgeJobId: string
    forgeJobRevision: number
    forgeJobStatus: ForgeJob['status']
    forgeJobAttempt: number
  } {
    return {
      ...structuredClone(this.job.spec),
      forgeJobId: this.job.id,
      forgeJobRevision: this.job.revision,
      forgeJobStatus: this.job.status,
      forgeJobAttempt: this.job.attempt
    }
  }

  listFiles(): ForgeWorkspaceEntry[] {
    return scanWorkspace(this.root)
  }

  readFile(path: string): string {
    const target = resolveWorkspacePath(this.root, path)
    const stat = statSync(target)
    if (!stat.isFile()) throw new Error('Forge path is not a file')
    if (stat.size > MAX_FORGE_FILE_BYTES) throw new Error('Forge file exceeds size limit')
    return readFileSync(target, 'utf8')
  }

  writeFile(path: string, content: string): ForgeWorkspaceEntry {
    assertWritableExtension(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FORGE_FILE_BYTES) throw new Error('Forge file exceeds size limit')
    const target = resolveWorkspacePath(this.root, path, true)
    mkdirSync(dirname(target), { recursive: true })
    assertPathHasNoSymlink(this.root, dirname(target))
    const temp = `${target}.forge-${process.pid}.tmp`
    try {
      writeFileSync(temp, content, 'utf8')
      renameSync(temp, target)
    } finally {
      rmSync(temp, { force: true })
    }
    const entries = scanWorkspace(this.root)
    return entries.find((entry) => entry.path === path) ?? { path, size: bytes }
  }

  applyPatch(path: string, expected: string, replacement: string): ForgeWorkspaceEntry {
    const current = this.readFile(path)
    const first = current.indexOf(expected)
    if (first < 0) throw new Error('Forge patch context was not found')
    if (current.indexOf(expected, first + expected.length) >= 0) throw new Error('Forge patch context is not unique')
    return this.writeFile(path, `${current.slice(0, first)}${replacement}${current.slice(first + expected.length)}`)
  }

  runCheck(): ForgeCheckResult {
    try {
      scanWorkspace(this.root)
      const fingerprint = fingerprintGeneratedToolArtifact(generatedToolsRoot(this.jokerHome), this.job.artifactPath)
      if (fingerprint.manifest.toolId !== this.job.toolId) throw new Error('manifest toolId does not match ForgeJob')
      if (canonicalGeneratedToolJson(fingerprint.manifest.permissions) !== canonicalGeneratedToolJson(this.job.spec.permissions)) {
        throw new Error('manifest permissions do not match ForgeJob spec')
      }
      return {
        id: createHash('sha256').update(`${this.job.id}\0${fingerprint.fingerprint}`).digest('hex').slice(0, 32),
        kind: 'artifact-structure',
        status: 'passed',
        message: 'Candidate artifact structure is ready for immutable submission',
        fingerprint: fingerprint.fingerprint,
        manifestHash: fingerprint.manifestHash,
        sourceHash: fingerprint.sourceHash,
        distHash: fingerprint.distHash
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        id: createHash('sha256').update(`${this.job.id}\0${message}`).digest('hex').slice(0, 32),
        kind: 'artifact-structure',
        status: 'failed',
        message: message.slice(0, MAX_FORGE_CHECK_OUTPUT_BYTES)
      }
    }
  }
}
