import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileEdit } from '../types';
import { logInfo, logError } from '../logger';

/**
 * Apply a list of file edits to the workspace.
 * Returns the edits that were successfully applied.
 */
export async function applyEdits(workspaceRoot: string, edits: FileEdit[]): Promise<FileEdit[]> {
  const applied: FileEdit[] = [];

  for (const edit of edits) {
    try {
      const abs = path.resolve(workspaceRoot, edit.filePath);

      switch (edit.type) {
        case 'create': {
          const dir = path.dirname(abs);
          if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
          fs.writeFileSync(abs, edit.content ?? '', 'utf-8');
          logInfo(`Applied create: ${edit.filePath}`);
          applied.push(edit);
          break;
        }
        case 'edit': {
          if (!fs.existsSync(abs)) {
            logError(`Cannot edit non-existent file: ${edit.filePath}`);
            continue;
          }
          const content = fs.readFileSync(abs, 'utf-8');
          if (edit.oldText && edit.newText !== undefined) {
            const idx = content.indexOf(edit.oldText);
            if (idx === -1) {
              logError(`edit_file: old_text not found in ${edit.filePath}`);
              continue;
            }
            const newContent = content.substring(0, idx) + edit.newText + content.substring(idx + edit.oldText.length);
            fs.writeFileSync(abs, newContent, 'utf-8');
          } else if (edit.content !== undefined) {
            fs.writeFileSync(abs, edit.content, 'utf-8');
          }
          logInfo(`Applied edit: ${edit.filePath}`);
          applied.push(edit);
          break;
        }
        case 'delete': {
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            logInfo(`Applied delete: ${edit.filePath}`);
            applied.push(edit);
          }
          break;
        }
      }
    } catch (err) {
      logError(`Failed to apply edit to ${edit.filePath}`, err);
    }
  }

  return applied;
}

/**
 * Revert a list of file edits using their backup content.
 */
export async function revertEdits(workspaceRoot: string, edits: FileEdit[]): Promise<number> {
  let reverted = 0;
  for (const edit of edits.reverse()) {
    const abs = path.resolve(workspaceRoot, edit.filePath);
    try {
      if (edit.type === 'create') {
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); reverted++; }
      } else if (edit.originalContent !== undefined) {
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(abs, edit.originalContent, 'utf-8');
        reverted++;
      }
    } catch (err) {
      logError(`Failed to revert ${edit.filePath}`, err);
    }
  }
  return reverted;
}

/**
 * Generate a simple unified diff between two strings.
 */
export function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  // Simple line-by-line diff (not a full Myers diff, but good enough for display)
  let i = 0, j = 0;
  let hunkStart = -1;
  const hunkLines: string[] = [];

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      if (hunkLines.length > 0) {
        hunkLines.push(` ${oldLines[i]}`);
      }
      i++; j++;
    } else {
      if (hunkLines.length === 0) {
        hunkStart = i;
        // Add context lines before
        const ctxStart = Math.max(0, i - 3);
        for (let c = ctxStart; c < i; c++) {
          hunkLines.push(` ${oldLines[c]}`);
        }
      }

      if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        hunkLines.push(`-${oldLines[i]}`);
        i++;
      }
      if (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
        hunkLines.push(`+${newLines[j]}`);
        j++;
      }
    }

    // Flush hunk if we've had 3 matching lines after changes
    const recentMatches = hunkLines.slice(-3).every(l => l.startsWith(' '));
    if (recentMatches && hunkLines.some(l => l.startsWith('+') || l.startsWith('-'))) {
      lines.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`);
      lines.push(...hunkLines);
      hunkLines.length = 0;
    }
  }

  if (hunkLines.length > 0 && hunkLines.some(l => l.startsWith('+') || l.startsWith('-'))) {
    lines.push(`@@ -${(hunkStart >= 0 ? hunkStart : 0) + 1} @@`);
    lines.push(...hunkLines);
  }

  return lines.join('\n');
}

/**
 * Open a VS Code diff editor showing changes.
 */
export async function showDiffInEditor(
  workspaceRoot: string,
  filePath: string,
  originalContent: string,
  newContent: string,
): Promise<void> {
  const originalUri = vscode.Uri.parse(`nexo-agent-original:${filePath}`);
  const modifiedUri = vscode.Uri.file(path.resolve(workspaceRoot, filePath));

  // Register a temporary content provider
  const provider = new (class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(): string { return originalContent; }
  })();

  const disposable = vscode.workspace.registerTextDocumentContentProvider('nexo-agent-original', provider);

  await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, `${filePath} (AI Changes)`);

  // Clean up after a delay
  setTimeout(() => disposable.dispose(), 60_000);
}
