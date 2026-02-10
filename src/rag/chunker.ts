import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn } from '../logger';

/* ────────────────────────────────────────────────────────
   Document Chunker — splits workspace files into
   overlapping chunks for RAG indexing.
   ──────────────────────────────────────────────────────── */

export interface Chunk {
  /** Unique ID for this chunk. */
  id: string;
  /** Relative file path. */
  filePath: string;
  /** Start line number (1-based). */
  startLine: number;
  /** End line number (1-based, inclusive). */
  endLine: number;
  /** The chunk text content. */
  content: string;
  /** Estimated token count. */
  tokens: number;
}

export interface ChunkerOptions {
  /** Target tokens per chunk. Default: 256. */
  chunkSize?: number;
  /** Overlap tokens between adjacent chunks. Default: 50. */
  overlap?: number;
  /** File extensions to index. Default: common code extensions. */
  extensions?: Set<string>;
  /** Max file size in bytes. Default: 200KB. */
  maxFileSize?: number;
}

const DEFAULT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.cpp', '.c', '.cs', '.rb', '.swift', '.kt', '.php', '.sql',
  '.sh', '.yaml', '.yml', '.json', '.md', '.html', '.css', '.scss',
  '.toml', '.xml', '.prisma', '.graphql', '.proto',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  '.vscode', '.idea', 'coverage', '.nyc_output', '.cache', 'vendor',
  '.nexo-ai',
]);

/**
 * Walk the workspace and chunk all indexable files.
 */
export function chunkWorkspace(workspaceRoot: string, opts: ChunkerOptions = {}): Chunk[] {
  const chunkSize = opts.chunkSize ?? 256;
  const overlap = opts.overlap ?? 50;
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const maxFileSize = opts.maxFileSize ?? 200_000;

  const allChunks: Chunk[] = [];
  const files = walkDirectory(workspaceRoot, extensions, maxFileSize);

  for (const absPath of files) {
    const relPath = path.relative(workspaceRoot, absPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const chunks = chunkFile(relPath, content, chunkSize, overlap);
      allChunks.push(...chunks);
    } catch {
      logWarn(`Skipping unchunkable file: ${relPath}`);
    }
  }

  logInfo(`Chunked ${files.length} files into ${allChunks.length} chunks`);
  return allChunks;
}

/**
 * Chunk a single file into overlapping pieces.
 * Respects function/class boundaries where possible.
 */
export function chunkFile(
  filePath: string,
  content: string,
  chunkSize: number,
  overlap: number,
): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  // Estimate lines per chunk (assuming ~4 chars per token, ~40 chars per line)
  const linesPerChunk = Math.max(10, Math.floor((chunkSize * 4) / 40));
  const overlapLines = Math.max(2, Math.floor((overlap * 4) / 40));

  let startLine = 0;
  let chunkIndex = 0;

  while (startLine < lines.length) {
    let endLine = Math.min(startLine + linesPerChunk, lines.length);

    // Try to end at a natural boundary (empty line, closing brace)
    if (endLine < lines.length) {
      const searchEnd = Math.min(endLine + 10, lines.length);
      for (let i = endLine; i < searchEnd; i++) {
        const line = lines[i]?.trim() ?? '';
        if (line === '' || line === '}' || line === '};' || line.startsWith('export ') || line.startsWith('function ') || line.startsWith('class ') || line.startsWith('def ')) {
          endLine = i;
          break;
        }
      }
    }

    const chunkContent = lines.slice(startLine, endLine).join('\n');
    const tokens = Math.ceil(chunkContent.length / 4);

    chunks.push({
      id: `${filePath}:${chunkIndex}`,
      filePath,
      startLine: startLine + 1,
      endLine,
      content: chunkContent,
      tokens,
    });

    chunkIndex++;
    startLine = endLine - overlapLines; // Overlap
    if (startLine >= lines.length - 2) { break; } // Avoid tiny trailing chunks
  }

  return chunks;
}

/* ═══════════ File Walking ═══════════ */

function walkDirectory(
  dir: string,
  extensions: Set<string>,
  maxFileSize: number,
  results: string[] = [],
): string[] {
  if (!fs.existsSync(dir)) { return results; }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') { continue; }
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkDirectory(fullPath, extensions, maxFileSize, results);
      }
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size <= maxFileSize) {
            results.push(fullPath);
          }
        } catch { /* skip */ }
      }
    }
  }

  return results;
}
