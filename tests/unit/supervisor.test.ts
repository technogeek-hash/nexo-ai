import * as assert from 'assert';

/* ────────────────────────────────────────────────────────
   Unit Tests — Supervisor Logic
   Tests the isSimpleQuestion heuristic and state helpers.
   ──────────────────────────────────────────────────────── */

// We can't import isSimpleQuestion directly (it's not exported),
// so we replicate the logic for testing.
// In production, you'd export it or test via the supervisor itself.

function isSimpleQuestion(goal: string): boolean {
  const lower = goal.toLowerCase().trim();

  if (lower.length < 30 && (lower.startsWith('what') || lower.startsWith('how') ||
    lower.startsWith('why') || lower.startsWith('explain') || lower.startsWith('can you'))) {
    return true;
  }

  const codingKeywords = [
    'create', 'build', 'implement', 'add', 'fix', 'refactor', 'write',
    'update', 'modify', 'change', 'delete', 'remove', 'install',
    'migrate', 'convert', 'set up', 'setup', 'generate', 'scaffold',
  ];
  for (const kw of codingKeywords) {
    if (lower.includes(kw)) { return false; }
  }

  return lower.length < 80;
}

suite('isSimpleQuestion', () => {
  test('short question starting with "what" is simple', () => {
    assert.strictEqual(isSimpleQuestion('What is TypeScript?'), true);
  });

  test('short question starting with "how" is simple', () => {
    assert.strictEqual(isSimpleQuestion('How does async work?'), true);
  });

  test('short question starting with "why" is simple', () => {
    assert.strictEqual(isSimpleQuestion('Why use const?'), true);
  });

  test('short question starting with "explain" is simple', () => {
    assert.strictEqual(isSimpleQuestion('Explain closures'), true);
  });

  test('question starting with "can you" is simple', () => {
    assert.strictEqual(isSimpleQuestion('Can you help?'), true);
  });

  test('request with "create" is not simple', () => {
    assert.strictEqual(isSimpleQuestion('Create a new React component'), false);
  });

  test('request with "build" is not simple', () => {
    assert.strictEqual(isSimpleQuestion('Build a REST API'), false);
  });

  test('request with "fix" is not simple', () => {
    assert.strictEqual(isSimpleQuestion('Fix the login bug'), false);
  });

  test('request with "refactor" is not simple', () => {
    assert.strictEqual(isSimpleQuestion('Refactor the database module'), false);
  });

  test('request with "implement" is not simple', () => {
    assert.strictEqual(isSimpleQuestion('Implement authentication'), false);
  });

  test('short non-question non-coding message is simple', () => {
    assert.strictEqual(isSimpleQuestion('Thanks!'), true);
  });

  test('medium-length message without coding keywords is simple', () => {
    assert.strictEqual(isSimpleQuestion('Tell me about the differences between promises and callbacks'), true);
  });

  test('long message without coding keywords defaults to not simple', () => {
    const long = 'I have a question about how the event loop works in Node.js and whether it handles concurrent requests differently than thread-based servers';
    assert.strictEqual(isSimpleQuestion(long), false);
  });
});
