import * as assert from 'assert';

/* ────────────────────────────────────────────────────────
   Unit Tests — Tool Call Parsing
   Tests the XML <tool_call> extraction from model output.
   Self-contained: replicates the parsing logic so we can
   run outside the VS Code Extension Development Host.
   ──────────────────────────────────────────────────────── */

interface ToolCallParsed {
  tool: string;
  args: Record<string, unknown>;
}

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function parseToolCalls(text: string): { text: string; toolCalls: ToolCallParsed[] } {
  const toolCalls: ToolCallParsed[] = [];
  let cleanText = text;

  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        toolCalls.push({
          tool: parsed.tool,
          args: parsed.args ?? {},
        });
      }
    } catch {
      // malformed JSON
    }
    cleanText = cleanText.replace(match[0], '');
  }

  TOOL_CALL_REGEX.lastIndex = 0;

  return { text: cleanText, toolCalls };
}

suite('parseToolCalls', () => {
  test('extracts a single tool call', () => {
    const input = `Let me read the file.\n\n<tool_call>\n{"tool": "read_file", "args": {"path": "src/index.ts"}}\n</tool_call>\n`;
    const { text, toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].tool, 'read_file');
    assert.deepStrictEqual(toolCalls[0].args, { path: 'src/index.ts' });
    assert.ok(text.includes('Let me read the file.'));
    assert.ok(!text.includes('tool_call'));
  });

  test('extracts multiple tool calls', () => {
    const input = `I'll read both files.

<tool_call>
{"tool": "read_file", "args": {"path": "a.ts"}}
</tool_call>

<tool_call>
{"tool": "read_file", "args": {"path": "b.ts"}}
</tool_call>

Done.`;
    const { text, toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 2);
    assert.strictEqual(toolCalls[0].args.path, 'a.ts');
    assert.strictEqual(toolCalls[1].args.path, 'b.ts');
    assert.ok(text.includes('Done.'));
  });

  test('handles no tool calls', () => {
    const input = 'This is just a plain text response.';
    const { text, toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 0);
    assert.strictEqual(text, input);
  });

  test('handles malformed JSON in tool call', () => {
    const input = '<tool_call>\nnot valid json\n</tool_call>';
    const { toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 0);
  });

  test('handles tool call without args', () => {
    const input = '<tool_call>\n{"tool": "get_workspace_structure"}\n</tool_call>';
    const { toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].tool, 'get_workspace_structure');
    assert.deepStrictEqual(toolCalls[0].args, {});
  });

  test('handles tool call with complex args', () => {
    const input = `<tool_call>
{"tool": "write_file", "args": {"path": "test.ts", "content": "const x = 1;\\nconst y = 2;"}}
</tool_call>`;
    const { toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].args.content, 'const x = 1;\nconst y = 2;');
  });

  test('strips tool call XML from text output', () => {
    const input = 'Before\n<tool_call>\n{"tool": "test", "args": {}}\n</tool_call>\nAfter';
    const { text } = parseToolCalls(input);
    assert.ok(!text.includes('<tool_call>'));
    assert.ok(!text.includes('</tool_call>'));
    assert.ok(text.includes('Before'));
    assert.ok(text.includes('After'));
  });

  test('ignores tool_call without tool property', () => {
    const input = '<tool_call>\n{"args": {"path": "test"}}\n</tool_call>';
    const { toolCalls } = parseToolCalls(input);
    assert.strictEqual(toolCalls.length, 0);
  });
});
