import * as assert from 'assert';

/* ────────────────────────────────────────────────────────
   Unit Tests — Claude-Style Quality Pipeline
   Tests programmatic scoring, structure checking, chain-of-
   thought detection, banned patterns, and rewrite triggering.
   Self-contained: replicates the scoring logic so we can
   run outside the VS Code Extension Development Host.
   ──────────────────────────────────────────────────────── */

/* ─── Replicated types and constants from src/style ─── */

interface ProgrammaticCheckResult {
  hasStructure: boolean;
  hasSummary: boolean;
  hasCodeBlock: boolean;
  hasTests: boolean;
  hasNotes: boolean;
  bannedPatternCount: number;
  hasChainOfThought: boolean;
  maxFunctionLength: number;
  multipleCodeBlocks: boolean;
}

const BANNED_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /process\.env\.\w+\s*(?:=|===|!==)/,
  /(?:password|secret|api_?key)\s*=\s*["']/i,
  /: any\b/,
];

const CHAIN_OF_THOUGHT_PATTERNS = [
  /^let me think/im,
  /^first,?\s+I(?:'ll|\s+will)/im,
  /^step \d+:/im,
  /^okay,?\s+so/im,
  /^now,?\s+let'?s/im,
  /^I'll start by/im,
  /^here'?s? (?:my|the) (?:approach|plan|thinking)/im,
];

const MAX_FUNCTION_LENGTH = 200;
const PROGRAMMATIC_WEIGHT = 0.6;
const LEARNED_WEIGHT = 0.4;

/* ─── Replicated scoring logic from src/style/critic.ts ─── */

function runChecks(text: string): ProgrammaticCheckResult {
  const hasSummary = /\*{0,2}one-line summary\*{0,2}[:\s]/i.test(text) || /^[A-Z][^.!?\n]{5,80}[.!]?\s*$/m.test(text);
  const codeBlockMatches = text.match(/```[\s\S]*?```/g) ?? [];
  const hasCodeBlock = codeBlockMatches.length >= 1;
  const hasTests = /\*{0,2}tests?\*{0,2}[:\s]/i.test(text) || /\bassert\b/i.test(text) || /\bconsole\.assert\b/i.test(text)
    || /\bexpect\b/i.test(text) || /\bit\s*\(/i.test(text) || /\btest\s*\(/i.test(text);
  const hasNotes = /\*{0,2}notes?\*{0,2}[:\s]/i.test(text) || /^[-•]\s+/m.test(text);
  const hasStructure = hasSummary && hasCodeBlock && hasTests && hasNotes;

  let bannedPatternCount = 0;
  for (const pattern of BANNED_PATTERNS) {
    for (const block of codeBlockMatches) {
      if (pattern.test(block)) { bannedPatternCount++; break; }
    }
  }

  let hasChainOfThought = false;
  for (const pattern of CHAIN_OF_THOUGHT_PATTERNS) {
    if (pattern.test(text)) { hasChainOfThought = true; break; }
  }

  const multipleCodeBlocks = codeBlockMatches.length > 3;
  const maxFunctionLength = estimateMaxFunctionLength(text);

  return {
    hasStructure, hasSummary, hasCodeBlock, hasTests, hasNotes,
    bannedPatternCount, hasChainOfThought, maxFunctionLength, multipleCodeBlocks,
  };
}

function estimateMaxFunctionLength(text: string): number {
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  let maxLen = 0;

  for (const block of codeBlocks) {
    const code = block.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    const lines = code.split('\n');
    let fnLen = 0;
    let inFn = false;

    for (const line of lines) {
      const trimmed = line.trim();
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

function programmaticScore(text: string): { score: number; checks: ProgrammaticCheckResult } {
  const checks = runChecks(text);
  let score = 100;

  if (!checks.hasStructure) { score -= 30; }
  if (!checks.hasSummary) { score -= 10; }
  if (!checks.hasCodeBlock) { score -= 20; }
  if (!checks.hasTests) { score -= 10; }
  if (!checks.hasNotes) { score -= 5; }
  score -= checks.bannedPatternCount * 10;
  if (checks.hasChainOfThought) { score -= 25; }
  if (checks.multipleCodeBlocks) { score -= 10; }
  if (checks.maxFunctionLength > MAX_FUNCTION_LENGTH) { score -= 15; }
  else if (checks.maxFunctionLength > 60) { score -= 5; }

  score = Math.max(0, Math.min(100, score));
  return { score, checks };
}

/* ─── Test data ─── */

const GOOD_CANDIDATE = `One-line summary: Add iterative Fibonacci function.

\`\`\`ts
export function fib(n: number): number {
  if (n < 0) throw new RangeError("n must be non-negative");
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) {
    [a, b] = [b, a + b];
  }
  return a;
}
\`\`\`

Tests:
\`\`\`ts
assert.strictEqual(fib(0), 0);
assert.strictEqual(fib(1), 1);
assert.strictEqual(fib(10), 55);
\`\`\`

Notes:
- O(n) time, O(1) space.
- Throws RangeError for negative input.`;

const BAD_CANDIDATE_NO_STRUCTURE = `Here is a Fibonacci function:

function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }

This is recursive and works for small values of n.`;

const BAD_CANDIDATE_COT = `Let me think about this step by step.

First, I'll consider the iterative approach since it's more efficient.

Step 1: Initialize two variables.
Step 2: Loop n times.

\`\`\`ts
export function fib(n: number): number {
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}
\`\`\``;

const BAD_CANDIDATE_EVAL = `One-line summary: Evaluate dynamic expression.

\`\`\`js
function compute(expr) {
  return eval(expr);
}
\`\`\`

Tests:
\`\`\`js
assert(compute("1+1") === 2);
\`\`\`

Notes:
- Uses eval for flexibility.`;

const BAD_CANDIDATE_SECRETS = `One-line summary: Connect to database.

\`\`\`ts
const password = "hunter2";
const apiKey = "sk-secret-12345";
function connect() {
  return db.connect({ password, apiKey });
}
\`\`\`

Tests:
\`\`\`ts
assert(connect() !== null);
\`\`\`

Notes:
- Hardcoded creds for testing.`;

/* ═══════════════════════════════════════════════════════════
   TEST SUITE
   ═══════════════════════════════════════════════════════════ */

suite('Style Pipeline — Programmatic Scoring', () => {

  // ── Structure detection ──

  test('detects complete 4-part structure in good candidate', () => {
    const { checks } = programmaticScore(GOOD_CANDIDATE);
    assert.strictEqual(checks.hasSummary, true);
    assert.strictEqual(checks.hasCodeBlock, true);
    assert.strictEqual(checks.hasTests, true);
    assert.strictEqual(checks.hasNotes, true);
    assert.strictEqual(checks.hasStructure, true);
  });

  test('detects missing structure in bad candidate', () => {
    const { checks } = programmaticScore(BAD_CANDIDATE_NO_STRUCTURE);
    assert.strictEqual(checks.hasCodeBlock, false);
    assert.strictEqual(checks.hasStructure, false);
  });

  test('good candidate scores high (>= 80)', () => {
    const { score } = programmaticScore(GOOD_CANDIDATE);
    assert.ok(score >= 80, `Expected >= 80, got ${score}`);
  });

  test('bad candidate (no structure) scores low (<= 50)', () => {
    const { score } = programmaticScore(BAD_CANDIDATE_NO_STRUCTURE);
    assert.ok(score <= 50, `Expected <= 50, got ${score}`);
  });

  // ── Chain-of-thought detection ──

  test('detects chain-of-thought patterns', () => {
    const { checks } = programmaticScore(BAD_CANDIDATE_COT);
    assert.strictEqual(checks.hasChainOfThought, true);
  });

  test('no chain-of-thought in good candidate', () => {
    const { checks } = programmaticScore(GOOD_CANDIDATE);
    assert.strictEqual(checks.hasChainOfThought, false);
  });

  test('chain-of-thought penalises score by 25', () => {
    // Build a candidate that is identical to GOOD_CANDIDATE but has CoT
    const withCot = `Let me think about this.\n\n${GOOD_CANDIDATE}`;
    const { score: goodScore } = programmaticScore(GOOD_CANDIDATE);
    const { score: cotScore } = programmaticScore(withCot);
    assert.ok(goodScore - cotScore >= 20, `Expected >= 20 penalty, got ${goodScore - cotScore}`);
  });

  // ── Banned patterns ──

  test('detects eval() in code blocks', () => {
    const { checks } = programmaticScore(BAD_CANDIDATE_EVAL);
    assert.ok(checks.bannedPatternCount >= 1, `Expected >= 1 banned pattern, got ${checks.bannedPatternCount}`);
  });

  test('detects hard-coded secrets', () => {
    const { checks } = programmaticScore(BAD_CANDIDATE_SECRETS);
    assert.ok(checks.bannedPatternCount >= 1, `Expected >= 1 banned pattern, got ${checks.bannedPatternCount}`);
  });

  test('no banned patterns in good candidate', () => {
    const { checks } = programmaticScore(GOOD_CANDIDATE);
    assert.strictEqual(checks.bannedPatternCount, 0);
  });

  // ── Multiple code blocks ──

  test('allows 2-3 code blocks (implementation + tests)', () => {
    const { checks } = programmaticScore(GOOD_CANDIDATE);
    assert.strictEqual(checks.multipleCodeBlocks, false);
  });

  test('flags > 3 code blocks as anti-pattern', () => {
    const manyBlocks = `Summary.\n\`\`\`ts\ncode1\n\`\`\`\n\`\`\`ts\ncode2\n\`\`\`\n\`\`\`ts\ncode3\n\`\`\`\n\`\`\`ts\ncode4\n\`\`\`\nassert(true);\nNotes:\n- ok`;
    const { checks } = programmaticScore(manyBlocks);
    assert.strictEqual(checks.multipleCodeBlocks, true);
  });

  // ── Function length estimation ──

  test('estimates reasonable function length for short function', () => {
    const { checks } = programmaticScore(GOOD_CANDIDATE);
    assert.ok(checks.maxFunctionLength < 60, `Expected < 60, got ${checks.maxFunctionLength}`);
  });

  // ── Score clamping ──

  test('score is clamped to [0, 100]', () => {
    const { score: goodScore } = programmaticScore(GOOD_CANDIDATE);
    assert.ok(goodScore >= 0 && goodScore <= 100);

    // Worst possible candidate
    const terrible = 'Let me think... here is my approach:\nStep 1: do stuff';
    const { score: badScore } = programmaticScore(terrible);
    assert.ok(badScore >= 0 && badScore <= 100);
  });
});

suite('Style Pipeline — Combined Scoring', () => {

  test('combined score = 0.6 * programmatic + 0.4 * learned', () => {
    const prog = 80;
    const learned = 60;
    const combined = PROGRAMMATIC_WEIGHT * prog + LEARNED_WEIGHT * learned;
    assert.strictEqual(combined, 72);
  });

  test('weights sum to 1.0', () => {
    const sum = PROGRAMMATIC_WEIGHT + LEARNED_WEIGHT;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Expected 1.0, got ${sum}`);
  });
});

suite('Style Pipeline — Rewrite Triggering', () => {
  const STYLE_THRESHOLD = 70;

  test('score above threshold does NOT trigger rewrite', () => {
    const { score } = programmaticScore(GOOD_CANDIDATE);
    assert.ok(score >= STYLE_THRESHOLD, `Good candidate should be above threshold. Score: ${score}`);
  });

  test('score below threshold triggers rewrite', () => {
    const { score } = programmaticScore(BAD_CANDIDATE_NO_STRUCTURE);
    assert.ok(score < STYLE_THRESHOLD, `Bad candidate should be below threshold. Score: ${score}`);
  });

  test('chain-of-thought candidate triggers rewrite', () => {
    const { score } = programmaticScore(BAD_CANDIDATE_COT);
    assert.ok(score < STYLE_THRESHOLD, `CoT candidate should be below threshold. Score: ${score}`);
  });
});

suite('Style Pipeline — JSON Extraction', () => {

  function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) { return fenced[1].trim(); }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) { return jsonMatch[0]; }
    return text.trim();
  }

  test('extracts raw JSON', () => {
    const input = '{"score": 85, "reason": "Good"}';
    assert.strictEqual(extractJson(input), '{"score": 85, "reason": "Good"}');
  });

  test('extracts JSON from code fences', () => {
    const input = '```json\n{"score": 90, "reason": "Excellent"}\n```';
    assert.strictEqual(extractJson(input), '{"score": 90, "reason": "Excellent"}');
  });

  test('extracts JSON from mixed text', () => {
    const input = 'Here is the score: {"score": 75, "reason": "Decent"} all done.';
    const json = extractJson(input);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.score, 75);
  });
});

suite('Style Pipeline — Few-Shot Examples', () => {

  // Replicate few-shot example structure
  const FEW_SHOT_EXAMPLES = [
    { user: 'Write a function that merges two objects shallowly.', assistant: 'One-line summary: Merge two plain objects shallowly.' },
    { user: 'Write a Python function that returns the n-th Fibonacci number (iterative).', assistant: 'One-line summary: Implement iterative Fibonacci function.' },
    { user: 'Write a TypeScript function that debounces another function.', assistant: 'One-line summary: Create a generic debounce wrapper with configurable delay.' },
  ];

  test('has at least 3 few-shot examples', () => {
    assert.ok(FEW_SHOT_EXAMPLES.length >= 3);
  });

  test('each example has user and assistant turns', () => {
    for (const ex of FEW_SHOT_EXAMPLES) {
      assert.ok(ex.user.length > 0, 'User prompt should not be empty');
      assert.ok(ex.assistant.length > 0, 'Assistant response should not be empty');
    }
  });

  test('assistant examples start with one-line summary', () => {
    for (const ex of FEW_SHOT_EXAMPLES) {
      assert.ok(ex.assistant.startsWith('One-line summary:'), `Expected "One-line summary:" prefix in: ${ex.assistant.slice(0, 40)}`);
    }
  });
});

suite('Style Pipeline — Code Generation Request Detection', () => {

  function isCodeGenerationRequest(goal: string): boolean {
    const lower = goal.toLowerCase().trim();
    const codeGenPatterns = [
      /^write\s+(a|an|me)\s+/,
      /^create\s+(a|an)\s+function/,
      /^implement\s+(a|an)?\s*/,
      /^generate\s+(a|an)?\s*/,
      /^how\s+(do|would|can)\s+(?:i|you)\s+(?:write|implement|create)/,
      /^(?:can you\s+)?(?:write|implement|code|make)\s+/,
      /function\s+that\b/,
      /class\s+that\b/,
      /algorithm\s+(?:for|to|that)\b/,
    ];
    const toolKeywords = [
      'file', 'fix errors', 'debug', 'refactor this', 'modify the',
      'edit the', 'update the', 'in my project', 'in my workspace',
      'current file', 'this file', 'open file',
    ];
    for (const kw of toolKeywords) {
      if (lower.includes(kw)) { return false; }
    }
    for (const pat of codeGenPatterns) {
      if (pat.test(lower)) { return true; }
    }
    return false;
  }

  test('detects "write a function" as code generation', () => {
    assert.strictEqual(isCodeGenerationRequest('Write a function that sorts an array'), true);
  });

  test('detects "implement a class" as code generation', () => {
    assert.strictEqual(isCodeGenerationRequest('Implement a LinkedList class that supports push and pop'), true);
  });

  test('detects "algorithm for" as code generation', () => {
    assert.strictEqual(isCodeGenerationRequest('Write an algorithm for finding the shortest path'), true);
  });

  test('does NOT detect workspace editing as code generation', () => {
    assert.strictEqual(isCodeGenerationRequest('Fix errors in my current file'), false);
  });

  test('does NOT detect file editing as code generation', () => {
    assert.strictEqual(isCodeGenerationRequest('Refactor this file to use async/await'), false);
  });

  test('does NOT detect workspace tasks as code generation', () => {
    assert.strictEqual(isCodeGenerationRequest('Update the login component in my project'), false);
  });
});
