import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logError, logWarn } from '../logger';

/* ────────────────────────────────────────────────────────
   Attachment System — Images, Files, Git Diffs, URLs

   Allows users to attach context to their prompts:
   • Images  — base64-encoded for vision models
   • Files   — full content or smart excerpts
   • Git     — staged/unstaged diffs, blame, log
   • URLs    — fetched and summarized (future)
   ──────────────────────────────────────────────────────── */

export type AttachmentType = 'image' | 'file' | 'git-diff' | 'git-log' | 'selection' | 'diagnostics';

export interface Attachment {
  type: AttachmentType;
  /** Display name for the UI. */
  name: string;
  /** Content as text (or base64 for images). */
  content: string;
  /** MIME type for images. */
  mimeType?: string;
  /** Source file path (if applicable). */
  filePath?: string;
  /** Estimated token cost. */
  tokenEstimate: number;
}

/* ═══════════ Image Attachments ═══════════ */

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
]);

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function attachImage(filePath: string): Promise<Attachment | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    logWarn(`Unsupported image format: ${ext}`);
    return null;
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_IMAGE_SIZE) {
      logWarn(`Image too large: ${stats.size} bytes (max ${MAX_IMAGE_SIZE})`);
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    const mimeType = getMimeType(ext);

    return {
      type: 'image',
      name: path.basename(filePath),
      content: base64,
      mimeType,
      filePath,
      tokenEstimate: Math.ceil(base64.length / 4), // rough estimate
    };
  } catch (err) {
    logError(`Failed to read image: ${filePath}`, err);
    return null;
  }
}

/* ═══════════ File Attachments ═══════════ */

const MAX_FILE_SIZE = 500_000; // 500 KB for text files

export async function attachFile(filePath: string, maxLines?: number): Promise<Attachment | null> {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      logWarn(`File too large for attachment: ${stats.size} bytes. Truncating…`);
    }

    let content = fs.readFileSync(filePath, 'utf-8');
    const relPath = vscode.workspace.workspaceFolders?.[0]
      ? path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath)
      : path.basename(filePath);

    // Truncate if needed
    if (maxLines) {
      const lines = content.split('\n');
      if (lines.length > maxLines) {
        content = lines.slice(0, maxLines).join('\n') + `\n\n… (${lines.length - maxLines} more lines)`;
      }
    } else if (content.length > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + '\n\n… (truncated)';
    }

    const formatted = `### File: ${relPath}\n\`\`\`${getLanguageId(filePath)}\n${content}\n\`\`\``;

    return {
      type: 'file',
      name: relPath,
      content: formatted,
      filePath,
      tokenEstimate: estimateTokens(formatted),
    };
  } catch (err) {
    logError(`Failed to read file: ${filePath}`, err);
    return null;
  }
}

/** Attach the currently active editor's file. */
export async function attachActiveFile(): Promise<Attachment | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return null; }
  return attachFile(editor.document.uri.fsPath);
}

/** Attach the currently selected text. */
export function attachSelection(): Attachment | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) { return null; }

  const text = editor.document.getText(editor.selection);
  const relPath = vscode.workspace.asRelativePath(editor.document.uri);
  const startLine = editor.selection.start.line + 1;
  const endLine = editor.selection.end.line + 1;

  const formatted = `### Selected code from ${relPath} (lines ${startLine}-${endLine})\n\`\`\`${getLanguageId(editor.document.fileName)}\n${text}\n\`\`\``;

  return {
    type: 'selection',
    name: `${relPath}:${startLine}-${endLine}`,
    content: formatted,
    filePath: editor.document.uri.fsPath,
    tokenEstimate: estimateTokens(formatted),
  };
}

/* ═══════════ Git Attachments ═══════════ */

export async function attachGitDiff(staged = false): Promise<Attachment | null> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) { return null; }

  try {
    const { execSync } = await import('child_process');
    const cmd = staged ? 'git diff --staged' : 'git diff';
    const diff = execSync(cmd, {
      cwd: wsRoot,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    }).trim();

    if (!diff) {
      return null; // No changes
    }

    const label = staged ? 'Staged changes' : 'Unstaged changes';
    const formatted = `### Git: ${label}\n\`\`\`diff\n${diff}\n\`\`\``;

    return {
      type: 'git-diff',
      name: label,
      content: formatted,
      tokenEstimate: estimateTokens(formatted),
    };
  } catch (err) {
    logError('Failed to get git diff', err);
    return null;
  }
}

export async function attachGitLog(count = 10): Promise<Attachment | null> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) { return null; }

  try {
    const { execSync } = await import('child_process');
    const log = execSync(
      `git log --oneline --no-merges -${count}`,
      { cwd: wsRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    ).trim();

    if (!log) { return null; }

    const formatted = `### Git: Recent commits\n\`\`\`\n${log}\n\`\`\``;

    return {
      type: 'git-log',
      name: `Recent ${count} commits`,
      content: formatted,
      tokenEstimate: estimateTokens(formatted),
    };
  } catch (err) {
    logError('Failed to get git log', err);
    return null;
  }
}

/** Attach current file diagnostics (errors/warnings). */
export async function attachDiagnostics(uri?: vscode.Uri): Promise<Attachment | null> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) { return null; }

  const diagnostics = vscode.languages.getDiagnostics(targetUri);
  if (diagnostics.length === 0) { return null; }

  const relPath = vscode.workspace.asRelativePath(targetUri);
  const lines = diagnostics.map(d => {
    const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR'
      : d.severity === vscode.DiagnosticSeverity.Warning ? 'WARN' : 'INFO';
    return `  L${d.range.start.line + 1}: [${severity}] ${d.message}${d.source ? ` (${d.source})` : ''}`;
  });

  const formatted = `### Diagnostics: ${relPath}\n${lines.join('\n')}`;

  return {
    type: 'diagnostics',
    name: `Diagnostics (${diagnostics.length})`,
    content: formatted,
    tokenEstimate: estimateTokens(formatted),
  };
}

/* ═══════════ Batch Operations ═══════════ */

/** Let user pick files to attach via a quick pick. */
export async function pickFilesToAttach(): Promise<Attachment[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Attach',
    title: 'Select files to attach as context',
  });

  if (!uris || uris.length === 0) { return []; }

  const attachments: Attachment[] = [];
  for (const uri of uris) {
    const ext = path.extname(uri.fsPath).toLowerCase();
    const att = SUPPORTED_IMAGE_EXTENSIONS.has(ext)
      ? await attachImage(uri.fsPath)
      : await attachFile(uri.fsPath);
    if (att) { attachments.push(att); }
  }

  logInfo(`Attached ${attachments.length} file(s)`);
  return attachments;
}

/** Build the combined context string from multiple attachments. */
export function buildAttachmentContext(attachments: Attachment[]): string {
  if (attachments.length === 0) { return ''; }

  const textAttachments = attachments.filter(a => a.type !== 'image');
  if (textAttachments.length === 0) { return ''; }

  return '## Attached Context\n\n' + textAttachments.map(a => a.content).join('\n\n');
}

/** Get image attachments formatted for vision-capable models. */
export function getImageAttachments(attachments: Attachment[]): Array<{ base64: string; mimeType: string }> {
  return attachments
    .filter(a => a.type === 'image' && a.mimeType)
    .map(a => ({ base64: a.content, mimeType: a.mimeType! }));
}

/* ═══════════ Helpers ═══════════ */

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
    '.cpp': 'cpp', '.c': 'c', '.cs': 'csharp', '.rb': 'ruby',
    '.swift': 'swift', '.kt': 'kotlin', '.php': 'php', '.sql': 'sql',
    '.sh': 'bash', '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json',
    '.md': 'markdown', '.html': 'html', '.css': 'css', '.scss': 'scss',
    '.xml': 'xml', '.toml': 'toml', '.ini': 'ini', '.env': 'bash',
  };
  return map[ext] ?? '';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
