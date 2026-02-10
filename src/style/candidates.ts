import { ChatMessage, CandidateResult } from '../types';
import { chatCompletion } from '../client/nvidiaClient';
import { getConfig } from '../config';
import { logInfo, logDebug, logError } from '../logger';
import { CLAUDE_STYLE_SYSTEM_PROMPT, buildFewShotMessages } from './styleSpec';

/* ────────────────────────────────────────────────────────
   Multi-Candidate Generation
   Generates k candidates from the model using low temperature
   for deterministic, high-quality code output.
   ──────────────────────────────────────────────────────── */

export interface GenerateOptions {
  /** The user's prompt / task. */
  prompt: string;
  /** System prompt to prepend (defaults to CLAUDE_STYLE_SYSTEM_PROMPT). */
  systemPrompt?: string;
  /** Additional context messages (e.g. workspace info, prior conversation). */
  contextMessages?: ChatMessage[];
  /** Number of candidates to generate (default: config.candidateCount). */
  k?: number;
  /** Temperature override (default: config.codeTemperature). */
  temperature?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
}

/**
 * Generate k candidate outputs for a given prompt.
 *
 * Each candidate is generated with a separate non-streaming API call
 * at low temperature to maximise determinism while still introducing
 * enough variety across candidates.
 */
export async function generateCandidates(opts: GenerateOptions): Promise<CandidateResult[]> {
  const cfg = getConfig();
  const k = opts.k ?? cfg.candidateCount;
  const temperature = opts.temperature ?? cfg.codeTemperature;
  const systemPrompt = opts.systemPrompt ?? CLAUDE_STYLE_SYSTEM_PROMPT;

  logInfo(`Generating ${k} candidates (temp=${temperature})`);

  // Build the base messages: system + few-shot + context + user prompt
  const fewShot = buildFewShotMessages();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...fewShot.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })),
    ...(opts.contextMessages ?? []),
    { role: 'user', content: opts.prompt },
  ];

  const candidates: CandidateResult[] = [];

  for (let i = 0; i < k; i++) {
    if (opts.signal?.aborted) { break; }

    opts.onProgress?.(`Generating candidate ${i + 1}/${k}…`);
    logDebug(`Generating candidate ${i + 1}/${k}`);

    try {
      // Slight temperature bump per candidate for diversity
      // Candidate 0: exact temp, Candidate 1: +0.02, Candidate 2: +0.04, …
      const candidateTemp = Math.min(temperature + i * 0.02, 0.15);

      const text = await chatCompletion({
        messages,
        temperature: candidateTemp,
        topP: 0.95,
        signal: opts.signal,
      });

      candidates.push({
        text,
        index: i,
        score: 0, // scored later by critic
      });
    } catch (err) {
      logError(`Candidate ${i + 1} generation failed`, err);
      // Continue generating remaining candidates
    }
  }

  logInfo(`Generated ${candidates.length}/${k} candidates`);
  return candidates;
}
