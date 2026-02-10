import { logInfo } from '../logger';
import { Chunk, chunkWorkspace } from './chunker';
import { VectorStore, SearchResult } from './vectorStore';

/* ────────────────────────────────────────────────────────
   RAG Retriever — Retrieval-Augmented Generation

   Indexes the workspace and retrieves relevant code
   chunks for any given query. Injected into system
   prompts to give the model precise, relevant context
   instead of dumping the entire codebase.
   ──────────────────────────────────────────────────────── */

export interface RAGContext {
  /** Formatted context string ready for injection. */
  contextBlock: string;
  /** Individual results for inspection. */
  results: SearchResult[];
  /** Total token estimate of the context block. */
  tokenEstimate: number;
}

let _store: VectorStore | null = null;
let _lastIndexTime = 0;
const INDEX_STALENESS_MS = 5 * 60 * 1000; // Re-index every 5 minutes

/**
 * Initialize or refresh the RAG index for the workspace.
 */
export function initRAGIndex(workspaceRoot: string, force = false): void {
  const now = Date.now();

  if (!_store) {
    _store = new VectorStore(workspaceRoot);
    // Try loading persisted index first
    if (!force && _store.load()) {
      _lastIndexTime = now;
      logInfo(`RAG index loaded from disk (${_store.chunkCount} chunks)`);
      return;
    }
  }

  // Re-index if stale or forced
  if (force || now - _lastIndexTime > INDEX_STALENESS_MS) {
    const chunks = chunkWorkspace(workspaceRoot);
    _store.index(chunks);
    _store.save();
    _lastIndexTime = now;
    logInfo(`RAG index built: ${chunks.length} chunks from workspace`);
  }
}

/**
 * Incrementally update the index when a file changes.
 */
export function updateRAGFile(workspaceRoot: string, filePath: string): void {
  if (!_store) { initRAGIndex(workspaceRoot); return; }

  const { chunkFile } = require('./chunker') as typeof import('./chunker');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  const relPath = path.relative(workspaceRoot, filePath);
  _store.removeFile(relPath);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const chunks = chunkFile(relPath, content, 256, 50);
    _store.addChunks(chunks);
    logInfo(`RAG index updated for ${relPath}`);
  } catch {
    // File may have been deleted
  }
}

/**
 * Retrieve relevant context for a query.
 * Returns a formatted context block + raw results.
 */
export function retrieveContext(
  query: string,
  workspaceRoot: string,
  topK = 8,
  maxTokens = 3000,
): RAGContext {
  if (!_store || _store.chunkCount === 0) {
    initRAGIndex(workspaceRoot);
  }

  if (!_store || _store.chunkCount === 0) {
    return { contextBlock: '', results: [], tokenEstimate: 0 };
  }

  const results = _store.search(query, topK * 2); // Over-fetch, then trim by token budget
  const selected: SearchResult[] = [];
  let totalTokens = 0;

  for (const r of results) {
    if (totalTokens + r.chunk.tokens > maxTokens) { break; }
    selected.push(r);
    totalTokens += r.chunk.tokens;
  }

  if (selected.length === 0) {
    return { contextBlock: '', results: [], tokenEstimate: 0 };
  }

  // Format as a context block
  const blocks = selected.map(r => {
    const { filePath, startLine, endLine, content } = r.chunk;
    return `### ${filePath} (lines ${startLine}-${endLine})\n\`\`\`\n${content}\n\`\`\``;
  });

  const contextBlock = `## Relevant Code Context (RAG)\n\n${blocks.join('\n\n')}`;

  return {
    contextBlock,
    results: selected,
    tokenEstimate: totalTokens,
  };
}

/**
 * Clear the RAG index (e.g. on workspace change).
 */
export function clearRAGIndex(): void {
  _store?.clear();
  _store = null;
  _lastIndexTime = 0;
  logInfo('RAG index cleared');
}

/**
 * Get index stats for display.
 */
export function getRAGStats(): { chunks: number; lastIndexed: number } {
  return {
    chunks: _store?.chunkCount ?? 0,
    lastIndexed: _lastIndexTime,
  };
}
