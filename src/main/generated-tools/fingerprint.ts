import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GeneratedToolManifest } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolManifest } from '../../shared/generated-tools-schema'
import { assertPathHasNoSymlink, resolveRootRelativePath } from './paths'

export interface GeneratedToolArtifactFingerprint {
  fingerprint: string
  manifestHash: string
  sourceHash: string
  distHash: string
  manifest: GeneratedToolManifest
}

function writeLength(hash: ReturnType<typeof createHash>, length: number): void {
  const bytes = Buffer.allocUnsafe(8)
  bytes.writeBigUInt64BE(BigInt(length))
  hash.update(bytes)
}

function writeField(hash: ReturnType<typeof createHash>, domain: string, value: Buffer): void {
  const domainBytes = Buffer.from(domain, 'utf8')
  writeLength(hash, domainBytes.length)
  hash.update(domainBytes)
  writeLength(hash, value.length)
  hash.update(value)
}

function foldPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US')
}

export function assertCaseFoldUniqueArtifactPaths(paths: string[]): void {
  const foldedPaths = new Map<string, string>()
  for (const path of paths) {
    const folded = foldPath(path)
    const existing = foldedPaths.get(folded)
    if (existing) throw new Error(`Case-folded duplicate artifact paths: ${existing} and ${path}`)
    foldedPaths.set(folded, path)
  }
}

function hashTree(root: string, directory: string, domain: 'source' | 'dist'): string {
  assertPathHasNoSymlink(root, directory)
  if (!lstatSync(directory).isDirectory()) throw new Error(`ToolForge artifact tree is not a directory: ${directory}`)
  const files: Array<{ path: string; bytes: Buffer }> = []
  const logicalPaths: string[] = []

  const visit = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
    for (const entry of entries) {
      const path = join(current, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      logicalPaths.push(relativePath)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Generated Tool artifact contains a symlink: ${relativePath}`)
      if (stat.isDirectory()) visit(path, relativePath)
      else if (stat.isFile()) files.push({ path: relativePath, bytes: readFileSync(path) })
      else throw new Error(`Unsupported Generated Tool artifact entry: ${relativePath}`)
    }
  }

  visit(directory, '')
  assertCaseFoldUniqueArtifactPaths(logicalPaths)
  files.sort((left, right) => left.path.localeCompare(right.path, 'en-US'))
  const hash = createHash('sha256')
  writeField(hash, 'toolforge-tree-domain', Buffer.from(domain, 'utf8'))
  for (const file of files) {
    writeField(hash, 'logical-path', Buffer.from(file.path, 'utf8'))
    writeField(hash, 'raw-bytes', file.bytes)
  }
  return hash.digest('hex')
}

export function fingerprintGeneratedToolArtifact(
  generatedToolsRoot: string,
  artifactRootRelativePath: string
): GeneratedToolArtifactFingerprint {
  const artifactRoot = resolveRootRelativePath(generatedToolsRoot, artifactRootRelativePath)
  assertPathHasNoSymlink(generatedToolsRoot, artifactRoot)
  const manifestPath = join(artifactRoot, 'manifest.json')
  assertPathHasNoSymlink(generatedToolsRoot, manifestPath)
  const manifest = parseGeneratedToolManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const manifestHashState = createHash('sha256')
  writeField(manifestHashState, 'toolforge-manifest-v1', Buffer.from(canonicalGeneratedToolJson(manifest), 'utf8'))
  const manifestHash = manifestHashState.digest('hex')
  const sourceHash = hashTree(generatedToolsRoot, join(artifactRoot, 'source'), 'source')
  const distHash = hashTree(generatedToolsRoot, join(artifactRoot, 'dist'), 'dist')
  const hash = createHash('sha256')
  writeField(hash, 'toolforge-bundle-version', Buffer.from('1', 'utf8'))
  writeField(hash, 'manifest-sha256', Buffer.from(manifestHash, 'hex'))
  writeField(hash, 'source-sha256', Buffer.from(sourceHash, 'hex'))
  writeField(hash, 'dist-sha256', Buffer.from(distHash, 'hex'))
  const fingerprint = hash.digest('hex')
  return { fingerprint, manifestHash, sourceHash, distHash, manifest }
}
