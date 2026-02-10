import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError } from '../logger';
import { Chunk } from './chunker';

/* ────────────────────────────────────────────────────────
   Vector Store — BM25 + TF-IDF similarity search

   Lightweight, zero-dependency vector store for RAG.
   Uses term frequency-inverse document frequency (TF-IDF)
   with BM25 scoring for retrieval — no embedding model
   required.  Persisted to disk as JSON.

   For production-grade embeddings, can be extended to use
   NVIDIA's embedding API (nv-embedqa-e5-v5).
   ──────────────────────────────────────────────────────── */

export interface IndexedChunk extends Chunk {
  /** Term frequency map for BM25 scoring. */
  termFreq: Record<string, number>;
  /** Total terms in this chunk. */
  termCount: number;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export class VectorStore {
  private _chunks: IndexedChunk[] = [];
  private _idf: Record<string, number> = {};
  private _avgDocLength = 0;
  private _storagePath: string;
  private _dirty = false;

  constructor(workspaceRoot: string) {
    this._storagePath = path.join(workspaceRoot, '.nexo-ai', 'rag-index.json');
  }

  /** Index a batch of chunks (replaces any existing index). */
  index(chunks: Chunk[]): void {
    this._chunks = chunks.map(c => ({
      ...c,
      ...tokenize(c.content),
    }));

    this._buildIDF();
    this._dirty = true;
    logInfo(`VectorStore indexed ${this._chunks.length} chunks`);
  }

  /** Incrementally add chunks (for file-change watchers). */
  addChunks(chunks: Chunk[]): void {
    const newIndexed = chunks.map(c => ({ ...c, ...tokenize(c.content) }));
    this._chunks.push(...newIndexed);
    this._buildIDF();
    this._dirty = true;
  }

  /** Remove chunks for a specific file (before re-indexing that file). */
  removeFile(filePath: string): void {
    this._chunks = this._chunks.filter(c => c.filePath !== filePath);
    this._buildIDF();
    this._dirty = true;
  }

  /**
   * Search the index using BM25 scoring.
   * Returns the top-k most relevant chunks.
   */
  search(query: string, topK = 5): SearchResult[] {
    if (this._chunks.length === 0) { return []; }

    const { termFreq: queryTerms } = tokenize(query);
    const k1 = 1.5; // BM25 term saturation
    const b = 0.75; // BM25 length normalization

    const scored = this._chunks.map(chunk => {
      let score = 0;

      for (const [term, _qf] of Object.entries(queryTerms)) {
        const tf = chunk.termFreq[term] ?? 0;
        if (tf === 0) { continue; }

        const idf = this._idf[term] ?? 0;
        const docLen = chunk.termCount;
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / this._avgDocLength)));
        score += idf * tfNorm;
      }

      return { chunk, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Save index to disk. */
  save(): void {
    if (!this._dirty) { return; }
    try {
      const dir = path.dirname(this._storagePath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

      const data = {
        version: 1,
        chunkCount: this._chunks.length,
        chunks: this._chunks.map(c => ({
          id: c.id,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
          tokens: c.tokens,
          termFreq: c.termFreq,
          termCount: c.termCount,
        })),
      };
      fs.writeFileSync(this._storagePath, JSON.stringify(data));
      this._dirty = false;
      logInfo(`VectorStore saved (${this._chunks.length} chunks)`);
    } catch (err) {
      logError('Failed to save vector store', err);
    }
  }

  /** Load index from disk. Returns true if loaded successfully. */
  load(): boolean {
    if (!fs.existsSync(this._storagePath)) { return false; }
    try {
      const raw = JSON.parse(fs.readFileSync(this._storagePath, 'utf-8'));
      if (raw.version !== 1 || !Array.isArray(raw.chunks)) { return false; }
      this._chunks = raw.chunks;
      this._buildIDF();
      logInfo(`VectorStore loaded (${this._chunks.length} chunks)`);
      return true;
    } catch (err) {
      logError('Failed to load vector store', err);
      return false;
    }
  }

  get chunkCount(): number { return this._chunks.length; }

  /** Clear the entire index. */
  clear(): void {
    this._chunks = [];
    this._idf = {};
    this._avgDocLength = 0;
    this._dirty = false;
    if (fs.existsSync(this._storagePath)) { fs.unlinkSync(this._storagePath); }
  }

  /* ═══════════ Internal ═══════════ */

  private _buildIDF(): void {
    const N = this._chunks.length;
    if (N === 0) { this._idf = {}; this._avgDocLength = 0; return; }

    const docFreq: Record<string, number> = {};
    let totalTerms = 0;

    for (const chunk of this._chunks) {
      totalTerms += chunk.termCount;
      const seen = new Set<string>();
      for (const term of Object.keys(chunk.termFreq)) {
        if (!seen.has(term)) {
          docFreq[term] = (docFreq[term] ?? 0) + 1;
          seen.add(term);
        }
      }
    }

    this._avgDocLength = totalTerms / N;

    // IDF with smoothing: log((N - df + 0.5) / (df + 0.5) + 1)
    this._idf = {};
    for (const [term, df] of Object.entries(docFreq)) {
      this._idf[term] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    }
  }
}

/* ═══════════ Tokenization ═══════════ */

/** Simple whitespace + camelCase tokenizer with stop word removal. */
function tokenize(text: string): { termFreq: Record<string, number>; termCount: number } {
  const termFreq: Record<string, number> = {};
  let termCount = 0;

  // Split on whitespace, punctuation; also split camelCase
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
    .replace(/[^a-zA-Z0-9_]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  for (const word of words) {
    termFreq[word] = (termFreq[word] ?? 0) + 1;
    termCount++;
  }

  return { termFreq, termCount };
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'not', 'be', 'as', 'by', 'if', 'do', 'no',
  'this', 'that', 'from', 'with', 'but', 'are', 'was', 'were',
  'has', 'have', 'had', 'been', 'will', 'can', 'may', 'would',
  'should', 'could', 'var', 'let', 'const', 'function', 'return',
  'import', 'export', 'class', 'new', 'true', 'false', 'null',
  'undefined', 'void', 'type', 'interface', 'string', 'number',
]);
