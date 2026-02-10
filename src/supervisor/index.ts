import * as vscode from 'vscode';
import { StreamEvent, ToolContext, ToolDefinition, FileEdit, ChatMessage } from '../types';
import { getConfig } from '../config';
import { logInfo, logError, getOutputChannel } from '../logger';
import { buildToolRegistry } from '../tools';
import { gatherWorkspaceContext } from '../context/workspace';
import { runPlanner } from '../agents/planner';
import { runCoder } from '../agents/coder';
import { runReviewer } from '../agents/reviewer';
import { runAgentLoop, buildSystemPrompt, buildStyleFewShotMessages } from '../agents/base';
import { createAgentState, updateState, recordEdits } from './state';
import { runQualityPipeline } from '../style/pipeline';
import { CLAUDE_STYLE_SYSTEM_PROMPT } from '../style/styleSpec';
import { runSubAgentPipeline, assessComplexity } from './subAgentManager';
import { isAppCreationRequest, runAppCreationPipeline } from './appOrchestrator';import { MemoryStore } from '../memory/store';
import { retrieveContext, initRAGIndex } from '../rag';
import { getMCPTools, connectMCPServers } from '../mcp';
import { Attachment, buildAttachmentContext, getImageAttachments } from '../context/attachments';
/* ────────────────────────────────────────────────────────
   Supervisor — orchestrates four execution paths:

   Path A — Simple Question → single-agent general assistant
   Path B — Standard Coding → Planner → Coder → Reviewer → Fix
   Path C — Complex Enterprise → Dynamic sub-agent decomposition
            (parallel execution, domain specialists)
   Path D — Full App Creation → Architect → Scaffold → Backend
            → Frontend → Testing → Security → DevOps → Docs

   Routing is automatic:
     • isAppCreationRequest(goal)   → Path D
     • assessComplexity(goal) ≥ 50  → Path C
     • isSimpleQuestion(goal)       → Path A
     • else                         → Path B
   ──────────────────────────────────────────────────────── */

export interface SupervisorOptions {
  goal: string;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Additional context messages (e.g. prior conversation). */
  priorMessages?: ChatMessage[];
  /** Persistent memory store (if enabled). */
  memoryStore?: MemoryStore;
  /** File/image attachments for this request. */
  attachments?: Attachment[];
  /** Whether think mode is active for this request. */
  thinkMode?: boolean;
}

export interface SupervisorResult {
  success: boolean;
  response: string;
  editsApplied: FileEdit[];
}

export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorResult> {
  const { goal, signal, onEvent, priorMessages = [], memoryStore, attachments = [], thinkMode } = opts;
  const cfg = getConfig();

  // ── Resolve workspace root ──
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    const msg = 'No workspace folder is open. Please open a folder first.';
    onEvent?.({ type: 'error', content: msg });
    return { success: false, response: msg, editsApplied: [] };
  }
  const workspaceRoot = wsFolder.uri.fsPath;

  // ── Build tools and context ──
  const tools: ToolDefinition[] = buildToolRegistry();

  // Merge MCP tools if enabled
  if (cfg.enableMCP) {
    try {
      const mcpTools = getMCPTools();
      if (mcpTools.length > 0) {
        tools.push(...mcpTools);
        logInfo(`Merged ${mcpTools.length} MCP tools into tool registry`);
      }
    } catch (err) {
      logError('Failed to load MCP tools', err);
    }
  }

  const toolContext: ToolContext = {
    workspaceRoot,
    outputChannel: getOutputChannel(),
    token: undefined,
    onProgress: (msg) => onEvent?.({ type: 'status', content: msg }),
  };

  let workspaceContext = await gatherWorkspaceContext(workspaceRoot);

  // ── Inject persistent memory context ──
  if (memoryStore && cfg.enableMemory) {
    const memoryBlock = memoryStore.buildContextBlock(goal);
    if (memoryBlock) {
      workspaceContext = `${workspaceContext}\n\n${memoryBlock}`;
      logInfo(`Injected ${memoryBlock.length} chars of memory context`);
    }
  }

  // ── Inject RAG context ──
  if (cfg.enableRAG) {
    try {
      await initRAGIndex(workspaceRoot);
      const ragResult = retrieveContext(goal, workspaceRoot);
      if (ragResult.contextBlock) {
        workspaceContext = `${workspaceContext}\n\n${ragResult.contextBlock}`;
        logInfo(`RAG injected ${ragResult.results.length} relevant chunks`);
      }
    } catch (err) {
      logError('RAG retrieval failed', err);
    }
  }

  // ── Inject attachment context ──
  if (attachments.length > 0) {
    const attachmentBlock = buildAttachmentContext(attachments);
    if (attachmentBlock) {
      workspaceContext = `${workspaceContext}\n\n${attachmentBlock}`;
      logInfo(`Injected ${attachments.length} attachment(s) into context`);
    }
  }

  const state = createAgentState(goal, cfg.maxIterations);

  // ── Decide: full-app vs simple question vs coding task vs complex enterprise task ──

  // Path D: Full App Creation ("Create a clone of Spotify", "Build me a SaaS dashboard")
  if (isAppCreationRequest(goal)) {
    logInfo('Routing to Path D: Full App Creation Pipeline');
    onEvent?.({ type: 'status', content: '🏗️ Full app creation detected — launching 8-phase pipeline…' });
    return runAppCreationPath(goal, signal, onEvent);
  }

  if (isSimpleQuestion(goal)) {
    return runGeneralAssistant(goal, workspaceContext, tools, toolContext, priorMessages, signal, onEvent);
  }

  // ── Check if this is a complex task that benefits from sub-agent decomposition ──
  const complexity = assessComplexity(goal);
  logInfo(`Task complexity: ${complexity}/100`);

  if (complexity >= 50 && cfg.enableSubAgents) {
    onEvent?.({ type: 'status', content: `🧠 Complex task detected (score: ${complexity}/100) — spawning sub-agents…` });
    return runSubAgentPath(goal, workspaceRoot, signal, onEvent);
  }

  // ═══════════════════════════════════════════════════
  //  FULL MULTI-AGENT PIPELINE
  // ═══════════════════════════════════════════════════

  try {
    // ── Phase 1: Planning ──
    onEvent?.({ type: 'status', content: '📋 Planning…' });
    const planResult = await runPlanner(goal, workspaceContext, tools, toolContext, signal, onEvent);

    if (signal?.aborted) { return aborted(); }

    // ── Phase 2: Coding ──
    onEvent?.({ type: 'status', content: '💻 Implementing…' });
    // Refresh context after planner may have read files
    const freshContext = await gatherWorkspaceContext(workspaceRoot);
    const coderResult = await runCoder(
      goal,
      planResult.plan,
      freshContext,
      tools,
      toolContext,
      planResult.messages,
      signal,
      onEvent,
    );

    if (signal?.aborted) { return aborted(); }

    // ── Phase 3: Review ──
    onEvent?.({ type: 'status', content: '🔍 Reviewing…' });
    const latestContext = await gatherWorkspaceContext(workspaceRoot);
    const reviewResult = await runReviewer(
      goal,
      coderResult.response,
      latestContext,
      tools,
      toolContext,
      signal,
      onEvent,
    );

    // ── Phase 4: Fix issues if review failed ──
    if (!reviewResult.review.approved && reviewResult.review.issues.length > 0) {
      onEvent?.({ type: 'status', content: '🔧 Fixing review issues…' });
      const fixContext = await gatherWorkspaceContext(workspaceRoot);
      const issuesText = reviewResult.review.issues
        .map(i => `- [${i.severity}] ${i.file}: ${i.description}`)
        .join('\n');

      await runCoder(
        `Fix the following issues found during code review:\n\n${issuesText}\n\nOriginal goal: ${goal}`,
        '', // no plan needed for fixes
        fixContext,
        tools,
        toolContext,
        [],
        signal,
        onEvent,
      );
    }

    // ── Summarize ──
    const summary = reviewResult.review.approved
      ? `✅ Changes implemented and reviewed successfully.\n\n${reviewResult.review.summary}`
      : `⚠️ Changes implemented. Review found issues that were addressed.\n\n${reviewResult.review.summary}`;

    onEvent?.({ type: 'done', content: summary });
    return { success: true, response: summary, editsApplied: [] };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('Supervisor error', err);
    onEvent?.({ type: 'error', content: `Error: ${msg}` });
    return { success: false, response: msg, editsApplied: [] };
  }
}

/* ──────────── Path C: Dynamic Sub-Agent Pipeline ──────────── */

async function runSubAgentPath(
  goal: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
): Promise<SupervisorResult> {
  try {
    const result = await runSubAgentPipeline({
      goal,
      workspaceRoot,
      signal,
      onEvent,
    });

    return {
      success: result.success,
      response: result.summary,
      editsApplied: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('Sub-agent pipeline error', err);
    onEvent?.({ type: 'error', content: `Sub-agent pipeline error: ${msg}` });
    return { success: false, response: msg, editsApplied: [] };
  }
}

/* ──────────── Path D: Full App Creation Pipeline ──────────── */

async function runAppCreationPath(
  goal: string,
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
): Promise<SupervisorResult> {
  try {
    const result = await runAppCreationPipeline({
      goal,
      signal,
      onEvent,
    });

    return {
      success: result.success,
      response: result.summary,
      editsApplied: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('App creation pipeline error', err);
    onEvent?.({ type: 'error', content: `App creation pipeline error: ${msg}` });
    return { success: false, response: msg, editsApplied: [] };
  }
}

/* ──────────── Path A: General Assistant (single-agent) ──────────── */

const GENERAL_INSTRUCTIONS = `You are NexoAgent, an expert AI coding assistant integrated into VS Code.
You help users with any coding task: writing code, explaining concepts, debugging,
refactoring, answering questions, and more.

## Guidelines
- Be concise and direct
- Write production-quality code
- If you need to modify files in the workspace, use the available tools
- Always read files before modifying them
- Explain your changes briefly
- If the user asks a question (not a coding task), answer directly without using tools unless needed`;

async function runGeneralAssistant(
  goal: string,
  workspaceContext: string,
  tools: ToolDefinition[],
  toolContext: ToolContext,
  priorMessages: ChatMessage[],
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
): Promise<SupervisorResult> {
  const cfg = getConfig();

  // ── Quality Pipeline path: for code-generation prompts ──
  if (cfg.styleEnforcement && isCodeGenerationRequest(goal)) {
    logInfo('Using quality pipeline for code-generation request');
    onEvent?.({ type: 'status', content: '🎨 Quality pipeline active…' });

    try {
      const pipelineResult = await runQualityPipeline({
        prompt: goal,
        contextMessages: priorMessages,
        signal,
        onEvent,
      });

      if (pipelineResult.finalText) {
        const scoreTag = `\n\n---\n*Style score: ${pipelineResult.finalScore}/100${pipelineResult.wasRewritten ? ' (rewritten)' : ''} · ${pipelineResult.candidateCount} candidates · ${pipelineResult.durationMs}ms*`;
        const response = pipelineResult.finalText + scoreTag;
        onEvent?.({ type: 'text', content: response });
        onEvent?.({ type: 'done', content: response });
        return { success: true, response, editsApplied: [] };
      }
    } catch (err) {
      logError('Quality pipeline failed, falling back to standard generation', err);
      onEvent?.({ type: 'status', content: '⚠️ Quality pipeline failed, using standard mode…' });
    }
  }

  // ── Standard single-agent path ──
  const systemPrompt = buildSystemPrompt('NexoAgent', GENERAL_INSTRUCTIONS, tools, workspaceContext);
  const fewShot = buildStyleFewShotMessages();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...fewShot.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })),
    ...priorMessages,
    { role: 'user', content: goal },
  ];

  try {
    const result = await runAgentLoop({
      messages,
      tools,
      toolContext,
      maxIterations: 30,
      signal,
      onEvent,
    });

    return { success: true, response: result.response, editsApplied: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('General assistant error', err);
    onEvent?.({ type: 'error', content: msg });
    return { success: false, response: msg, editsApplied: [] };
  }
}

/* ──────────── Helpers ──────────── */

function isSimpleQuestion(goal: string): boolean {
  const lower = goal.toLowerCase().trim();

  // Short messages that look like questions
  if (lower.length < 30 && (lower.startsWith('what') || lower.startsWith('how') ||
    lower.startsWith('why') || lower.startsWith('explain') || lower.startsWith('can you'))) {
    return true;
  }

  // Explicit coding keywords → not simple
  const codingKeywords = [
    'create', 'build', 'implement', 'add', 'fix', 'refactor', 'write',
    'update', 'modify', 'change', 'delete', 'remove', 'install',
    'migrate', 'convert', 'set up', 'setup', 'generate', 'scaffold',
  ];
  for (const kw of codingKeywords) {
    if (lower.includes(kw)) { return false; }
  }

  // Default to full pipeline for anything substantial
  return lower.length < 80;
}

/**
 * Heuristic: does the goal look like a code-generation request
 * (as opposed to a tool-using workspace editing task)?
 * The quality pipeline is best for "write me a function…" style requests.
 */
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

  // Must NOT involve workspace tools (file editing, debugging, etc.)
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

function aborted(): SupervisorResult {
  return { success: false, response: 'Operation cancelled.', editsApplied: [] };
}
