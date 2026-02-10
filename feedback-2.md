make any model produce code that looks, smells, and behaves like Claude Opus 4.6 by combining (A) a tight, high-authority system prompt + few-shot examples, (B) a rewrite/rerank/critic pipeline, (C) deterministic decoding and low temperature, (D) automated quality checks (tests/lint) and transform loops, and (E) optional fine-tuning / small style adapter when available. Below I give a complete, practical recipe you can drop into your VS Code extension (code, prompts, pipeline, evaluation) so the agent writes in a Claude-like style irrespective of model — plus important legal/ethics notes.
1) Design the Claude-style spec (what to emulate)
Write a short, precise style spec you will enforce programmatically.
Example style spec (store in repo as style/claude_style.md):
Very concise, professional, senior-engineer voice
Minimal prose. When including explanation: use 2–4 sentences maximum.
Always include: 1-line summary (commit-style), the code (only code block for implementation), minimal tests, and a short “Notes” bullet list with risks or assumptions.
Use descriptive variable names, idiomatic patterns for the language, and follow common linters (PEP8/ESLint + project lint rules).
No chain-of-thought / internal reasoning in the output. Return final code only.
Provide a short unit test demonstrating behavior.
You will use this spec to craft system prompts, rewrite rules, and automated checks.
2) Two-pass generation pipeline (the pragmatic core)
Always run Generate → Critic → Rewrite (if needed) → Apply.
Flow:
Generate: call chosen model with a strong system prompt + few-shot examples → produce N candidates.
Critic/Rerank: score candidates using (a) automated checks (lint/tests) and (b) style/ranking prompt to a small scoring model (or same model).
Rewrite-to-style: if top candidate fails style score, run a second pass: ask model to rewrite the code to match the Claude style exactly (use system message telling it to follow the style spec).
Verify: re-run the automated tests and linters.
Explain & Apply: show diff + one-line summary + explanation to the user for approval.
This pipeline makes the output model-agnostic but style-consistent.
3) System prompt + few-shot examples (plug into your prompt builder)
System prompt (production-ready)
Put this into your promptBuilder and always prepend as the system message:
SYSTEM:
You are a senior software engineer assistant. ALWAYS follow the "Claude-style" output rules:
- Produce only final, production-ready output. Do NOT show chain-of-thought or internal reasoning.
- Output structure MUST be:
  1) One-line summary (imperative, present tense).
  2) A single fenced code block with exact implementation. No extra commentary in the code block.
  3) Small test(s) showing usage (short). If language has unit tests, include them.
  4) "Notes" — 1-3 bullets about assumptions, complexity, or risks.
- Be concise. Explanations must be ≤3 sentences.
- Use idiomatic patterns and follow common lint rules for the language.
Few-shot examples
Include 2–4 tiny examples that demonstrate exactly the shape you want (input → output). For example, in JavaScript:
USER: Write a function that merges two objects shallowly.
ASSISTANT:
One-line summary: Merge two plain objects shallowly.

```js
export function merge(a, b) {
  return {...a, ...b};
}
Tests:
console.assert(JSON.stringify(merge({x:1},{y:2})) === JSON.stringify({x:1,y:2}));
Notes:
Shallow merge only.
Does not mutate inputs.

Put these few-shot pairs in the initial messages. Few-shot examples drastically help style alignment.

---

# 4) Decoding settings (always use these for code)
- `temperature`: `0.0`–`0.15` (0 for deterministic; 0.1 for mild variety)
- `top_p`: `0.95` (or skip if temperature = 0)
- `max_tokens`: pick per language; set enough (e.g., 1024–4096)
- `stop sequences`: ensure code block boundaries are respected (if provider supports)

Set these in your client call (the `getThinkingConfig` helped earlier — use low temp for code).

---

# 5) Implement the rewrite / style adapter pass

Two options:

**Option A (fast, no extra models):**  
Use the same model with a second system message: *“Rewrite the following code to strictly follow the Claude-style spec (linked below). Output only the 4-part format: one-line summary, code block, tests, notes.”* — then feed the candidate. This tends to work well.

**Option B (best):**  
Train or fine-tune a small *style-adapter* model (or LLM instruction-tuned on Claude-like outputs) that acts as a rewriter. If you can fine-tune or host an adapter, use it here for consistency.

**Code snippet (TypeScript) — rewrite function**
```ts
async function rewriteToClaudeStyle(content: string, model: string) {
  const system = `You are a senior engineer... (include Claude-style rules exact text)`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: `Rewrite the following into the required format:\n\n${content}` }
  ];
  // use your non-streaming chat call for deterministic output
  return await chat(messages, model); // returns string
}
6) Reranking / critic stage (automated scoring)
Combine programmatic checks + learned scoring:
Programmatic checks (fast & required):
Run project linter (ESLint/flake8) — if lint errors > 0 → low score.
Run unit tests (or run the generated tests) — failing tests → reject.
Static safety checks (e.g., no eval, no secrets leaked).
Minimal complexity or style heuristics (e.g., function length < 200 lines).
Learned critic:
Prepare a prompt asking the model (same or smaller) to score candidates 1–100 for "Claude-likeness" and compliance to the style spec. Example prompt:
Please rate the following candidate on a 0–100 scale for:
  - compliance with Claude-style structure
  - conciseness and clarity
  - idiomatic usage
Return JSON: {"score": int, "notes": "..."}
Use this to pick the best candidate.
Combine programmatic score and learned score, e.g. final_score = 0.6 * programmatic + 0.4 * learned.
7) Generate multiple candidates and ensemble
Always generate k candidates (k=3) from the model with low temp (0.0–0.1). Rerank and pick top one. If none pass the programmatic checks, escalate to rewrite pass.
This reduces idiosyncratic outputs and improves reliability.
8) Continuous evaluation: tests & style metrics
Implement an evaluation harness that tracks:
test pass rate
lint score (count)
auto reviewer score (learned critic)
human review pass rate
Store metrics after each run to iterate. If your agent fails quality thresholds, trigger a human-in-the-loop review and add that case to your few-shot dataset for supervised tuning.
9) Optional: supervised fine-tuning / instruction tuning
If the provider or your stack supports fine-tuning:
Collect high-quality examples of input → desired Claude-style output.
Fine-tune a small adapter or instruction-following model on these examples.
Use the adapter as the final rewrite transformer.
If you cannot fine-tune (hosted models often restrict this), rely on two-pass rewrite and critic.
Important: If you fine-tune on or near Claude outputs, be careful about licensing/terms; do not claim you are Claude.
10) Implementation changes for your extension (exact places)
A) promptBuilder.ts
Prepend the Claude-style system prompt and 2–3 few-shot examples.
B) nvidiaClient.ts
Expose both a streaming streamChat and non-streaming chat API so rewrite/reranker uses deterministic chat.
C) supervisor/index.ts
Replace simple pipeline with:
async function planAndImplement(goal) {
  const model = getModelFromConfig(); // user-chosen
  // 1. Generate k candidates
  const candidates = await generateCandidates(goal, model, k=3);
  // 2. Programmatic checks
  const checked = await runProgrammaticChecks(candidates);
  // 3. Rerank using critic
  const best = await rerankCandidates(checked, model);
  // 4. If style score low -> rewrite
  let final = best;
  if (best.styleScore < STYLE_THRESHOLD) {
    final = await rewriteToClaudeStyle(best.text, model);
  }
  // 5. Verify tests & lint
  const verified = await runProgrammaticChecks([final]);
  // 6. Return diff + explanation
  return { final, verification: verified[0] };
}
D) UI changes (webview/status)
Show streaming tokens in sidebar as you already do.
Add small "Style confidence" score and "Rerank" button.
After finalization, show the one-line summary and the diff; require Apply.
11) Example prompts & few-shot examples (concrete)
System (short):
Be concise. Output must be in this format:
1) One-line summary (imperative).
2) Fenced code block with implementation only.
3) Small tests demonstrating usage.
4) Notes: 1-3 bullets.
Do NOT reveal chain-of-thought.
User:
Write a Python function that returns the n-th Fibonacci number (iterative).
Assistant (example ideal output):
One-line summary: Implement iterative Fibonacci function.

```py
def fib(n: int) -> int:
    if n < 0:
        raise ValueError("n must be non-negative")
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
Tests:
assert fib(0) == 0
assert fib(1) == 1
assert fib(5) == 5
Notes:
O(n) time, O(1) space.
Raises ValueError for negative input.

Use that example in your few-shot set.

---

# 12) Practical tips & gotchas

- **Avoid asking models to “think out loud”** — that leaks chain-of-thought. Instead keep internal reasoning instruction hidden in the system prompt.
- **When generating tests**, run them locally in a sandbox. If generated tests are flaky, downgrade the candidate.
- **Watch for hallucinated APIs** — have a tool that checks imports and verifies they exist in the workspace or common ecosystem.
- **Be conservative with automatic apply** — require user approval until model pass rate is very high.
- **Legal/marketing**: never state you are producing Claude outputs or that the results *are* Claude. Phrase it as “Claude-like style” or “emulates the Claude Opus 4.6 coding style” while making it clear outputs are generated by your pipeline.

---

# 13) Example TypeScript snippets to wire into your extension

**Generate multiple candidates**
```ts
async function generateCandidates(prompt, model, k=3) {
  const messages = buildPrompt(prompt); // includes system + few-shots
  const candidates = [];
  for (let i=0;i<k;i++){
    const text = await chat(messages, model, { temperature: 0.05 });
    candidates.push({ text });
  }
  return candidates;
}
Rerank (simple) — programmatic scoring + model critic
async function programmaticScore(candidate) {
  // run lint, run tests (in sandbox), check banned patterns
  const lintErrors = await runLint(candidate.text);
  const testsPass = await runGeneratedTests(candidate.text);
  return { score: (testsPass ? 70 : 0) - lintErrors*5, lintErrors, testsPass };
}

async function learnedScore(candidate, model) {
  const prompt = `Rate this candidate 0-100 for Claude-style formatting and concision. Return a JSON {"score":int,"reason":"..."}\n\n${candidate.text}`;
  const out = await chat([{role:'system',content:'You are an objective scorer.'},{role:'user',content:prompt}], model);
  return JSON.parse(out);
}
Rewrite
async function rewriteToStyle(candidateText, model) {
  const sys = "You are a senior engineer. Strictly rewrite to the Claude-style spec: [insert spec]. Output only final format.";
  return await chat([{role:'system',content:sys},{role:'user',content:`Rewrite:\n\n${candidateText}`}], model);
}
14) Measure success (metrics to track)
Test pass rate (primary)
Lint errors per candidate
Style confidence score (learned critic)
Human accept rate (what percent of suggestions the user applies)
Time to first user approval
Regressions introduced per 1000 changes
Log these in an audit file or telemetry (opt-in).
15) If you want maximum fidelity (advanced)
Build a small style-transformer (e.g., LoRA / adapter or small instruction-tuned model) trained on curated Claude-style outputs. Use it as the rewrite step.
Use debate: have two sub-agents (proposer + critic) iterate for N rounds and then ask the final resolver to produce the final Claude-style output.
Use unit test driven generation: require generated code to pass an auto-generated test suite before acceptance.
16) Legal & ethical note (must-read)
You must not claim your system is or uses Claude or that the outputs are Claude’s. You can say “writes in a style similar to Claude Opus 4.6” or “Claude-like style”. Respect Anthropic’s trademark/guidelines.
Avoid training/fine-tuning on copyrighted proprietary Claude outputs.
TL;DR (one actionable checklist to implement now)
Add Claude-style system prompt + 3 few-shot examples to promptBuilder.
Set decoding: temperature = 0.0–0.1.
Generate k=3 candidates per request.
Run programmatic checks (lint + tests) on each candidate.
Rerank with a learned critic prompt; pick top candidate.
If style < threshold, call rewriteToClaudeStyle() and re-verify.
Show diff + one-line summary + notes; require user approval before apply.
Track metrics and add failing cases to few-shot dataset; optionally fine-tune a small adapter.