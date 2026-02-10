import { ChatMessage } from '../types';
import { chatCompletion } from '../client/nvidiaClient';
import { logInfo, logError } from '../logger';
import { MemoryStore, MemoryEntry, ConversationSummary } from './store';

/* ────────────────────────────────────────────────────────
   Memory Summarizer — LLM-powered conversation compaction.

   Compresses old conversation turns into concise summaries
   to keep memory under token budget while preserving key
   context, decisions, and facts.
   ──────────────────────────────────────────────────────── */

const SUMMARIZE_SYSTEM = `You are a precise conversation summarizer for a coding assistant. Given a conversation history, produce:

1. **Summary** — 2-4 sentences capturing the key context: what the user wanted, what was done, what the final state is.
2. **Key Decisions** — bulleted list of important technical decisions made (tech stack choices, architecture patterns, naming conventions).
3. **Files Modified** — list of files that were created or modified.

Output ONLY valid JSON:
{
  "summary": "...",
  "keyDecisions": ["...", "..."],
  "filesModified": ["...", "..."]
}

Be extremely concise. The summary will be used as context for future conversations.`;

/**
 * Summarize a batch of old conversation entries and store the summary.
 * Returns the summary or null if summarization failed.
 */
export async function summarizeAndCompact(
  store: MemoryStore,
  signal?: AbortSignal,
): Promise<ConversationSummary | null> {
  const entries = store.getEntriesForCompaction();
  if (entries.length === 0) { return null; }

  // Group by conversation
  const byConversation = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const group = byConversation.get(e.conversationId) ?? [];
    group.push(e);
    byConversation.set(e.conversationId, group);
  }

  // Summarize each old conversation
  for (const [conversationId, convEntries] of byConversation) {
    try {
      const transcript = convEntries
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(e => `[${e.role}]: ${truncate(e.content, 300)}`)
        .join('\n');

      const messages: ChatMessage[] = [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: `Summarize this conversation:\n\n${transcript}` },
      ];

      const raw = await chatCompletion({
        messages,
        temperature: 0.1,
        maxTokens: 1024,
        signal,
      });

      const parsed = parseJson(raw);
      if (parsed) {
        const summary: ConversationSummary = {
          conversationId,
          summary: String(parsed.summary ?? 'No summary'),
          keyDecisions: Array.isArray(parsed.keyDecisions)
            ? parsed.keyDecisions.map(String) : [],
          filesModified: Array.isArray(parsed.filesModified)
            ? parsed.filesModified.map(String) : [],
          timestamp: convEntries[convEntries.length - 1]?.timestamp ?? Date.now(),
          turnCount: convEntries.length,
        };

        store.addSummary(summary);
        store.flush();
        logInfo(`Summarized conversation ${conversationId}: ${convEntries.length} turns → summary`);
        return summary;
      }
    } catch (err) {
      logError(`Failed to summarize conversation ${conversationId}`, err);
    }
  }

  return null;
}

/**
 * Extract key facts from a conversation turn for long-term recall.
 * Runs inline during message handling (fast, heuristic-based).
 */
export function extractFacts(content: string, role: string): string[] {
  const facts: string[] = [];

  if (role !== 'assistant') { return facts; }

  // Detect tech stack decisions
  const techPatterns = [
    /(?:using|chose|selected|switched to|migrating to)\s+([\w\s.]+?)(?:\s+(?:for|because|since|as))/gi,
    /tech\s*stack[:\s]+([\w\s,/+]+)/gi,
  ];
  for (const pat of techPatterns) {
    let match;
    while ((match = pat.exec(content)) !== null) {
      facts.push(`Tech decision: ${match[1].trim()}`);
    }
  }

  // Detect architecture decisions
  const archPatterns = [
    /(?:architecture|pattern|approach)[:\s]+([\w\s-]+)/gi,
    /decided\s+to\s+([\w\s]+?)(?:\.|$)/gi,
  ];
  for (const pat of archPatterns) {
    let match;
    while ((match = pat.exec(content)) !== null) {
      facts.push(`Architecture: ${match[1].trim()}`);
    }
  }

  // Detect file creation
  const filePatterns = [
    /(?:created|wrote|generated)\s+(?:file\s+)?[`"]?([\w\-./]+\.\w{1,8})[`"]?/gi,
  ];
  for (const pat of filePatterns) {
    let match;
    while ((match = pat.exec(content)) !== null) {
      facts.push(`File created: ${match[1]}`);
    }
  }

  return facts.slice(0, 5); // Cap at 5 facts per turn
}

/* ═══════════ Helpers ═══════════ */

function parseJson(raw: string): Record<string, unknown> | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) { return text; }
  return text.slice(0, max) + '…';
}
