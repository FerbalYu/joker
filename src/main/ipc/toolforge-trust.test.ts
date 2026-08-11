import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppConfig, ProjectState } from '../../shared/types'
import { normalizeConfig } from '../store/config'
import { getSelectedWorkspaceFullTrustState, updateSelectedWorkspaceFullTrust, type ToolForgeTrustDependencies } from './toolforge-trust-state'

function config(): AppConfig {
  return normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p'
  })
}

void test('ToolForge full-trust state resolves the canonical active workspace only', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'joker-toolforge-trust-ipc-'))
  try {
    const state: ProjectState = {
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'Workspace', path: workspace, lastUsedAt: 1 }]
    }
    const dependencies: ToolForgeTrustDependencies = {
      loadConfig: config,
      saveConfig: () => undefined,
      loadProjectState: () => state,
      resolveProjectPath: (projectId) => projectId === 'project-1' ? workspace : null
    }
    assert.deepEqual(getSelectedWorkspaceFullTrustState(dependencies), {
      success: true,
      data: { projectId: 'project-1', projectName: 'Workspace', workspacePath: workspace, granted: false }
    })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

void test('ToolForge full-trust grant and revoke update only the current selected workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'joker-toolforge-trust-ipc-'))
  try {
    let stored = config()
    const dependencies: ToolForgeTrustDependencies = {
      loadConfig: () => stored,
      saveConfig: (next) => { stored = next },
      loadProjectState: () => ({
        activeProjectId: 'project-1',
        projects: [{ id: 'project-1', name: 'Workspace', path: workspace, lastUsedAt: 1 }]
      }),
      resolveProjectPath: (projectId) => projectId === 'project-1' ? workspace : null
    }
    assert.equal(updateSelectedWorkspaceFullTrust(true, dependencies).data?.granted, true)
    assert.equal(getSelectedWorkspaceFullTrustState(dependencies).data?.granted, true)
    assert.equal(updateSelectedWorkspaceFullTrust(false, dependencies).data?.granted, false)
    assert.equal(getSelectedWorkspaceFullTrustState(dependencies).data?.granted, false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

void test('ToolForge full-trust mutations reject a missing active workspace', () => {
  const dependencies: ToolForgeTrustDependencies = {
    loadConfig: config,
    saveConfig: () => assert.fail('must not save without an active workspace'),
    loadProjectState: () => ({ projects: [], activeProjectId: null }),
    resolveProjectPath: () => assert.fail('must not resolve without an active project')
  }
  assert.deepEqual(updateSelectedWorkspaceFullTrust(true, dependencies), { success: false, error: 'No working folder is selected' })
})
