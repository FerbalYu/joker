import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIMES = ['document-extract-runtime', 'browser-inspect-runtime', 'sandbox-runtime'] as const

type HostRuntimeName = typeof RUNTIMES[number]

function runtimeScript(name: HostRuntimeName): string | null {
  const built = fileURLToPath(new URL(`./${name}.js`, import.meta.url))
  if (existsSync(built)) return built
  return null
}

/**
 * Materializes small launchers outside generated artifacts and prepends them to
 * PATH. Generated tools may only name an allowlisted host runtime; the launcher
 * uses Electron's Node mode and an absolute, application-owned implementation.
 */
export function hostRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scripts = RUNTIMES.flatMap((name) => {
    const script = runtimeScript(name)
    return script ? [{ name, script }] : []
  })
  if (scripts.length === 0) return environment
  const bin = join(dirname(scripts[0].script), 'host-runtime-bin')
  mkdirSync(bin, { recursive: true })
  for (const { name, script } of scripts) {
    const launcher = join(bin, `${name}.cmd`)
    const body = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" %*\r\n`
    writeFileSync(launcher, body, 'utf8')
  }
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existing = environment[pathKey] ?? environment.PATH ?? process.env[pathKey] ?? process.env.PATH ?? ''
  return { ...environment, [pathKey]: `${bin}${process.platform === 'win32' ? ';' : ':'}${existing}` }
}
