import { ipcMain } from 'electron'
import { loadConfig, saveConfig } from '../store/config'
import { mcpManager } from '../mcp/client'
import { validateServerConfig } from './mcp-config'
import type { McpServerConfig } from '../../shared/types'

export { normalizeHeaders, validateServerConfig } from './mcp-config'

function persistServers(servers: McpServerConfig[]): void {
  const config = loadConfig()
  saveConfig({ ...config, mcpServers: servers })
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:list', () => {
    const configs = getMcpServerConfigs()
    for (const config of configs) mcpManager.seed(config)
    return mcpManager.listRuntime()
  })

  ipcMain.handle('mcp:add', async (_event, raw: unknown) => {
    try {
      const server = validateServerConfig(raw)
      const config = loadConfig()
      const servers = [...(config.mcpServers ?? []).filter((candidate) => candidate.id !== server.id), server]
      persistServers(servers)
      if (server.enabled && server.autoConnect !== false && server.trustState === 'trusted' && server.permission === 'allow') await mcpManager.connect(server)
      return { success: true, runtime: mcpManager.getRuntime(server.id) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mcp:remove', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) return false
    try {
      await mcpManager.remove(id)
    } finally {
      const config = loadConfig()
      persistServers((config.mcpServers ?? []).filter((server) => server.id !== id))
    }
    return true
  })

  ipcMain.handle('mcp:trust', async (_event, id: string) => {
    try {
      const trusted = await mcpManager.trust(id)
      const config = loadConfig()
      persistServers((config.mcpServers ?? []).map((server) => server.id === id ? trusted : server))
      return { success: true, runtime: mcpManager.getRuntime(id) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mcp:revoke-trust', async (_event, id: string) => {
    try {
      const revoked = await mcpManager.revokeTrust(id)
      const config = loadConfig()
      persistServers((config.mcpServers ?? []).map((server) => server.id === id ? revoked : server))
      return { success: true, runtime: mcpManager.getRuntime(id) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mcp:set-permission', async (_event, id: string, permission: unknown) => {
    if (permission !== 'allow' && permission !== 'deny') return { success: false, error: 'Invalid MCP permission' }
    try {
      const updated = await mcpManager.setPermission(id, permission)
      const config = loadConfig()
      persistServers((config.mcpServers ?? []).map((server) => server.id === id ? updated : server))
      return { success: true, runtime: mcpManager.getRuntime(id) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mcp:reconnect', async (_event, id: string) => {
    try {
      await mcpManager.refresh(id)
      return { success: true, runtime: mcpManager.getRuntime(id) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mcp:tools', () => mcpManager.getAllTools())
}

export async function restoreMcpServers(): Promise<void> {
  const config = loadConfig()
  for (const server of config.mcpServers ?? []) {
    if (!server.enabled || server.autoConnect === false || server.trustState !== 'trusted' || server.permission !== 'allow') {
      mcpManager.seed(server)
      continue
    }
    try {
      await mcpManager.connect(server)
    } catch {
      // Runtime status retains the connection error for the Settings UI.
    }
  }
}

export function getMcpServerConfigs(): McpServerConfig[] {
  return loadConfig().mcpServers ?? []
}
