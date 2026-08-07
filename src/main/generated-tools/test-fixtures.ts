import { dirname, join, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import type {
  RuntimeQualificationCandidateResult,
  RuntimeQualificationEnvironmentResult,
  RuntimeQualificationLevel,
  RuntimeQualificationReport
} from '../../shared/generated-tools'
import {
  MANDATORY_QUALIFICATION_CASES,
  PACKAGED_EQUIVALENCE_CASE,
  getQualificationPath,
  runtimeQualificationFileIdentity,
  writeRuntimeQualificationReport
} from './qualification'

function environment(
  name: 'dev' | 'packaged',
  status: RuntimeQualificationEnvironmentResult['status']
): RuntimeQualificationEnvironmentResult {
  return { environment: name, status, startedAt: 1, finishedAt: 2 }
}

function candidate(
  env: RuntimeQualificationCandidateResult['env']
): RuntimeQualificationCandidateResult {
  const ids: RuntimeQualificationReport['candidates'][number]['cases'][number]['id'][] = [...MANDATORY_QUALIFICATION_CASES]
  if (env === 'packaged') ids.push(PACKAGED_EQUIVALENCE_CASE)
  return {
    candidate: 'quickjs-wasm',
    env,
    passesIsolation: true,
    cases: ids.map((id) => ({
      id,
      status: 'pass' as const,
      details: `${env} ${id} passed`
    }))
  }
}

function writeIdentityFile(root: string, path: string, contents: string): ReturnType<typeof runtimeQualificationFileIdentity> {
  const target = join(root, ...path.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, 'utf8')
  return runtimeQualificationFileIdentity(target, root)
}

export function installRuntimeQualificationFixture(
  jokerHome: string,
  level: Exclude<RuntimeQualificationLevel, 'L0'> = 'L2'
): RuntimeQualificationReport {
  const dev = candidate('dev')
  const candidates: RuntimeQualificationCandidateResult[] = [dev]
  if (level === 'L2') candidates.push(candidate('packaged'))
  const root = dirname(getQualificationPath(jokerHome))
  const projectRoot = resolve(process.cwd())
  const quickjsPackagePath = join(projectRoot, 'node_modules', 'quickjs-emscripten', 'package.json')
  const quickjsVersion = (JSON.parse(readFileSync(quickjsPackagePath, 'utf8')) as { version: string }).version
  const bundle = writeIdentityFile(root, 'artifacts/out/main/index.js', 'fixture-bundle')
  const worker = writeIdentityFile(root, 'artifacts/out/main/generated-tool-worker.js', 'fixture-worker')
  const quickjsPackage = { ...writeIdentityFile(root, 'artifacts/node_modules/quickjs-emscripten/package.json', JSON.stringify({ version: quickjsVersion })), version: quickjsVersion }
  const packageLock = writeIdentityFile(root, 'artifacts/package-lock.json', 'fixture-lock')
  const packaged = level === 'L2' ? {
    executable: writeIdentityFile(root, 'artifacts/dist/win-unpacked/JOKER.exe', 'fixture-executable'),
    appAsar: writeIdentityFile(root, 'artifacts/dist/win-unpacked/resources/app.asar', 'fixture-asar')
  } : undefined
  for (const entry of candidates) {
    entry.cases = entry.cases.map((item) => {
      const evidencePath = `evidence/${entry.env}-${item.id}.json`
      const evidence = writeIdentityFile(root, evidencePath, JSON.stringify({ id: item.id }))
      return { ...item, evidence }
    })
  }
  const report: RuntimeQualificationReport = {
    schemaVersion: 2,
    generatedAt: 3,
    level,
    artifactIdentity: { bundle, worker, quickjsPackage, packageLock, ...(packaged ? { packaged } : {}) },
    environments: {
      dev: environment('dev', 'passed'),
      packaged: environment('packaged', level === 'L2' ? 'passed' : 'incomplete')
    },
    candidates,
    limitations: level === 'L1' ? ['Packaged runtime is not qualified'] : []
  }
  writeRuntimeQualificationReport(report, jokerHome)
  return report
}
