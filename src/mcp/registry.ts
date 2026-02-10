import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolDefinition, ToolContext } from '../types';
import { logInfo, logError, logWarn } from '../logger';
import { MCPClient, MCPServerConfig, MCPTool } from './client';

/* ────────────────────────────────────────────────────────
   MCP Registry — manages multiple MCP server connections
   and surfaces their tools to the agent pipeline.

   Configuration lives in:
     .nexo-ai/mcp.json  (per-workspace)
     or VS Code settings   (global)
   ──────────────────────────────────────────────────────── */

interface MCPConfigFile {
  mcpServers: Record<string, Omit<MCPServerConfig, 'name' | 'enabled'> & { enabled?: boolean }>;
}

const _clients = new Map<string, MCPClient>();

/**
 * Load MCP server configurations from workspace and settings.
 */
export function loadMCPConfigs(workspaceRoot: string): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];

  // 1. Workspace-level config (.nexo-ai/mcp.json)
  const wsConfigPath = path.join(workspaceRoot, '.nexo-ai', 'mcp.json');
  if (fs.existsSync(wsConfigPath)) {
    try {
      const raw: MCPConfigFile = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        for (const [name, cfg] of Object.entries(raw.mcpServers)) {
          configs.push({
            name,
            command: cfg.command,
            args: cfg.args ?? [],
            env: cfg.env,
            cwd: cfg.cwd ?? workspaceRoot,
            enabled: cfg.enabled !== false,
          });
        }
      }
      logInfo(`Loaded ${configs.length} MCP server configs from workspace`);
    } catch (err) {
      logError('Failed to parse MCP config', err);
    }
  }

  // 2. VS Code settings (nexoAgent.mcpServers)
  const settingServers = vscode.workspace.getConfiguration('nexoAgent').get<Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
  }>>('mcpServers', {});

  for (const [name, cfg] of Object.entries(settingServers)) {
    // Don't duplicate workspace configs
    if (!configs.some(c => c.name === name)) {
      configs.push({
        name,
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        cwd: workspaceRoot,
        enabled: cfg.enabled !== false,
      });
    }
  }

  return configs;
}

/**
 * Connect to all configured MCP servers.
 */
export async function connectMCPServers(workspaceRoot: string): Promise<void> {
  const configs = loadMCPConfigs(workspaceRoot);
  const enabled = configs.filter(c => c.enabled);

  if (enabled.length === 0) {
    logInfo('No MCP servers configured');
    return;
  }

  logInfo(`Connecting to ${enabled.length} MCP server(s)…`);

  for (const config of enabled) {
    if (_clients.has(config.name)) {
      logWarn(`MCP server "${config.name}" already connected, skipping`);
      continue;
    }

    const client = new MCPClient(config);
    try {
      await client.connect();
      _clients.set(config.name, client);
    } catch (err) {
      logError(`Failed to connect MCP server "${config.name}"`, err);
    }
  }

  logInfo(`Connected to ${_clients.size} MCP server(s)`);
}

/**
 * Disconnect all MCP servers.
 */
export function disconnectMCPServers(): void {
  for (const [name, client] of _clients) {
    client.disconnect();
    logInfo(`Disconnected MCP server: ${name}`);
  }
  _clients.clear();
}

/**
 * Get all tools from all connected MCP servers,
 * wrapped as ToolDefinition[] for the agent pipeline.
 */
export function getMCPTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const [, client] of _clients) {
    if (!client.isConnected) { continue; }

    for (const mcpTool of client.tools) {
      tools.push(mcpToolToDefinition(mcpTool, client));
    }
  }

  return tools;
}

/**
 * Get all resources from all connected MCP servers.
 */
export function getMCPResources(): Array<{ uri: string; name: string; description?: string; serverName: string }> {
  const resources: Array<{ uri: string; name: string; description?: string; serverName: string }> = [];

  for (const [, client] of _clients) {
    if (!client.isConnected) { continue; }
    resources.push(...client.resources);
  }

  return resources;
}

/**
 * Read a resource from an MCP server.
 */
export async function readMCPResource(uri: string): Promise<string | null> {
  for (const [, client] of _clients) {
    if (!client.isConnected) { continue; }
    const hasResource = client.resources.some(r => r.uri === uri);
    if (hasResource) {
      try {
        return await client.readResource(uri);
      } catch (err) {
        logError(`Failed to read MCP resource: ${uri}`, err);
      }
    }
  }
  return null;
}

/**
 * Get MCP connection status for display.
 */
export function getMCPStatus(): Array<{ name: string; connected: boolean; toolCount: number }> {
  return [..._clients.entries()].map(([name, client]) => ({
    name,
    connected: client.isConnected,
    toolCount: client.tools.length,
  }));
}

/* ═══════════ Helpers ═══════════ */

function mcpToolToDefinition(mcpTool: MCPTool, client: MCPClient): ToolDefinition {
  // Convert JSON Schema input to our ToolParameterDef format
  const parameters: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  const schema = mcpTool.inputSchema as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };

  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      parameters[key] = {
        type: prop.type ?? 'string',
        description: prop.description ?? '',
      };
    }
  }

  if (Array.isArray(schema?.required)) {
    required.push(...schema.required);
  }

  return {
    name: `mcp_${client.name}_${mcpTool.name}`,
    description: `[MCP: ${client.name}] ${mcpTool.description}`,
    parameters,
    required,
    execute: async (args: Record<string, unknown>) => {
      try {
        return await client.callTool(mcpTool.name, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `MCP tool error: ${msg}`;
      }
    },
  };
}
