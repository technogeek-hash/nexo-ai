import { QualityPipelineResult, StreamEvent } from '../types';
import { getConfig } from '../config';
import { logInfo, logDebug, logError, logWarn } from '../logger';
import { generateCandidates, GenerateOptions } from './candidates';
import { scoreCandidates, programmaticScore } from './critic';
import { rewriteToClaudeStyle } from './rewriter';

/* ────────────────────────────────────────────────────────
   Quality Pipeline Orchestrator
   Generate → Critic/Rerank → Rewrite (if needed) → Verify

   This is the heart of the Claude-style quality system.
   It wraps any model call and ensures the output meets
   the style spec before returning it to the user.
   ──────────────────────────────────────────────────────── */

export interface PipelineOptions extends Omit<GenerateOptions, 'k' | 'temperature'> {
  /** Callback for streaming UI events. */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Run the full quality pipeline:
 *
 * 1. **Generate** — produce k candidates at low temperature.
 * 2. **Score** — programmatic checks + learned critic scoring.
 * 3. **Rerank** — pick the best candidate.
 * 4. **Rewrite** — if below style threshold, rewrite to Claude-style.
 * 5. **Verify** — re-score the rewritten output.
 * 6. **Return** — final text + score + diagnostics.
 */
export async function runQualityPipeline(opts: PipelineOptions): Promise<QualityPipelineResult> {
  const cfg = getConfig();
  const startTime = Date.now();

  opts.onEvent?.({ type: 'status', content: '🎨 Running quality pipeline…' });

  // ── 1. Generate candidates ──────────────────────────
  opts.onEvent?.({ type: 'status', content: `🎯 Generating ${cfg.candidateCount} candidates…` });
  const candidates = await generateCandidates({
    ...opts,
    k: cfg.candidateCount,
    temperature: cfg.codeTemperature,
    onProgress: (msg) => opts.onEvent?.({ type: 'status', content: msg }),
  });

  if (candidates.length === 0) {
    logError('Quality pipeline: no candidates generated');
    return {
      finalText: '',
      finalScore: 0,
      candidateCount: 0,
      wasRewritten: false,
      allScores: [],
      durationMs: Date.now() - startTime,
    };
  }

  // ── 2. Score & Rerank candidates ────────────────────
  opts.onEvent?.({ type: 'status', content: '📊 Scoring and reranking…' });
  const scored = await scoreCandidates(
    candidates,
    opts.signal,
    (msg) => opts.onEvent?.({ type: 'status', content: msg }),
  );

  const allScores = scored.map(c => c.score);
  let best = scored[0]; // Best after reranking

  logInfo(`Best candidate score: ${best.score} (threshold: ${cfg.styleThreshold})`);
  opts.onEvent?.({
    type: 'status',
    content: `📊 Best score: ${best.score}/100 (threshold: ${cfg.styleThreshold})`,
  });

  // ── 3. Rewrite if below threshold ──────────────────
  let wasRewritten = false;
  if (best.score < cfg.styleThreshold) {
    logWarn(`Best candidate (${best.score}) below threshold (${cfg.styleThreshold}). Running rewrite pass…`);
    opts.onEvent?.({ type: 'status', content: '✍️ Rewriting to match style…' });

    const rewritten = await rewriteToClaudeStyle(best.text, opts.signal);
    wasRewritten = true;

    // ── 4. Verify rewritten output ─────────────────────
    opts.onEvent?.({ type: 'status', content: '✅ Verifying rewritten output…' });
    const verification = programmaticScore(rewritten);

    best = {
      text: rewritten,
      index: best.index,
      score: verification.score, // Use programmatic score for verification
      scoring: {
        programmaticScore: verification.score,
        learnedScore: best.scoring?.learnedScore ?? 50,
        combinedScore: verification.score,
        checks: verification.checks,
        criticNotes: 'Rewritten to match style spec.',
      },
    };

    logInfo(`Post-rewrite score: ${best.score}`);
  }

  const durationMs = Date.now() - startTime;
  logInfo(`Quality pipeline complete in ${durationMs}ms — final score: ${best.score}`);

  opts.onEvent?.({
    type: 'status',
    content: `🎨 Style score: ${best.score}/100${wasRewritten ? ' (rewritten)' : ''} — ${durationMs}ms`,
  });

  return {
    finalText: best.text,
    finalScore: best.score,
    candidateCount: candidates.length,
    wasRewritten,
    allScores,
    durationMs,
  };
}
