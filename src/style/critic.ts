import { CandidateResult, StyleScore, ProgrammaticCheckResult } from '../types';
import { chatCompletion } from '../client/nvidiaClient';
import { logInfo, logDebug, logWarn, logError } from '../logger';
import {
  BANNED_PATTERNS,
  CHAIN_OF_THOUGHT_PATTERNS,
  MAX_FUNCTION_LENGTH,
  PROGRAMMATIC_WEIGHT,
  LEARNED_WEIGHT,
  CRITIC_SCORING_PROMPT,
} from './styleSpec';

/* ────────────────────────────────────────────────────────
   Critic — Programmatic checks + learned scoring + reranking
   ──────────────────────────────────────────────────────── */

/**
 * Run programmatic checks on a candidate's text.
 * Returns a 0-100 score and detailed check results.
 */
export function programmaticScore(text: string): { score: number; checks: ProgrammaticCheckResult } {
  const checks = runChecks(text);

  // Base score starts at 100 and is penalised
  let score = 100;

  // Structure compliance (big impact)
  if (!checks.hasStructure) { score -= 30; }
  if (!checks.hasSummary) { score -= 10; }
  if (!checks.hasCodeBlock) { score -= 20; }
  if (!checks.hasTests) { score -= 10; }
  if (!checks.hasNotes) { score -= 5; }

  // Banned patterns: -10 each
  score -= checks.bannedPatternCount * 10;

  // Chain of thought: heavy penalty
  if (checks.hasChainOfThought) { score -= 25; }

  // Multiple code blocks (anti-pattern)
  if (checks.multipleCodeBlocks) { score -= 10; }

  // Excessive function length
  if (checks.maxFunctionLength > MAX_FUNCTION_LENGTH) { score -= 15; }
  else if (checks.maxFunctionLength > 60) { score -= 5; }

  // Clamp to [0, 100]
  score = Math.max(0, Math.min(100, score));

  logDebug(`Programmatic score: ${score}`, checks);
  return { score, checks };
}

/**
 * Run the learned critic — ask the model to score a candidate 0-100.
 */
export async function learnedScore(
  text: string,
  signal?: AbortSignal,
): Promise<{ score: number; reason: string }> {
  try {
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: 'You are an objective code quality scorer. Return ONLY valid JSON.' },
        { role: 'user', content: `${CRITIC_SCORING_PROMPT}\n\n---\n\n${text}` },
      ],
      temperature: 0,
      maxTokens: 256,
      signal,
    });

    // Parse JSON from the response — handle markdown wrapping
    const jsonStr = extractJson(response);
    const parsed = JSON.parse(jsonStr);
    const score = typeof parsed.score === 'number'
      ? Math.max(0, Math.min(100, parsed.score))
      : 50; // fallback

    return {
      score,
      reason: parsed.reason ?? parsed.notes ?? '',
    };
  } catch (err) {
    logWarn('Learned critic failed, defaulting to 50', err);
    return { score: 50, reason: 'Critic evaluation failed.' };
  }
}

/**
 * Score and rank all candidates using combined programmatic + learned scoring.
 * Returns candidates sorted best-first with full StyleScore breakdowns.
 */
export async function scoreCandidates(
  candidates: CandidateResult[],
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<CandidateResult[]> {
  logInfo(`Scoring ${candidates.length} candidates…`);

  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) { break; }

    const candidate = candidates[i];
    onProgress?.(`Scoring candidate ${i + 1}/${candidates.length}…`);

    // Programmatic score (synchronous, fast)
    const prog = programmaticScore(candidate.text);

    // Learned score (async, calls model)
    const learned = await learnedScore(candidate.text, signal);

    // Combined score
    const combined = PROGRAMMATIC_WEIGHT * prog.score + LEARNED_WEIGHT * learned.score;

    candidate.score = Math.round(combined);
    candidate.scoring = {
      programmaticScore: prog.score,
      learnedScore: learned.score,
      combinedScore: Math.round(combined),
      checks: prog.checks,
      criticNotes: learned.reason,
    };

    logDebug(`Candidate ${i}: prog=${prog.score}, learned=${learned.score}, combined=${candidate.score}`);
  }

  // Sort best-first
  candidates.sort((a, b) => b.score - a.score);

  logInfo(`Scoring complete. Best: ${candidates[0]?.score ?? 0}, Worst: ${candidates[candidates.length - 1]?.score ?? 0}`);
  return candidates;
}

/* ───────────────── Internal: Programmatic Checks ───────────────── */

function runChecks(text: string): ProgrammaticCheckResult {
  const lower = text.toLowerCase();

  // Check for 4-part structure
  const hasSummary = /\*{0,2}one-line summary\*{0,2}[:\s]/i.test(text) || /^[A-Z][^.!?\n]{5,80}[.!]?\s*$/m.test(text);
  const codeBlockMatches = text.match(/```[\s\S]*?```/g) ?? [];
  const hasCodeBlock = codeBlockMatches.length >= 1;
  const hasTests = /\*{0,2}tests?\*{0,2}[:\s]/i.test(text) || /\bassert\b/i.test(text) || /\bconsole\.assert\b/i.test(text)
    || /\bexpect\b/i.test(text) || /\bit\s*\(/i.test(text) || /\btest\s*\(/i.test(text);
  const hasNotes = /\*{0,2}notes?\*{0,2}[:\s]/i.test(text) || /^[-•]\s+/m.test(text);
  const hasStructure = hasSummary && hasCodeBlock && hasTests && hasNotes;

  // Banned patterns
  let bannedPatternCount = 0;
  for (const pattern of BANNED_PATTERNS) {
    // Only check code blocks, not the entire text
    for (const block of codeBlockMatches) {
      if (pattern.test(block)) { bannedPatternCount++; break; }
    }
  }

  // Chain of thought
  let hasChainOfThought = false;
  for (const pattern of CHAIN_OF_THOUGHT_PATTERNS) {
    if (pattern.test(text)) { hasChainOfThought = true; break; }
  }

  // Multiple code blocks for implementation (more than 3 is suspicious — code + tests + example is OK)
  const multipleCodeBlocks = codeBlockMatches.length > 3;

  // Estimate max function length
  const maxFunctionLength = estimateMaxFunctionLength(text);

  return {
    hasStructure,
    hasSummary,
    hasCodeBlock,
    hasTests,
    hasNotes,
    bannedPatternCount,
    hasChainOfThought,
    maxFunctionLength,
    multipleCodeBlocks,
  };
}

/**
 * Rough estimate of the longest function in any code block.
 */
function estimateMaxFunctionLength(text: string): number {
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  let maxLen = 0;

  for (const block of codeBlocks) {
    const code = block.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    const lines = code.split('\n');

    // Simple heuristic: count consecutive lines between function-start patterns and closing braces / de-indent
    let fnLen = 0;
    let inFn = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // Function start heuristics
      if (/^(export\s+)?(async\s+)?function\b|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^def\s+\w+|^\s*(public|private|protected)\s+(async\s+)?\w+\s*\(/.test(trimmed)) {
        if (inFn && fnLen > maxLen) { maxLen = fnLen; }
        fnLen = 1;
        inFn = true;
      } else if (inFn) {
        fnLen++;
      }
    }
    if (inFn && fnLen > maxLen) { maxLen = fnLen; }
  }

  return maxLen;
}

/**
 * Extract JSON from a response that might be wrapped in markdown code fences.
 */
function extractJson(text: string): string {
  // Try to extract from code fences first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { return fenced[1].trim(); }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) { return jsonMatch[0]; }

  return text.trim();
}
