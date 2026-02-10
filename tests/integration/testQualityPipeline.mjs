#!/usr/bin/env node
/* ────────────────────────────────────────────────────────
   Integration Test — Claude-Style Quality Pipeline
   Calls the real NVIDIA API, runs multi-candidate generation,
   programmatic + learned scoring, rewrite pass, and verifies
   the output meets production-quality standards.
   ──────────────────────────────────────────────────────── */

const API_KEY = process.env.NVIDIA_API_KEY;
const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'nvidia/llama-3.3-nemotron-super-49b-v1';
const K = 3;                    // candidate count
const CODE_TEMP = 0.05;         // deterministic
const STYLE_THRESHOLD = 70;

if (!API_KEY) {
  console.error('Set NVIDIA_API_KEY env var first.');
  process.exit(1);
}

/* ─── Replicated style constants ─── */

const BANNED_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /process\.env\.\w+\s*(?:=|===|!==)/,
  /(?:password|secret|api_?key)\s*=\s*["']/i,
  /: any\b/,
];

const COT_PATTERNS = [
  /^let me think/im,
  /^first,?\s+I(?:'ll|\s+will)/im,
  /^step \d+:/im,
  /^okay,?\s+so/im,
  /^now,?\s+let'?s/im,
  /^I'll start by/im,
  /^here'?s? (?:my|the) (?:approach|plan|thinking)/im,
];

const CLAUDE_SYSTEM = `You are a senior software engineer assistant. ALWAYS follow these output rules:
- Produce only final, production-ready output. Do NOT show chain-of-thought or internal reasoning.
- Output structure MUST be:
  1) **One-line summary** (imperative, present tense — like a commit message).
  2) A **single fenced code block** with the exact implementation. No extra commentary inside the code block.
  3) **Tests** — small, runnable tests demonstrating expected behaviour.
  4) **Notes** — 1-3 bullet points about assumptions, complexity, or risks.
- Be concise. Explanations must be ≤ 3 sentences.
- Use idiomatic patterns and follow common lint rules for the target language.
- Use descriptive variable names and keep functions under 60 lines.
- Never include chain-of-thought ("Let me think…", "First, I'll…", etc.).
- Never output multiple code blocks for a single implementation.`;

const FEW_SHOT = [
  {
    role: 'user',
    content: 'Write a function that merges two objects shallowly.',
  },
  {
    role: 'assistant',
    content: `One-line summary: Merge two plain objects shallowly.

\`\`\`js
export function merge(a, b) {
  return { ...a, ...b };
}
\`\`\`

Tests:
\`\`\`js
console.assert(JSON.stringify(merge({ x: 1 }, { y: 2 })) === JSON.stringify({ x: 1, y: 2 }));
console.assert(merge({ a: 1 }, { a: 2 }).a === 2);
\`\`\`

Notes:
- Shallow merge only — nested objects are not deep-cloned.
- Does not mutate inputs.
- O(n) where n = total keys.`,
  },
  {
    role: 'user',
    content: 'Write a Python function that returns the n-th Fibonacci number (iterative).',
  },
  {
    role: 'assistant',
    content: `One-line summary: Implement iterative Fibonacci function.

\`\`\`py
def fib(n: int) -> int:
    if n < 0:
        raise ValueError("n must be non-negative")
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\`\`\`

Tests:
\`\`\`py
assert fib(0) == 0
assert fib(1) == 1
assert fib(5) == 5
assert fib(10) == 55
\`\`\`

Notes:
- O(n) time, O(1) space.
- Raises ValueError for negative input.`,
  },
];

const CRITIC_PROMPT = `You are an objective code quality scorer. Rate the following candidate on a 0–100 scale for:
1. **Structure compliance** — does it follow the 4-part format (one-line summary, single code block, tests, notes)?
2. **Conciseness and clarity** — is the response brief, professional, with ≤ 3 sentences of prose?
3. **Idiomatic usage** — does the code follow language conventions and common lint rules?
4. **No chain-of-thought** — is the output free of internal reasoning / self-narration?

Return ONLY valid JSON: {"score": <int 0-100>, "reason": "<brief explanation>"}
Do NOT include any other text.`;

const REWRITE_SYSTEM = `You are a senior software engineer. Strictly rewrite the following output to match this exact format:
1) **One-line summary** — imperative, present-tense (commit-message style).
2) **Single fenced code block** — implementation only, no commentary inside.
3) **Tests** — small, runnable tests demonstrating expected behaviour.
4) **Notes** — 1-3 bullet points about assumptions, complexity, or risks.
Rules:
- Be very concise. Explanations ≤ 3 sentences.
- Do NOT include chain-of-thought or reasoning.
- Use idiomatic patterns and descriptive variable names.
- Keep functions under 60 lines where possible.
- Output the rewritten version ONLY — no meta-commentary about the rewrite.`;

/* ─── API Call ─── */

async function chat(messages, { temperature = 0.6, maxTokens = 4096 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature,
      top_p: 0.95,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NVIDIA API ${res.status}: ${body}`);
  }

  const json = await res.json();
  const usage = json.usage ?? {};
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    tokens: {
      prompt: usage.prompt_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      total: usage.total_tokens ?? 0,
    },
  };
}

/* ─── Programmatic Scoring ─── */

function programmaticScore(text) {
  const hasSummary =
    /\*{0,2}one-line summary\*{0,2}[:\s]/i.test(text) ||
    /^[A-Z][^.!?\n]{5,80}[.!]?\s*$/m.test(text);
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const hasCodeBlock = codeBlocks.length >= 1;
  const hasTests =
    /\*{0,2}tests?\*{0,2}[:\s]/i.test(text) ||
    /\bassert\b/i.test(text) ||
    /\bconsole\.assert\b/i.test(text) ||
    /\bexpect\b/i.test(text) ||
    /\bit\s*\(/i.test(text);
  const hasNotes = /\*{0,2}notes?\*{0,2}[:\s]/i.test(text) || /^[-•]\s+/m.test(text);
  const hasStructure = hasSummary && hasCodeBlock && hasTests && hasNotes;

  let bannedCount = 0;
  for (const pat of BANNED_PATTERNS) {
    for (const block of codeBlocks) {
      if (pat.test(block)) { bannedCount++; break; }
    }
  }

  let hasCot = false;
  for (const pat of COT_PATTERNS) {
    if (pat.test(text)) { hasCot = true; break; }
  }

  const multiBlocks = codeBlocks.length > 3;

  let score = 100;
  if (!hasStructure) score -= 30;
  if (!hasSummary) score -= 10;
  if (!hasCodeBlock) score -= 20;
  if (!hasTests) score -= 10;
  if (!hasNotes) score -= 5;
  score -= bannedCount * 10;
  if (hasCot) score -= 25;
  if (multiBlocks) score -= 10;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    hasSummary,
    hasCodeBlock,
    hasTests,
    hasNotes,
    hasStructure,
    bannedCount,
    hasCot,
    multiBlocks,
  };
}

/* ─── Learned Critic ─── */

async function learnedScore(text) {
  try {
    const { text: raw } = await chat(
      [
        { role: 'system', content: 'You are an objective code quality scorer. Return ONLY valid JSON.' },
        { role: 'user', content: `${CRITIC_PROMPT}\n\n---\n\n${text}` },
      ],
      { temperature: 0, maxTokens: 256 },
    );
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw.trim();
    const parsed = JSON.parse(jsonStr);
    return { score: Math.max(0, Math.min(100, parsed.score ?? 50)), reason: parsed.reason ?? '' };
  } catch {
    return { score: 50, reason: 'critic failed' };
  }
}

/* ─── Rewrite ─── */

async function rewrite(text) {
  const { text: rewritten } = await chat(
    [
      { role: 'system', content: REWRITE_SYSTEM },
      { role: 'user', content: `Rewrite into the required 4-part format. Preserve ALL functionality.\n\n---\n\n${text}` },
    ],
    { temperature: 0, maxTokens: 4096 },
  );
  return rewritten;
}

/* ─── Deep Quality Checks (production-readiness) ─── */

function productionReadinessCheck(text) {
  const issues = [];
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const code = codeBlocks.map((b) => b.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')).join('\n');

  // Error handling
  if (!/\b(try|catch|throw|raise|Error|Exception|if\s*\(.*(?:null|undefined|err))/i.test(code)) {
    issues.push('⚠️  No error handling detected');
  }

  // Type annotations (for TypeScript)
  if (/```ts/.test(text) && !/:\s*\w+/.test(code)) {
    issues.push('⚠️  No type annotations in TypeScript code');
  }

  // Edge case handling
  if (!/(?:if\s*\(|guard|assert|validate|check)/i.test(code)) {
    issues.push('⚠️  No input validation / edge case guards');
  }

  // JSDoc / docstring
  const hasDocstring = /\/\*\*|"""|'''|#\s+@/.test(code);

  // Reasonable code size (not trivially small)
  const codeLines = code.split('\n').filter((l) => l.trim().length > 0).length;

  return {
    issues,
    hasDocstring,
    codeLines,
    hasErrorHandling: issues.every((i) => !i.includes('error handling')),
    hasInputValidation: issues.every((i) => !i.includes('validation')),
  };
}

/* ─── Main Pipeline ─── */

const COMPLEX_TASK = `Write a production-ready TypeScript class \`RateLimiter\` that implements a sliding-window rate limiter with these requirements:

1. Constructor takes \`maxRequests: number\` and \`windowMs: number\`.
2. Method \`tryAcquire(key: string): { allowed: boolean; retryAfterMs: number }\` — returns whether the request is allowed and, if not, how long to wait.
3. Method \`reset(key: string): void\` — clears the window for a key.
4. Method \`getUsage(key: string): { used: number; remaining: number; resetMs: number }\` — returns current usage stats.
5. Must handle concurrent calls safely (no race conditions in single-threaded JS).
6. Must automatically clean up expired entries to prevent memory leaks (lazy cleanup).
7. Include comprehensive error handling and input validation.
8. Should be O(log n) or better per operation where n = requests in the window.
9. Include full unit tests with edge cases (empty window, burst, exactly-at-limit, expired entries).`;

async function main() {
  const hr = '═'.repeat(70);
  console.log(`\n${hr}`);
  console.log('  NVIDIA AI Agent — Claude-Style Quality Pipeline Integration Test');
  console.log(`${hr}\n`);
  console.log(`Model:       ${MODEL}`);
  console.log(`Candidates:  ${K}`);
  console.log(`Temperature: ${CODE_TEMP}`);
  console.log(`Threshold:   ${STYLE_THRESHOLD}`);
  console.log(`Task:        Sliding-window RateLimiter (TypeScript)\n`);

  const startAll = Date.now();

  // ═══ Phase 1: Generate k candidates ═══
  console.log('─── Phase 1: Generating candidates ───');
  const candidates = [];
  const messages = [
    { role: 'system', content: CLAUDE_SYSTEM },
    ...FEW_SHOT,
    { role: 'user', content: COMPLEX_TASK },
  ];

  for (let i = 0; i < K; i++) {
    const temp = Math.min(CODE_TEMP + i * 0.02, 0.15);
    console.log(`  Candidate ${i + 1}/${K} (temp=${temp.toFixed(2)})…`);
    const t0 = Date.now();
    const { text, tokens } = await chat(messages, { temperature: temp, maxTokens: 8192 });
    const elapsed = Date.now() - t0;
    candidates.push({ text, tokens, elapsed, index: i });
    console.log(`    ✓ ${text.length} chars, ${tokens.total} tokens, ${elapsed}ms`);
  }

  // ═══ Phase 2: Score candidates ═══
  console.log('\n─── Phase 2: Scoring candidates ───');
  for (const c of candidates) {
    // Programmatic
    const prog = programmaticScore(c.text);
    c.progScore = prog.score;
    c.progDetails = prog;

    // Learned
    console.log(`  Candidate ${c.index + 1}: running learned critic…`);
    const learned = await learnedScore(c.text);
    c.learnedScore = learned.score;
    c.learnedReason = learned.reason;

    // Combined
    c.combined = Math.round(0.6 * prog.score + 0.4 * learned.score);
    console.log(
      `    Prog=${prog.score} Learned=${learned.score} Combined=${c.combined}` +
        `  [struct=${prog.hasStructure} cot=${prog.hasCot} banned=${prog.bannedCount}]`,
    );
  }

  // Sort best-first
  candidates.sort((a, b) => b.combined - a.combined);
  let best = candidates[0];
  console.log(`\n  🏆 Best: Candidate ${best.index + 1} (score ${best.combined})`);

  // ═══ Phase 3: Rewrite if needed ═══
  let wasRewritten = false;
  if (best.combined < STYLE_THRESHOLD) {
    console.log(`\n─── Phase 3: Rewriting (score ${best.combined} < ${STYLE_THRESHOLD}) ───`);
    const t0 = Date.now();
    const rewritten = await rewrite(best.text);
    const elapsed = Date.now() - t0;
    console.log(`  ✓ Rewritten in ${elapsed}ms (${rewritten.length} chars)`);

    const verify = programmaticScore(rewritten);
    console.log(`  Post-rewrite programmatic score: ${verify.score}`);
    best = { ...best, text: rewritten, combined: verify.score, progScore: verify.score, progDetails: verify };
    wasRewritten = true;
  } else {
    console.log('\n─── Phase 3: Skipped (score above threshold) ───');
  }

  // ═══ Phase 4: Production-readiness audit ═══
  console.log('\n─── Phase 4: Production-readiness audit ───');
  const prod = productionReadinessCheck(best.text);
  console.log(`  Code lines:        ${prod.codeLines}`);
  console.log(`  Error handling:    ${prod.hasErrorHandling ? '✅' : '❌'}`);
  console.log(`  Input validation:  ${prod.hasInputValidation ? '✅' : '❌'}`);
  console.log(`  Has docstrings:    ${prod.hasDocstring ? '✅' : '❌'}`);
  if (prod.issues.length > 0) {
    for (const iss of prod.issues) console.log(`  ${iss}`);
  }

  // ═══ Final Report ═══
  const totalMs = Date.now() - startAll;
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  FINAL REPORT');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Final score:        ${best.combined}/100`);
  console.log(`  Was rewritten:      ${wasRewritten}`);
  console.log(`  Candidates scored:  ${candidates.map((c) => c.combined).join(', ')}`);
  console.log(`  Total pipeline:     ${totalMs}ms`);
  console.log(`  Total tokens:       ${candidates.reduce((s, c) => s + c.tokens.total, 0)}`);
  console.log();

  // Print the final output
  console.log('─── FINAL OUTPUT ───');
  console.log(best.text);
  console.log('─── END OUTPUT ───\n');

  // ═══ Assertions ═══
  const allPass = [];
  function check(label, cond) {
    const status = cond ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${status}  ${label}`);
    allPass.push(cond);
  }

  console.log('─── Quality Assertions ───');
  check('Final score ≥ 60', best.combined >= 60);
  check('Has 4-part structure', best.progDetails.hasStructure);
  check('Has one-line summary', best.progDetails.hasSummary);
  check('Has code block', best.progDetails.hasCodeBlock);
  check('Has tests', best.progDetails.hasTests);
  check('Has notes', best.progDetails.hasNotes);
  check('No chain-of-thought', !best.progDetails.hasCot);
  check('No banned patterns', best.progDetails.bannedCount === 0);
  check('Code ≥ 20 lines (non-trivial)', prod.codeLines >= 20);
  check('Has error handling', prod.hasErrorHandling);
  check('Has input validation', prod.hasInputValidation);

  // Content-specific checks for production readiness
  const text = best.text.toLowerCase();
  check('Mentions RateLimiter class', /ratelimiter/.test(text));
  check('Has tryAcquire method', /tryacquire/.test(text));
  check('Has reset method', /reset/.test(text));
  check('Has getUsage method', /getusage/.test(text));
  check('Has sliding window logic', /window|slide|sliding/.test(text));
  check('Has cleanup / expiry logic', /clean|expir|prune|gc|garbage/.test(text));

  const passed = allPass.filter(Boolean).length;
  const total = allPass.length;
  console.log(`\n  Result: ${passed}/${total} assertions passed`);

  if (passed === total) {
    console.log('\n  🎉 ALL CHECKS PASSED — Production-quality output confirmed!\n');
  } else {
    console.log(`\n  ⚠️  ${total - passed} check(s) failed — review output above.\n`);
  }

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Pipeline crashed:', err);
  process.exit(2);
});
