#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateGate5AuditReport } from '../src/main/gate5-audit.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const sourceRoot = resolve(args.find((arg) => !arg.startsWith('--')) ?? root)
const outputPath = resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) ?? join(sourceRoot, '.qa', 'gate5-audit-report.json'))
const report = generateGate5AuditReport(sourceRoot)
mkdirSync(resolve(outputPath, '..'), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ outputPath, sourceRoot, status: report.status, artifactCount: report.artifactCount, section23: report.section23 }, null, 2))
if (args.includes('--strict') && report.status !== 'pass') process.exitCode = 1
