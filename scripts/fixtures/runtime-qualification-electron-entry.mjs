// Electron packaged-environment entry for the runtime qualification suite
// (TOOL-FORGE-PLAN.md §8.2, "Windows 打包产物中行为与开发环境一致").
//
// The main qualification script spawns electron.exe with this entry; it runs
// the same pure-.mjs suite under the Electron main-process runtime and writes
// the raw packaged-env matrix. Console output of a GUI app does not reach
// pipes reliably, so completion is signaled by the report file itself; any
// crash is written to <runDir>/electron-crash.log.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runQualificationSuite } from './runtime-qualification-suite.mjs'

const runDir = process.env['JOKER_QUALIFICATION_RUN_DIR']
const workspacePath = process.env['JOKER_QUALIFICATION_WORKSPACE']

function crash(error) {
  try {
    writeFileSync(
      join(runDir ?? '.', 'electron-crash.log'),
      String(error && error.stack ? error.stack : error),
      'utf-8'
    )
  } catch {
    /* best effort */
  }
  process.exit(1)
}

process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

if (!runDir || !workspacePath) {
  console.error('JOKER_QUALIFICATION_ERROR missing JOKER_QUALIFICATION_RUN_DIR/JOKER_QUALIFICATION_WORKSPACE')
  process.exit(1)
}

try {
  const evidenceDir = join(runDir, 'evidence-packaged')
  mkdirSync(evidenceDir, { recursive: true })
  const result = await runQualificationSuite({ env: 'packaged', runDir, workspacePath, evidenceDir })
  const reportPath = join(runDir, 'runtime-qualification-packaged.json')
  writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8')
  console.log('JOKER_QUALIFICATION_DONE ' + reportPath)
  process.exit(0)
} catch (e) {
  crash(e)
}
