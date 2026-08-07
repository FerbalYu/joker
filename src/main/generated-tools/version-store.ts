import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GeneratedToolVersion } from '../../shared/generated-tools'
import { parseGeneratedToolVersion } from '../../shared/generated-tools-schema'
import { resolveRootRelativePath } from './paths'
import { canonicalVersionPath, generatedToolsRoot } from './store'

export function readGeneratedToolVersion(jokerHome: string, toolId: string, versionId: string): GeneratedToolVersion {
  const root = generatedToolsRoot(jokerHome)
  const artifactPath = canonicalVersionPath(toolId, versionId)
  const version = parseGeneratedToolVersion(JSON.parse(readFileSync(join(resolveRootRelativePath(root, artifactPath), 'version.json'), 'utf8')))
  if (version.toolId !== toolId || version.id !== versionId || version.artifactPath !== artifactPath) {
    throw new Error('Generated Tool version metadata does not match its canonical path')
  }
  return version
}
