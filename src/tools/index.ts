import { ToolDefinition } from '../types';
import { makeReadFile, makeWriteFile, makeEditFile, makeListDirectory, makeDeleteFile } from './fileTools';
import { makeRunCommand } from './terminalTools';
import { makeSearchFiles, makeSearchText, makeGetWorkspaceStructure } from './searchTools';
import { makeGetDiagnostics } from './diagnosticTools';

/**
 * Build the full tool registry.  Every tool is a pure function factory
 * so we can inject the workspace root at activation time.
 */
export function buildToolRegistry(): ToolDefinition[] {
  return [
    makeReadFile(),
    makeWriteFile(),
    makeEditFile(),
    makeDeleteFile(),
    makeListDirectory(),
    makeSearchFiles(),
    makeSearchText(),
    makeGetWorkspaceStructure(),
    makeRunCommand(),
    makeGetDiagnostics(),
  ];
}

/** Render tool definitions into a system-prompt–friendly block. */
export function toolDescriptionsForPrompt(tools: ToolDefinition[]): string {
  const lines: string[] = ['## Available Tools\n'];
  for (const t of tools) {
    lines.push(`### ${t.name}`);
    lines.push(t.description);
    lines.push('Parameters:');
    for (const [name, def] of Object.entries(t.parameters)) {
      const req = t.required.includes(name) ? ' (required)' : ' (optional)';
      lines.push(`  - ${name} (${def.type}${req}): ${def.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Execute a tool by name. */
export async function executeTool(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  ctx: import('../types').ToolContext,
): Promise<{ result: string; success: boolean }> {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return { result: `Unknown tool: ${name}`, success: false };
  }

  // Validate required params
  for (const req of tool.required) {
    if (args[req] === undefined || args[req] === null) {
      return { result: `Missing required parameter: ${req}`, success: false };
    }
  }

  try {
    const result = await tool.execute(args, ctx);
    return { result, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `Tool error (${name}): ${msg}`, success: false };
  }
}
