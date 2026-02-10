import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { ToolDefinition } from '../types';
import { logInfo } from '../logger';

/* ─── search_files (glob) ─── */

export function makeSearchFiles(): ToolDefinition {
  return {
    name: 'search_files',
    description:
      'Search for files in the workspace matching a glob pattern. ' +
      'Returns a list of matching file paths. Example patterns: "**/*.ts", "src/**/*.py".',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts")' },
    },
    required: ['pattern'],
    execute: async (args, ctx) => {
      const pattern = args.pattern as string;
      logInfo(`search_files: ${pattern}`);

      // Use `find` + basic glob conversion for portability
      try {
        const safeRegex = globToRegex(pattern).replace(/'/g, "'\\''");
        const result = cp.execSync(
          `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/__pycache__/*' | grep -E '${safeRegex}' | head -100`,
          { cwd: ctx.workspaceRoot, encoding: 'utf-8', timeout: 10_000 },
        );
        const files = result.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
        return files.length > 0 ? files.join('\n') : 'No files matched the pattern.';
      } catch {
        // Fallback: walk directory
        const files = walkDir(ctx.workspaceRoot, pattern);
        return files.length > 0 ? files.join('\n') : 'No files matched the pattern.';
      }
    },
  };
}

/* ─── search_text (grep) ─── */

export function makeSearchText(): ToolDefinition {
  return {
    name: 'search_text',
    description:
      'Search for text or a regex pattern across files in the workspace. ' +
      'Returns matching lines with file paths and line numbers. Great for finding usages, definitions, or patterns.',
    parameters: {
      query: { type: 'string', description: 'Text or regex pattern to search for' },
      include: { type: 'string', description: 'Optional glob to limit search scope (e.g. "src/**/*.ts")' },
    },
    required: ['query'],
    execute: async (args, ctx) => {
      const query = args.query as string;
      const include = args.include as string | undefined;
      logInfo(`search_text: "${query}" in ${include || 'workspace'}`);

      try {
        const safeQuery = query.replace(/'/g, "'\\''");
        let cmd = `grep -rn --include='*' -I '${safeQuery}'`;
        if (include) {
          const safeInclude = include.replace(/'/g, "'\\''");
          cmd = `grep -rn --include='${safeInclude}' -I '${safeQuery}'`;
        }
        cmd += ` . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist | head -80`;

        const result = cp.execSync(cmd, {
          cwd: ctx.workspaceRoot,
          encoding: 'utf-8',
          timeout: 15_000,
        });
        const clean = result.trim().split('\n').map(l => l.replace(/^\.\//, '')).join('\n');
        return clean || 'No matches found.';
      } catch {
        return 'No matches found.';
      }
    },
  };
}

/* ─── get_workspace_structure ─── */

export function makeGetWorkspaceStructure(): ToolDefinition {
  return {
    name: 'get_workspace_structure',
    description:
      'Get a tree view of the workspace directory structure. ' +
      'Useful for understanding the project layout before making changes.',
    parameters: {
      depth: { type: 'number', description: 'Maximum depth to traverse (default: 4)' },
    },
    required: [],
    execute: async (args, ctx) => {
      const maxDepth = Number(args.depth) || 4;
      logInfo(`get_workspace_structure: depth=${maxDepth}`);
      const tree = buildTree(ctx.workspaceRoot, '', 0, maxDepth);
      return tree || '(empty workspace)';
    },
  };
}

/* ───────────────── helpers ───────────────── */

function globToRegex(glob: string): string {
  return glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
}

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  '.vscode', '.idea', 'coverage', '.nyc_output', '.cache', 'vendor',
]);

function walkDir(root: string, pattern: string, rel = ''): string[] {
  const results: string[] = [];
  const regex = new RegExp(globToRegex(pattern));
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) { return results; }

  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) { continue; }
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkDir(root, pattern, childRel));
    } else if (regex.test(childRel)) {
      results.push(childRel);
    }
  }
  return results;
}

function buildTree(root: string, rel: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) { return ''; }
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) { return ''; }

  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter(e => !IGNORED.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) { return -1; }
      if (!a.isDirectory() && b.isDirectory()) { return 1; }
      return a.name.localeCompare(b.name);
    });

  const indent = '  '.repeat(depth);
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      lines.push(buildTree(root, rel ? `${rel}/${entry.name}` : entry.name, depth + 1, maxDepth));
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}
