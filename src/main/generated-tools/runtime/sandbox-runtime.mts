/*
 * Windows isolation is intentionally not emulated with child_process. This
 * host adapter makes capability probing deterministic until an AppContainer /
 * restricted-token backend is packaged. It never executes caller code.
 */
const payload = process.argv.includes('--capabilities')
  ? { backends: [] }
  : { error: { code: 'unsupported_platform', message: 'No approved isolation backend is packaged for this host.' } }
process.stdout.write(JSON.stringify(payload))
process.exitCode = process.argv.includes('--capabilities') ? 0 : 1
