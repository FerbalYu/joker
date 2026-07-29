import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const roots = ['src', 'electron.vite.config.ts', 'postcss.config.cjs']
const extensions = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.html', '.css'])
const forbiddenMarkers = ['<<<<<<<', '=======', '>>>>>>>']
const failures = []

function filesUnder(path) {
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') return []
    return filesUnder(join(path, entry.name))
  })
}

for (const root of roots) {
  for (const file of filesUnder(root)) {
    if (!extensions.has(file.slice(file.lastIndexOf('.')))) continue
    const content = readFileSync(file, 'utf8')
    const name = relative(process.cwd(), file)
    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (/\s+$/.test(line)) failures.push(`${name}:${index + 1}: trailing whitespace`)
      if (forbiddenMarkers.some((marker) => line.startsWith(marker))) {
        failures.push(`${name}:${index + 1}: merge-conflict marker`)
      }
    })
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Minimal source hygiene lint passed.')
}
