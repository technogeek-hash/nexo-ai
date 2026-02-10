import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition } from '../types';
import { logInfo } from '../logger';

export function makeGetDiagnostics(): ToolDefinition {
  return {
    name: 'get_diagnostics',
    description:
      'Get compiler errors, warnings, and linting issues reported by VS Code. ' +
      'Use this after making edits to check for problems.',
    parameters: {
      path: { type: 'string', description: 'Optional relative path to limit diagnostics to a specific file' },
    },
    required: [],
    execute: async (args, ctx) => {
      const targetPath = args.path as string | undefined;
      logInfo(`get_diagnostics: ${targetPath ?? 'all'}`);

      const allDiags = vscode.languages.getDiagnostics();
      const results: string[] = [];

      for (const [uri, diagnostics] of allDiags) {
        const filePath = vscode.workspace.asRelativePath(uri);

        // Filter by path if specified
        if (targetPath) {
          const absTarget = path.resolve(ctx.workspaceRoot, targetPath);
          if (uri.fsPath !== absTarget && !uri.fsPath.startsWith(absTarget)) { continue; }
        }

        // Skip non-workspace files
        if (!uri.fsPath.startsWith(ctx.workspaceRoot)) { continue; }

        const relevant = diagnostics.filter(d =>
          d.severity === vscode.DiagnosticSeverity.Error ||
          d.severity === vscode.DiagnosticSeverity.Warning,
        );

        for (const d of relevant) {
          const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
          const line = d.range.start.line + 1;
          const source = d.source ? ` [${d.source}]` : '';
          results.push(`${sev} ${filePath}:${line}${source} - ${d.message}`);
        }
      }

      if (results.length === 0) {
        return 'No errors or warnings found.';
      }

      return results.slice(0, 50).join('\n') +
        (results.length > 50 ? `\n… and ${results.length - 50} more` : '');
    },
  };
}
