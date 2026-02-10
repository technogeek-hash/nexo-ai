import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../types';
import { logInfo, logError, logWarn } from '../logger';

/* ────────────────────────────────────────────────────────
   Persistent Memory Store

   File-based conversation memory that survives restarts.
   Prevents context rot by:
     1. Persisting full conversation history to disk (JSONL)
     2. Compacting old conversations into summaries
     3. Providing semantic recall via keyword search
     4. Maintaining a rolling context window with summaries

   Storage layout:
     .nexo-ai/
       memory/
         conversations.jsonl   — append-only conversation log
         summaries.json        — compressed summaries of old conversations
         facts.json            — extracted facts / key decisions
   ──────────────────────────────────────────────────────── */

export interface MemoryEntry {
  id: string;
  timestamp: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Metadata tags for recall (e.g. file names, function names). */
  tags: string[];
  /** Token count estimate for budget management. */
  tokenEstimate: number;
}

export interface ConversationSummary {
  conversationId: string;
  summary: string;
  keyDecisions: string[];
  filesModified: string[];
  timestamp: number;
  turnCount: number;
}

export interface FactEntry {
  id: string;
  fact: string;
  source: string;
  timestamp: number;
  confidence: number;
}

export interface MemoryConfig {
  /** Max tokens to include from memory in context. */
  maxContextTokens: number;
  /** After this many turns, trigger compaction. */
  compactionThreshold: number;
  /** Directory for memory storage. */
  storageDir: string;
}

const DEFAULT_CONFIG: MemoryConfig = {
  maxContextTokens: 4096,
  compactionThreshold: 40,
  storageDir: '.nexo-ai/memory',
};

export class MemoryStore {
  private _entries: MemoryEntry[] = [];
  private _summaries: ConversationSummary[] = [];
  private _facts: FactEntry[] = [];
  private _config: MemoryConfig;
  private _storageDir: string;
  private _currentConversationId: string;
  private _dirty = false;

  constructor(workspaceRoot: string, config?: Partial<MemoryConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._storageDir = path.join(workspaceRoot, this._config.storageDir);
    this._currentConversationId = generateId();
    this._ensureDir();
    this._load();
  }

  /* ═══════════ Public API ═══════════ */

  /** Record a new message to persistent memory. */
  addMessage(role: MemoryEntry['role'], content: string, tags: string[] = []): void {
    const entry: MemoryEntry = {
      id: generateId(),
      timestamp: Date.now(),
      conversationId: this._currentConversationId,
      role,
      content,
      tags: [...tags, ...extractTags(content)],
      tokenEstimate: estimateTokens(content),
    };

    this._entries.push(entry);
    this._dirty = true;
    this._appendEntry(entry);

    // Check if compaction is needed
    const currentTurns = this._entries.filter(
      e => e.conversationId === this._currentConversationId,
    ).length;

    if (currentTurns > this._config.compactionThreshold) {
      logInfo(`Memory compaction threshold reached (${currentTurns} turns)`);
    }
  }

  /** Record a fact / key decision for long-term recall. */
  addFact(fact: string, source: string, confidence = 0.8): void {
    const entry: FactEntry = {
      id: generateId(),
      fact,
      source,
      timestamp: Date.now(),
      confidence,
    };
    this._facts.push(entry);
    this._dirty = true;
  }

  /** Store a conversation summary (from the summarizer). */
  addSummary(summary: ConversationSummary): void {
    this._summaries.push(summary);
    this._dirty = true;
  }

  /**
   * Build a context block from memory for injection into the system prompt.
   * Retrieves relevant past context within the token budget.
   */
  buildContextBlock(query: string, maxTokens?: number): string {
    const budget = maxTokens ?? this._config.maxContextTokens;
    const sections: string[] = [];
    let usedTokens = 0;

    // 1. Recent facts (highest priority, lowest token cost)
    if (this._facts.length > 0) {
      const recentFacts = this._facts
        .filter(f => f.confidence >= 0.6)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10);

      if (recentFacts.length > 0) {
        const factsBlock = '## Known Facts\n' + recentFacts.map(f => `- ${f.fact}`).join('\n');
        const factTokens = estimateTokens(factsBlock);
        if (usedTokens + factTokens <= budget) {
          sections.push(factsBlock);
          usedTokens += factTokens;
        }
      }
    }

    // 2. Conversation summaries (compressed history)
    if (this._summaries.length > 0) {
      const recentSummaries = this._summaries
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5);

      const summaryBlock = '## Previous Context\n' + recentSummaries
        .map(s => `- [${new Date(s.timestamp).toLocaleDateString()}] ${s.summary}`)
        .join('\n');

      const sumTokens = estimateTokens(summaryBlock);
      if (usedTokens + sumTokens <= budget) {
        sections.push(summaryBlock);
        usedTokens += sumTokens;
      }
    }

    // 3. Semantically relevant past messages (keyword match)
    if (query) {
      const relevant = this._searchEntries(query, 10);
      if (relevant.length > 0) {
        const relevantBlock = '## Relevant Past Messages\n' + relevant
          .map(e => `[${e.role}]: ${truncate(e.content, 200)}`)
          .join('\n');

        const relTokens = estimateTokens(relevantBlock);
        if (usedTokens + relTokens <= budget) {
          sections.push(relevantBlock);
          usedTokens += relTokens;
        }
      }
    }

    // 4. Recent messages from current conversation (not already in context)
    const currentMsgs = this._entries
      .filter(e => e.conversationId === this._currentConversationId)
      .sort((a, b) => b.timestamp - a.timestamp);

    // Only add older messages not in the immediate sliding window
    const olderMsgs = currentMsgs.slice(20); // Skip the last 20 (already in priorMessages)
    if (olderMsgs.length > 0) {
      for (const entry of olderMsgs.slice(0, 10)) {
        const block = `[${entry.role}]: ${truncate(entry.content, 150)}`;
        const blockTokens = estimateTokens(block);
        if (usedTokens + blockTokens > budget) { break; }
        usedTokens += blockTokens;
      }
    }

    if (sections.length === 0) { return ''; }
    return `## Persistent Memory\n\n${sections.join('\n\n')}`;
  }

  /** Get entries that need to be summarized (old entries not yet summarized). */
  getEntriesForCompaction(): MemoryEntry[] {
    const summarizedIds = new Set(this._summaries.map(s => s.conversationId));
    return this._entries.filter(
      e => e.conversationId !== this._currentConversationId &&
           !summarizedIds.has(e.conversationId),
    );
  }

  /** Start a new conversation (preserves old data). */
  newConversation(): void {
    this._currentConversationId = generateId();
    logInfo('New conversation started in memory store');
  }

  get currentConversationId(): string {
    return this._currentConversationId;
  }

  get entryCount(): number {
    return this._entries.length;
  }

  get factCount(): number {
    return this._facts.length;
  }

  get summaryCount(): number {
    return this._summaries.length;
  }

  /** Flush pending changes to disk. */
  flush(): void {
    if (!this._dirty) { return; }
    this._saveSummaries();
    this._saveFacts();
    this._dirty = false;
    logInfo('Memory store flushed to disk');
  }

  /** Clear all memory (for testing or user request). */
  clear(): void {
    this._entries = [];
    this._summaries = [];
    this._facts = [];
    this._dirty = false;

    const convPath = path.join(this._storageDir, 'conversations.jsonl');
    const sumPath = path.join(this._storageDir, 'summaries.json');
    const factPath = path.join(this._storageDir, 'facts.json');

    for (const p of [convPath, sumPath, factPath]) {
      if (fs.existsSync(p)) { fs.unlinkSync(p); }
    }

    logInfo('Memory store cleared');
  }

  /* ═══════════ Internal ═══════════ */

  private _ensureDir(): void {
    if (!fs.existsSync(this._storageDir)) {
      fs.mkdirSync(this._storageDir, { recursive: true });
    }
  }

  private _load(): void {
    // Load conversations (JSONL — one entry per line)
    const convPath = path.join(this._storageDir, 'conversations.jsonl');
    if (fs.existsSync(convPath)) {
      try {
        const lines = fs.readFileSync(convPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            this._entries.push(JSON.parse(line));
          } catch { /* skip malformed lines */ }
        }
        logInfo(`Loaded ${this._entries.length} memory entries from disk`);
      } catch (err) {
        logError('Failed to load conversations', err);
      }
    }

    // Load summaries
    const sumPath = path.join(this._storageDir, 'summaries.json');
    if (fs.existsSync(sumPath)) {
      try {
        this._summaries = JSON.parse(fs.readFileSync(sumPath, 'utf-8'));
      } catch (err) {
        logError('Failed to load summaries', err);
      }
    }

    // Load facts
    const factPath = path.join(this._storageDir, 'facts.json');
    if (fs.existsSync(factPath)) {
      try {
        this._facts = JSON.parse(fs.readFileSync(factPath, 'utf-8'));
      } catch (err) {
        logError('Failed to load facts', err);
      }
    }
  }

  private _appendEntry(entry: MemoryEntry): void {
    try {
      const convPath = path.join(this._storageDir, 'conversations.jsonl');
      fs.appendFileSync(convPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      logError('Failed to append memory entry', err);
    }
  }

  private _saveSummaries(): void {
    try {
      const sumPath = path.join(this._storageDir, 'summaries.json');
      fs.writeFileSync(sumPath, JSON.stringify(this._summaries, null, 2));
    } catch (err) {
      logError('Failed to save summaries', err);
    }
  }

  private _saveFacts(): void {
    try {
      const factPath = path.join(this._storageDir, 'facts.json');
      fs.writeFileSync(factPath, JSON.stringify(this._facts, null, 2));
    } catch (err) {
      logError('Failed to save facts', err);
    }
  }

  /** Simple keyword-based search over past entries. */
  private _searchEntries(query: string, limit: number): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) { return []; }

    const scored = this._entries
      .filter(e => e.conversationId !== this._currentConversationId) // Don't return current conversation
      .map(e => {
        const lower = e.content.toLowerCase();
        const tagStr = e.tags.join(' ').toLowerCase();
        let score = 0;

        for (const kw of keywords) {
          if (lower.includes(kw)) { score += 2; }
          if (tagStr.includes(kw)) { score += 3; } // Tags are higher signal
        }

        // Recency bonus (decay over 7 days)
        const ageMs = Date.now() - e.timestamp;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        score *= Math.max(0.1, 1 - ageDays / 7);

        return { entry: e, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(s => s.entry);
  }
}

/* ═══════════ Helpers ═══════════ */

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) { return text; }
  return text.slice(0, max) + '…';
}

/** Extract tags from content: file paths, function names, class names. */
function extractTags(content: string): string[] {
  const tags: string[] = [];

  // File paths
  const filePaths = content.match(/[\w\-./]+\.\w{1,10}/g);
  if (filePaths) {
    tags.push(...filePaths.filter(p => p.includes('/') || p.includes('.')).slice(0, 10));
  }

  // Function/class names (PascalCase or camelCase identifiers)
  const identifiers = content.match(/\b[A-Z][a-zA-Z0-9]{2,30}\b/g);
  if (identifiers) {
    tags.push(...[...new Set(identifiers)].slice(0, 10));
  }

  return [...new Set(tags)];
}
