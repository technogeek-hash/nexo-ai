/* ────────────────────────────────────────────────────────
   Style Pipeline — public API re-exports.
   ──────────────────────────────────────────────────────── */

export {
  CLAUDE_STYLE_SYSTEM_PROMPT,
  FEW_SHOT_EXAMPLES,
  buildFewShotMessages,
  REWRITE_SYSTEM_PROMPT,
  CRITIC_SCORING_PROMPT,
  PROGRAMMATIC_WEIGHT,
  LEARNED_WEIGHT,
  DEFAULT_STYLE_THRESHOLD,
  BANNED_PATTERNS,
  CHAIN_OF_THOUGHT_PATTERNS,
  MAX_FUNCTION_LENGTH,
} from './styleSpec';

export { generateCandidates } from './candidates';
export type { GenerateOptions } from './candidates';

export { programmaticScore, learnedScore, scoreCandidates } from './critic';

export { rewriteToClaudeStyle } from './rewriter';

export { runQualityPipeline } from './pipeline';
export type { PipelineOptions } from './pipeline';
