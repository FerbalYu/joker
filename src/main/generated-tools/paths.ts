import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function assertToolForgeId(value: string, label = 'id'): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`Invalid ToolForge ${label}`)
  return value
}

export function toRootRelativePath(root: string, target: string): string {
  const absoluteRoot = resolve(root)
  const absoluteTarget = resolve(target)
  const rel = relative(absoluteRoot, absoluteTarget)
  if (!rel || rel === '.' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('ToolForge path must be a non-root path inside the generated-tools root')
  }
  return rel.split(sep).join('/')
}

export function resolveRootRelativePath(root: string, rootRelativePath: string): string {
  if (!rootRelativePath || rootRelativePath.includes('\\') || rootRelativePath.startsWith('/') || /^[A-Za-z]:/.test(rootRelativePath)) {
    throw new Error('ToolForge path must be root-relative with forward slashes')
  }
  const segments = rootRelativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Unsafe ToolForge path')
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, ...segments)
  const rel = relative(absoluteRoot, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('ToolForge path escapes its root')
  return target
}

export function assertPathHasNoSymlink(root: string, target: string, allowMissingLeaf = false): void {
  const absoluteRoot = resolve(root)
  const rootStat = lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('ToolForge root must be a real directory')
  const absoluteTarget = resolve(target)
  const rel = relative(absoluteRoot, absoluteTarget)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('ToolForge path escapes its root')
  let current = absoluteRoot
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`ToolForge path contains a symlink: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf) return
      throw error
    }
  }
  const realRoot = realpathSync.native(absoluteRoot)
  const realTarget = realpathSync.native(absoluteTarget)
  const realRel = relative(realRoot, realTarget)
  if (realRel.startsWith(`..${sep}`) || realRel === '..' || isAbsolute(realRel)) throw new Error('ToolForge real path escapes its root')
}
