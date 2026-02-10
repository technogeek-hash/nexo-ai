import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo } from '../logger';

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  '.vscode', '.idea', 'coverage', '.nyc_output', '.cache', 'vendor', '.DS_Store',
]);

/**
 * Build a compact workspace overview: project type, key files, and
 * a shallow directory tree.  Injected into every system prompt so the
 * agent understands what it is working with.
 */
export async function gatherWorkspaceContext(workspaceRoot: string): Promise<string> {
  const sections: string[] = [];

  // 1. Directory tree (depth 3)
  sections.push('## Workspace Structure\n```');
  sections.push(buildTree(workspaceRoot, '', 0, 3));
  sections.push('```');

  // 2. Project metadata
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      sections.push(`## Project: ${pkg.name ?? 'unknown'}`);
      if (pkg.description) { sections.push(pkg.description); }
      if (pkg.scripts) {
        sections.push('Scripts: ' + Object.keys(pkg.scripts).join(', '));
      }
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (Object.keys(allDeps).length) {
        sections.push('Dependencies: ' + Object.keys(allDeps).slice(0, 30).join(', '));
      }
    } catch { /* ignore parse errors */ }
  }

  // requirements.txt / pyproject.toml for Python projects
  for (const pyFile of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
    if (fs.existsSync(path.join(workspaceRoot, pyFile))) {
      sections.push(`Python project detected (${pyFile}).`);
      break;
    }
  }

  // 3. Git branch
  try {
    const { execSync } = await import('child_process');
    const branch = execSync('git branch --show-current', { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
    if (branch) { sections.push(`Git branch: ${branch}`); }
  } catch { /* not a git repo */ }

  // 4. Currently open editors
  const openEditors = vscode.window.visibleTextEditors
    .map(e => vscode.workspace.asRelativePath(e.document.uri))
    .filter(p => !p.startsWith('/'));
  if (openEditors.length) {
    sections.push(`Open editors: ${openEditors.join(', ')}`);
  }

  // 5. Active file context
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri);
    const selection = activeEditor.selection;
    if (!selection.isEmpty) {
      const selectedText = activeEditor.document.getText(selection);
      if (selectedText.length < 2000) {
        sections.push(`## Selected text in ${relPath} (lines ${selection.start.line + 1}-${selection.end.line + 1})\n\`\`\`\n${selectedText}\n\`\`\``);
      }
    }
  }

  logInfo('Workspace context gathered');
  return sections.join('\n\n');
}

/**
 * Attempt to detect the programming language / framework.
 */
export function detectProjectType(workspaceRoot: string): string {
  const has = (f: string) => fs.existsSync(path.join(workspaceRoot, f));

  if (has('tsconfig.json')) { return 'TypeScript'; }
  if (has('package.json')) { return 'JavaScript/Node.js'; }
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) { return 'Python'; }
  if (has('Cargo.toml')) { return 'Rust'; }
  if (has('go.mod')) { return 'Go'; }
  if (has('pom.xml') || has('build.gradle')) { return 'Java'; }
  if (has('Gemfile')) { return 'Ruby'; }
  if (has('Package.swift')) { return 'Swift'; }
  return 'Unknown';
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

  const prefix = '  '.repeat(depth);
  const lines: string[] = [];
  for (const entry of entries.slice(0, 40)) {
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      const sub = buildTree(root, rel ? `${rel}/${entry.name}` : entry.name, depth + 1, maxDepth);
      if (sub) { lines.push(sub); }
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  if (entries.length > 40) { lines.push(`${prefix}… and ${entries.length - 40} more`); }
  return lines.join('\n');
}
