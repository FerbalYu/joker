import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CordisRuntime } from '../runtime/cordis'
import { createGeneratedToolsCordisPlugin } from './cordis-plugin'
import { getCordisForgeController, getCordisPromotionService, getCordisContinuationScheduler, getCordisQualificationService } from './cordis-runtime'
import { getDefaultForgeController, getDefaultPromotionService } from './forge-service-runtime'
import { getDefaultContinuationScheduler } from './continuation-scheduler-runtime'
import { getDefaultRuntimeQualificationService } from './runtime-qualification-service-runtime'

void test('Generated Tools are assembled once and driven by Cordis-owned services', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joker-cordis-generated-tools-'))
  const runtime = new CordisRuntime()
  try {
    const plugin = createGeneratedToolsCordisPlugin({ jokerHome: home })
    await runtime.use(plugin)
    await runtime.start()

    assert.ok(plugin.services?.forge)
    assert.equal(getCordisForgeController(), plugin.services?.forge)
    assert.equal(getCordisPromotionService(), plugin.services?.promotion)
    assert.equal(getCordisContinuationScheduler(), plugin.services?.continuation)
    assert.equal(getCordisQualificationService(), plugin.services?.qualification)
    assert.equal(getDefaultForgeController(), plugin.services?.forge)
    assert.equal(getDefaultPromotionService(), plugin.services?.promotion)
    assert.equal(getDefaultContinuationScheduler(), plugin.services?.continuation)
    assert.equal(getDefaultRuntimeQualificationService(), plugin.services?.qualification)
    assert.ok(plugin.services?.events)
    assert.ok(plugin.services?.trace)
  } finally {
    await runtime.stop()
    await rm(home, { recursive: true, force: true })
  }

  assert.equal(getCordisForgeController(), undefined)
  assert.equal(getCordisPromotionService(), undefined)
  assert.equal(getDefaultForgeController(), undefined)
})
