import { ChatMessage, ToolCallParsed, ToolResult, ToolDefinition, ToolContext, StreamEvent } from '../types';
import { chatCompletionStream } from '../client/nvidiaClient';
import { executeTool, toolDescriptionsForPrompt } from '../tools';
import { logDebug, logError, logInfo, logWarn } from '../logger';
import { getConfig } from '../config';
import { CLAUDE_STYLE_SYSTEM_PROMPT, buildFewShotMessages } from '../style/styleSpec';

/* ────────────────────────────────────────────────────────
   ReAct Agent — the core reasoning + acting loop.
   Each specialised agent (planner, coder, reviewer)
   extends this with its own system prompt.
   ──────────────────────────────────────────────────────── */

export interface AgentRunOptions {
  /** Conversation messages so far (system + user + prior assistant turns). */
  messages: ChatMessage[];
  /** Available tools.  Omit to disable tool use. */
  tools?: ToolDefinition[];
  /** Context passed to tool executors. */
  toolContext?: ToolContext;
  /** Max ReAct iterations before forcing stop. */
  maxIterations?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Callback for streaming events (text, tool calls, results, …). */
  onEvent?: (event: StreamEvent) => void;
  /** Whether think mode is active — enables <think> block parsing. */
  thinkMode?: boolean;
}

export interface AgentRunResult {
  /** The agent's final text response. */
  response: string;
  /** All tool calls made during the run. */
  toolCalls: ToolResult[];
  /** Number of iterations used. */
  iterations: number;
}

/**
 * Run the ReAct loop:
 *   1. Send messages → model
 *   2. Stream the response; parse any `<tool_call>` blocks
 *   3. Execute tool calls, inject results as new messages
 *   4. Repeat until the model produces no more tool calls (or limit is hit)
 */
export async function runAgentLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
  const {
    messages,
    tools = [],
    toolContext,
    maxIterations = 40,
    signal,
    onEvent,
  } = opts;

  const conversation: ChatMessage[] = [...messages];
  const allToolResults: ToolResult[] = [];
  let iterations = 0;
  let finalResponse = '';

  while (iterations < maxIterations) {
    if (signal?.aborted) {
      onEvent?.({ type: 'error', content: 'Cancelled by user.' });
      break;
    }

    iterations++;
    logInfo(`Agent iteration ${iterations}/${maxIterations}`);
    onEvent?.({ type: 'status', content: `Thinking… (step ${iterations})` });

    // ── 1. Stream completion ──────────────────────────────
    let fullText = '';
    try {
      fullText = await chatCompletionStream(
        { messages: conversation, signal },
        {
          onToken(token: string) {
            // Don't stream tool_call XML tags to the user
            // We'll handle display after parsing
          },
          onDone() { /* handled below */ },
          onError(err: Error) {
            logError('Stream error', err);
            onEvent?.({ type: 'error', content: err.message });
          },
        },
      );
    } catch (err) {
      if (signal?.aborted) { break; }
      logError('Agent stream failed', err);
      onEvent?.({ type: 'error', content: err instanceof Error ? err.message : String(err) });
      break;
    }

    // ── 2. Parse tool calls from response ─────────────────
    const { text: rawText, toolCalls } = parseToolCalls(fullText);

    // ── 2b. Parse <think> blocks if think mode is active ──
    let displayText = rawText;
    if (opts.thinkMode) {
      const { text: cleanText, thinking } = parseThinkBlocks(rawText);
      displayText = cleanText;
      if (thinking) {
        onEvent?.({ type: 'thinking', content: thinking });
      }
    }

    // Stream the non-tool-call text to the UI
    if (displayText.trim()) {
      onEvent?.({ type: 'text', content: displayText.trim() });
    }

    // Add assistant message to conversation
    conversation.push({ role: 'assistant', content: fullText });

    // ── 3. No tool calls → done ───────────────────────────
    if (toolCalls.length === 0) {
      finalResponse = displayText.trim();
      break;
    }

    // ── 4. Execute tool calls ─────────────────────────────
    const resultParts: string[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) { break; }

      onEvent?.({ type: 'tool_call', content: tc.tool, data: tc.args });
      logInfo(`Tool call: ${tc.tool}`, tc.args);

      const start = Date.now();
      let result: { result: string; success: boolean };

      if (toolContext && tools.length > 0) {
        result = await executeTool(tools, tc.tool, tc.args, toolContext);
      } else {
        result = { result: `Tool "${tc.tool}" is not available.`, success: false };
      }

      const elapsed = Date.now() - start;
      allToolResults.push({ tool: tc.tool, args: tc.args, ...result, durationMs: elapsed });

      onEvent?.({
        type: 'tool_result',
        content: truncate(result.result, 2000),
        data: { tool: tc.tool, success: result.success, durationMs: elapsed },
      });

      resultParts.push(
        `<tool_result tool="${tc.tool}" success="${result.success}">\n${truncate(result.result, 12_000)}\n</tool_result>`,
      );
    }

    // Inject tool results back into conversation
    conversation.push({
      role: 'tool_result',
      content: resultParts.join('\n\n'),
    });

    // Save the non-tool text as partial response
    finalResponse = displayText.trim();
  }

  if (iterations >= maxIterations) {
    logWarn('Agent hit max iterations');
    onEvent?.({ type: 'status', content: 'Reached maximum steps.' });
  }

  onEvent?.({ type: 'done', content: finalResponse });
  return { response: finalResponse, toolCalls: allToolResults, iterations };
}

/* ───────────────── Tool-call parsing ───────────────── */

/**
 * Extract <think>…</think> blocks from model output.
 * Returns the cleaned text and the concatenated thinking content.
 */
export function parseThinkBlocks(text: string): { text: string; thinking: string } {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  let thinking = '';
  let cleanText = text;

  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(text)) !== null) {
    thinking += match[1].trim() + '\n';
    cleanText = cleanText.replace(match[0], '');
  }

  return { text: cleanText.trim(), thinking: thinking.trim() };
}

export function parseToolCalls(text: string): { text: string; toolCalls: ToolCallParsed[] } {
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const toolCalls: ToolCallParsed[] = [];
  let cleanText = text;

  let match: RegExpExecArray | null;
  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        toolCalls.push({
          tool: parsed.tool,
          args: parsed.args ?? {},
        });
      }
    } catch (err) {
      logWarn('Failed to parse tool call JSON', match[1]);
    }
    cleanText = cleanText.replace(match[0], '');
  }

  return { text: cleanText, toolCalls };
}

/* ───────────────── System prompt builder ───────────────── */

export function buildSystemPrompt(
  role: string,
  roleInstructions: string,
  tools: ToolDefinition[],
  workspaceContext: string,
): string {
  const cfg = getConfig();
  const styleBlock = cfg.styleEnforcement
    ? `\n## Output Style Rules\n\n${CLAUDE_STYLE_SYSTEM_PROMPT}\n`
    : '';

  return `# ${role}

${roleInstructions}
${styleBlock}
${tools.length > 0 ? toolDescriptionsForPrompt(tools) : ''}

${tools.length > 0 ? TOOL_CALLING_INSTRUCTIONS : ''}

## Workspace Context

${workspaceContext}
`;
}

/**
 * Build few-shot example messages to inject after the system prompt.
 * Returns an empty array when style enforcement is disabled.
 */
export function buildStyleFewShotMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
  const cfg = getConfig();
  return cfg.styleEnforcement ? buildFewShotMessages() : [];
}

const TOOL_CALLING_INSTRUCTIONS = `## How to Use Tools

To call a tool, output a tool call block in this EXACT format:

<tool_call>
{"tool": "tool_name", "args": {"param1": "value1"}}
</tool_call>

Rules:
- You can make MULTIPLE tool calls in a single response
- Each tool call must be valid JSON inside <tool_call> tags
- After tool calls are executed, you will receive results in <tool_result> tags
- ALWAYS read files before editing them
- Use edit_file for targeted changes; use write_file for new files or full rewrites
- For edit_file, old_text must match the file EXACTLY (including whitespace)
- Include 2-3 lines of surrounding context in old_text for unique matching
- After making edits, use get_diagnostics to check for errors
- Explain your reasoning BEFORE making changes
- If a tool call fails, analyze the error and try a different approach
`;

function truncate(s: string, max: number): string {
  if (s.length <= max) { return s; }
  return s.slice(0, max) + `\n… (truncated, ${s.length - max} chars omitted)`;
}
