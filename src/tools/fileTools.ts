import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, ToolContext } from '../types';
import { logInfo } from '../logger';

/* ────────────────────────────────────────────────────────
   File-system tools: read, write, edit, delete, list
   ──────────────────────────────────────────────────────── */

function safePath(workspaceRoot: string, relPath: string): string {
  const resolved = path.resolve(workspaceRoot, relPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return resolved;
}

/* ─── read_file ─── */

export function makeReadFile(): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Returns the file text with line numbers.',
    parameters: {
      path: { type: 'string', description: 'Relative path to the file from workspace root' },
      start_line: { type: 'number', description: 'Start reading from this line (1-based). Omit to read from the start.' },
      end_line: { type: 'number', description: 'Stop reading at this line (inclusive). Omit to read to the end.' },
    },
    required: ['path'],
    execute: async (args, ctx) => {
      const abs = safePath(ctx.workspaceRoot, args.path as string);
      if (!fs.existsSync(abs)) { return `File not found: ${args.path}`; }

      const stat = fs.statSync(abs);
      if (stat.isDirectory()) { return `Path is a directory, not a file: ${args.path}`; }
      if (stat.size > 500_000) { return `File too large (${stat.size} bytes). Use start_line/end_line to read a portion.`; }

      const raw = fs.readFileSync(abs, 'utf-8');
      const allLines = raw.split('\n');

      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(allLines.length, Number(args.end_line) || allLines.length);

      const lines = allLines.slice(start - 1, end);
      const numbered = lines.map((l, i) => `${start + i}│${l}`).join('\n');

      logInfo(`read_file: ${args.path} (lines ${start}-${end})`);
      return numbered;
    },
  };
}

/* ─── write_file ─── */

export function makeWriteFile(): ToolDefinition {
  return {
    name: 'write_file',
    description: 'Create a new file or completely replace an existing file with the given content.',
    parameters: {
      path: { type: 'string', description: 'Relative path to the file' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
    execute: async (args, ctx) => {
      const abs = safePath(ctx.workspaceRoot, args.path as string);
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

      fs.writeFileSync(abs, args.content as string, 'utf-8');
      logInfo(`write_file: ${args.path} (${(args.content as string).length} chars)`);
      ctx.onProgress?.(`Created/wrote ${args.path}`);
      return `Successfully wrote ${args.path}`;
    },
  };
}

/* ─── edit_file (search-and-replace) ─── */

export function makeEditFile(): ToolDefinition {
  return {
    name: 'edit_file',
    description:
      'Make a targeted edit to a file by replacing an exact substring. ' +
      'The old_text must match the file contents EXACTLY (including whitespace and indentation). ' +
      'Include a few lines of surrounding context in old_text to ensure a unique match.',
    parameters: {
      path: { type: 'string', description: 'Relative path to the file' },
      old_text: { type: 'string', description: 'The exact text to find and replace (must match uniquely)' },
      new_text: { type: 'string', description: 'The replacement text' },
    },
    required: ['path', 'old_text', 'new_text'],
    execute: async (args, ctx) => {
      const abs = safePath(ctx.workspaceRoot, args.path as string);
      if (!fs.existsSync(abs)) { return `File not found: ${args.path}`; }

      let content = fs.readFileSync(abs, 'utf-8');
      const oldText = args.old_text as string;
      const newText = args.new_text as string;

      // Exact match first
      const idx = content.indexOf(oldText);
      if (idx === -1) {
        // Fallback: try trimmed line matching
        const result = fuzzyReplace(content, oldText, newText);
        if (result) {
          fs.writeFileSync(abs, result, 'utf-8');
          logInfo(`edit_file (fuzzy): ${args.path}`);
          ctx.onProgress?.(`Edited ${args.path}`);
          return `Successfully edited ${args.path} (fuzzy match)`;
        }
        return `Could not find the specified old_text in ${args.path}. Make sure it matches exactly including whitespace.`;
      }

      // Ensure unique match
      const secondIdx = content.indexOf(oldText, idx + 1);
      if (secondIdx !== -1) {
        return `old_text matches multiple locations in ${args.path}. Add more surrounding context to make it unique.`;
      }

      content = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
      fs.writeFileSync(abs, content, 'utf-8');
      logInfo(`edit_file: ${args.path}`);
      ctx.onProgress?.(`Edited ${args.path}`);
      return `Successfully edited ${args.path}`;
    },
  };
}

/** Fuzzy-match by normalizing indentation/trailing whitespace per line. */
function fuzzyReplace(content: string, oldText: string, newText: string): string | null {
  const normalize = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n');
  const normContent = normalize(content);
  const normOld = normalize(oldText);
  const idx = normContent.indexOf(normOld);
  if (idx === -1) { return null; }

  // Line-based replacement: find matching lines and splice
  const contentLines = content.split('\n');
  const oldNormLines = normOld.split('\n');

  for (let i = 0; i <= contentLines.length - oldNormLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldNormLines.length; j++) {
      if (contentLines[i + j].trimEnd() !== oldNormLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const before = contentLines.slice(0, i);
      const after = contentLines.slice(i + oldNormLines.length);
      return [...before, newText, ...after].join('\n');
    }
  }

  return null;
}

/* ─── delete_file ─── */

export function makeDeleteFile(): ToolDefinition {
  return {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    parameters: {
      path: { type: 'string', description: 'Relative path to the file' },
    },
    required: ['path'],
    execute: async (args, ctx) => {
      const abs = safePath(ctx.workspaceRoot, args.path as string);
      if (!fs.existsSync(abs)) { return `File not found: ${args.path}`; }
      fs.unlinkSync(abs);
      logInfo(`delete_file: ${args.path}`);
      ctx.onProgress?.(`Deleted ${args.path}`);
      return `Deleted ${args.path}`;
    },
  };
}

/* ─── list_directory ─── */

export function makeListDirectory(): ToolDefinition {
  return {
    name: 'list_directory',
    description: 'List the contents of a directory, showing files and subdirectories.',
    parameters: {
      path: { type: 'string', description: 'Relative path to the directory (use "." for root)' },
    },
    required: ['path'],
    execute: async (args, ctx) => {
      const abs = safePath(ctx.workspaceRoot, args.path as string);
      if (!fs.existsSync(abs)) { return `Directory not found: ${args.path}`; }
      if (!fs.statSync(abs).isDirectory()) { return `Not a directory: ${args.path}`; }

      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lines = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== '__pycache__')
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) { return -1; }
          if (!a.isDirectory() && b.isDirectory()) { return 1; }
          return a.name.localeCompare(b.name);
        })
        .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`);

      logInfo(`list_directory: ${args.path} (${lines.length} entries)`);
      return lines.join('\n') || '(empty directory)';
    },
  };
}
