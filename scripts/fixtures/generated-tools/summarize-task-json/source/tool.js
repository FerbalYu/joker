// SummarizeTaskJson — fixed read-only sample tool (TOOL-FORGE-PLAN.md §21).
//
// Runs inside the qualified runtime. The ONLY host surface is the broker:
//   tool.readFile(relPath) -> file content (workspace-relative, enforced by host)
//   tool.output(text)      -> final textual result
//
// Constraints: plain ES2020, no imports, no host globals, synchronous. This
// file is a frozen fixture of the P0 vertical slice; the runtime qualification
// suite executes it verbatim in every candidate runner.

function summarize(tasks) {
  const counts = {}
  for (const task of tasks) {
    const key = task && task.status ? String(task.status) : 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => k + ': ' + counts[k])
    .join('\n')
}

let result = ''
try {
  const raw = tool.readFile('fixtures/tasks.json')
  const rows = JSON.parse(raw)
  if (!(rows instanceof Array)) {
    result = 'ERROR: fixtures/tasks.json does not contain an array'
  } else {
    result = summarize(rows)
  }
} catch (e) {
  result = 'ERROR: ' + (e && e.message ? e.message : String(e))
}
tool.output(result)
