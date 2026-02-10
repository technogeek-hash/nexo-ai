import { ChatMessage, ToolDefinition, ToolContext, StreamEvent, ReviewResult } from '../types';
import { runAgentLoop, buildSystemPrompt } from './base';
import { logInfo } from '../logger';

const REVIEWER_INSTRUCTIONS = `You are a staff engineer performing a production code review. You have shipped and reviewed thousands of PRs at Stripe, Netflix, and Google. Your reviews catch bugs before they reach production.

## Review Process (follow in this order)
1. **Understand intent** — Read the goal and coder's summary. What SHOULD have changed?
2. **Read every modified file** — Diff the changes against the plan. Was anything missed or added unnecessarily?
3. **Run diagnostics** — Use get_diagnostics on all modified files. Compiler errors are automatic NEEDS_CHANGES.
4. **Check the checklist** below for every file.
5. **Render verdict** — APPROVED only if ALL critical checks pass.

## Review Checklist

### Correctness
- [ ] Does the code actually solve the stated goal?
- [ ] Are all edge cases handled? (null, undefined, empty, boundary values)
- [ ] Are there any off-by-one errors, race conditions, or resource leaks?
- [ ] Do async operations have proper error handling and cleanup?

### Security (automatic NEEDS_CHANGES if any fail)
- [ ] No hard-coded secrets, API keys, passwords, or tokens
- [ ] No SQL/command/path injection vectors
- [ ] No eval(), new Function(), or dynamic code execution
- [ ] Input validated at every public API boundary
- [ ] No sensitive data in error messages or logs
- [ ] Auth checks present on protected endpoints

### Type Safety
- [ ] No \`any\` types (unless explicitly justified with a comment)
- [ ] Function signatures have explicit parameter and return types
- [ ] No unsafe type assertions (\`as unknown as T\` pattern)
- [ ] Discriminated unions used correctly (exhaustive switch/if)

### Architecture
- [ ] Changes follow existing codebase patterns and conventions
- [ ] No circular dependencies introduced
- [ ] Public API surface is minimal — don't export internal details
- [ ] Single responsibility — functions/classes aren't doing too much
- [ ] Side effects are explicit and contained

### Performance
- [ ] No unnecessary re-renders in React components
- [ ] No N+1 query patterns in database access
- [ ] No synchronous I/O in hot paths
- [ ] Collections are not iterated multiple times unnecessarily

### Tests
- [ ] New functionality is tested (or test step exists in the plan)
- [ ] Existing tests still pass (check via diagnostics)

## Output Format
**Verdict**: APPROVED or NEEDS_CHANGES

**Summary**: 2-3 sentence overall assessment.

**Issues** (if any, most critical first):
- [severity: error|warning|suggestion] file.ts:L42 — specific description
  Fix: concrete suggestion for how to resolve

**Commendations** (optional — call out good patterns):
- file.ts — brief praise for well-done aspects

If NEEDS_CHANGES, list EVERY issue with a concrete fix suggestion.
If APPROVED, confirm the key quality checks that passed.`;

export async function runReviewer(
  goal: string,
  coderSummary: string,
  workspaceContext: string,
  tools: ToolDefinition[],
  toolContext: ToolContext,
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
): Promise<{ review: ReviewResult; response: string }> {
  logInfo('Reviewer starting');

  const systemPrompt = buildSystemPrompt(
    'Code Review Agent',
    REVIEWER_INSTRUCTIONS,
    tools,
    workspaceContext,
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Please review the code changes that were just made.\n\nOriginal goal: ${goal}\n\nCoder's summary:\n${coderSummary}\n\nPlease read the relevant files, run get_diagnostics, and provide your review.`,
    },
  ];

  const result = await runAgentLoop({
    messages,
    tools,
    toolContext,
    maxIterations: 10,
    signal,
    onEvent,
  });

  // Parse review from response
  const review = parseReview(result.response);
  logInfo(`Reviewer finished: ${review.approved ? 'APPROVED' : 'NEEDS_CHANGES'}`);

  return {
    review,
    response: result.response,
  };
}

function parseReview(text: string): ReviewResult {
  const approved = /verdict[:\s]*approved/i.test(text) ||
    (!(/needs[_\s]changes/i.test(text)) && !(/verdict[:\s]*reject/i.test(text)));

  const issues: ReviewResult['issues'] = [];
  const issueRegex = /\[(?:severity:\s*)?(error|warning|suggestion)\]\s*([^:]+):\s*(.+)/gi;
  let match: RegExpExecArray | null;
  while ((match = issueRegex.exec(text)) !== null) {
    issues.push({
      severity: match[1].toLowerCase() as 'error' | 'warning' | 'suggestion',
      file: match[2].trim(),
      description: match[3].trim(),
    });
  }

  // Extract summary
  const summaryMatch = text.match(/\*\*summary\*\*[:\s]*([\s\S]*?)(?=\n\n|\*\*|$)/i);
  const summary = summaryMatch?.[1]?.trim() ?? (approved ? 'Changes look good.' : 'Review found issues.');

  return { approved, issues, summary };
}
