import { chatCompletion } from '../client/nvidiaClient';
import { logInfo, logDebug, logError } from '../logger';
import { REWRITE_SYSTEM_PROMPT } from './styleSpec';

/* ────────────────────────────────────────────────────────
   Rewriter — Style Adapter Pass
   Takes a candidate that failed the style threshold and
   rewrites it to match the Claude-style spec.
   ──────────────────────────────────────────────────────── */

/**
 * Rewrite a candidate to strictly follow the Claude-style output format.
 *
 * Uses a non-streaming deterministic call (temperature=0) with the
 * rewrite system prompt to transform arbitrary model output into the
 * required 4-part structure.
 */
export async function rewriteToClaudeStyle(
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  logInfo('Running rewrite pass to enforce Claude-style format…');

  try {
    const rewritten = await chatCompletion({
      messages: [
        { role: 'system', content: REWRITE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Rewrite the following output into the required 4-part format (one-line summary, code block, tests, notes). Preserve ALL functionality and logic — only restructure the presentation.\n\n---\n\n${content}`,
        },
      ],
      temperature: 0,
      topP: 0.95,
      maxTokens: 4096,
      signal,
    });

    logDebug(`Rewrite complete (${rewritten.length} chars)`);
    return rewritten;
  } catch (err) {
    logError('Rewrite pass failed, returning original content', err);
    return content; // graceful fallback — don't lose the original
  }
}
