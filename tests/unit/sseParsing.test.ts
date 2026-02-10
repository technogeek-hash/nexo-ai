import * as assert from 'assert';

/* ────────────────────────────────────────────────────────
   Unit Tests — SSE Stream Parsing
   Tests the edge cases of SSE data line parsing logic
   used in nvidiaClient.ts.
   ──────────────────────────────────────────────────────── */

/** Replicated SSE parsing logic from nvidiaClient.ts for unit testing. */
function parseSseChunk(chunk: string): Array<{ token?: string; done?: boolean; usage?: any }> {
  const results: Array<{ token?: string; done?: boolean; usage?: any }> = [];
  const lines = chunk.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) { continue; }
    const payload = trimmed.slice(5).trim();

    if (payload === '[DONE]') {
      results.push({ done: true });
      continue;
    }

    try {
      const json = JSON.parse(payload);
      const token: string | null | undefined = json.choices?.[0]?.delta?.content;
      results.push({
        token: token ?? undefined,
        usage: json.usage,
      });
    } catch {
      // skip malformed
    }
  }

  return results;
}

suite('SSE Parsing', () => {
  test('parses a single token event', () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].token, 'Hello');
  });

  test('parses multiple events in one chunk', () => {
    const chunk = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      '',
    ].join('\n');
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].token, 'Hello');
    assert.strictEqual(results[1].token, ' world');
  });

  test('handles [DONE] signal', () => {
    const chunk = 'data: [DONE]\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].done, true);
  });

  test('skips empty lines', () => {
    const chunk = '\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].token, 'x');
  });

  test('skips lines without data: prefix', () => {
    const chunk = 'event: message\ndata: {"choices":[{"delta":{"content":"y"}}]}\nid: 123\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].token, 'y');
  });

  test('handles delta without content', () => {
    const chunk = 'data: {"choices":[{"delta":{}}]}\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].token, undefined);
  });

  test('handles usage in event', () => {
    const chunk = 'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15},"choices":[]}\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  test('skips malformed JSON', () => {
    const chunk = 'data: {bad json}\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 0);
  });

  test('handles mixed events with DONE', () => {
    const chunk = [
      'data: {"choices":[{"delta":{"content":"token1"}}]}',
      'data: {"choices":[{"delta":{"content":"token2"}}]}',
      'data: [DONE]',
    ].join('\n');
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].token, 'token1');
    assert.strictEqual(results[1].token, 'token2');
    assert.strictEqual(results[2].done, true);
  });

  test('handles data: with no space after colon', () => {
    const chunk = 'data:{"choices":[{"delta":{"content":"no-space"}}]}\n';
    const results = parseSseChunk(chunk);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].token, 'no-space');
  });
});
