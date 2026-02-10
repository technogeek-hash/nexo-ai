import {
  SubTask, TaskGraph, SubAgentResult, SubAgentPipelineResult,
  SubAgentSpec, StreamEvent, ToolDefinition, ToolContext,
} from '../types';
import { getAgentByDomain, getAgentById } from '../agents/registry';
import { runAgentLoop, buildSystemPrompt } from '../agents/base';
import { gatherWorkspaceContext } from '../context/workspace';
import { getConfig } from '../config';
import { logInfo, logError, logWarn, getOutputChannel } from '../logger';
import { buildToolRegistry } from '../tools';

/* ────────────────────────────────────────────────────────
   Parallel Executor — Topological Execution Engine

   Given a TaskGraph (DAG of SubTasks), this module:
   1. Topologically sorts the graph
   2. Groups tasks by dependency tier (0 = no deps, 1 = depends on tier 0, …)
   3. Executes each tier in parallel (Promise.allSettled)
   4. Passes results from completed tasks as context to dependants
   5. Isolates failures — one failed sub-agent doesn't crash others
   6. Aggregates all results into a SubAgentPipelineResult
   ──────────────────────────────────────────────────────── */

export interface ExecutorOptions {
  /** The task graph to execute. */
  taskGraph: TaskGraph;
  /** Workspace root path. */
  workspaceRoot: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Streaming events callback. */
  onEvent?: (event: StreamEvent) => void;
  /** Maximum number of sub-agents to run in parallel. */
  maxParallel?: number;
  /** Per-agent timeout in milliseconds. */
  agentTimeout?: number;
}

/**
 * Execute a TaskGraph by spawning sub-agents in dependency order.
 * Independent tasks within the same tier run in parallel.
 */
export async function executeTaskGraph(opts: ExecutorOptions): Promise<SubAgentPipelineResult> {
  const {
    taskGraph,
    workspaceRoot,
    signal,
    onEvent,
    maxParallel = 4,
    agentTimeout = 120_000,
  } = opts;

  const startTime = Date.now();
  const results: SubAgentResult[] = [];
  let peakParallelism = 0;
  let totalTokens = 0;
  let agentsSpawned = 0;

  // ── Build execution tiers ──
  const tiers = topologicalTiers(taskGraph);
  logInfo(`Execution plan: ${tiers.length} tiers, ${taskGraph.tasks.length} total tasks`);

  // Store results by task ID for downstream context injection
  const resultMap = new Map<string, SubAgentResult>();

  for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
    if (signal?.aborted) { break; }

    const tier = tiers[tierIdx];
    const tierLabel = `Tier ${tierIdx + 1}/${tiers.length}`;
    onEvent?.({ type: 'status', content: `⚡ ${tierLabel}: running ${tier.length} sub-agent(s) in parallel…` });
    logInfo(`${tierLabel}: ${tier.map(t => t.id).join(', ')}`);

    peakParallelism = Math.max(peakParallelism, tier.length);

    // Chunk tier into batches of maxParallel
    const batches = chunkArray(tier, maxParallel);

    for (const batch of batches) {
      if (signal?.aborted) { break; }

      // Gather context from completed dependencies
      const batchPromises = batch.map(async (task): Promise<SubAgentResult> => {
        if (signal?.aborted) {
          return makeSkippedResult(task, 'Cancelled by user');
        }

        // Check if all dependencies succeeded
        const depsFailed = task.dependencies.some(depId => {
          const depResult = resultMap.get(depId);
          return depResult && !depResult.success;
        });

        if (depsFailed) {
          const msg = `Skipped: dependency failed`;
          logWarn(`Sub-task "${task.id}" skipped — dependency failure`);
          onEvent?.({ type: 'status', content: `⏭️ ${task.title} — skipped (dependency failed)` });
          task.status = 'skipped';
          return makeSkippedResult(task, msg);
        }

        // Spawn the sub-agent
        agentsSpawned++;
        task.status = 'running';
        onEvent?.({ type: 'status', content: `🤖 Spawning: ${task.title} [${task.domain}]` });

        try {
          const result = await runSubAgent(task, resultMap, workspaceRoot, signal, onEvent, agentTimeout);
          task.status = result.success ? 'completed' : 'failed';
          return result;
        } catch (err) {
          task.status = 'failed';
          const msg = err instanceof Error ? err.message : String(err);
          logError(`Sub-agent "${task.id}" crashed`, err);
          return makeFailedResult(task, msg, 0);
        }
      });

      // Execute batch in parallel with error isolation
      const settled = await Promise.allSettled(batchPromises);

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const task = batch[i];

        let result: SubAgentResult;
        if (outcome.status === 'fulfilled') {
          result = outcome.value;
        } else {
          result = makeFailedResult(task, outcome.reason?.message ?? 'Unknown error', 0);
          task.status = 'failed';
        }

        results.push(result);
        resultMap.set(task.id, result);
        totalTokens += result.tokensUsed;

        const icon = result.success ? '✅' : '❌';
        onEvent?.({
          type: 'status',
          content: `${icon} ${task.title} — ${result.success ? 'done' : 'failed'} (${result.durationMs}ms, ${result.iterations} steps)`,
        });
      }
    }
  }

  // ── Build aggregate result ──
  const allSucceeded = results.every(r => r.success || resultMap.get(r.taskId)?.domain === 'security');
  const criticalFailures = results.filter(r => !r.success && r.domain !== 'documentation');

  const summary = buildPipelineSummary(results, taskGraph, peakParallelism);

  const pipelineResult: SubAgentPipelineResult = {
    success: criticalFailures.length === 0,
    summary,
    results,
    taskGraph,
    totalDurationMs: Date.now() - startTime,
    totalTokensUsed: totalTokens,
    agentsSpawned,
    peakParallelism,
  };

  logInfo(`Pipeline complete: ${agentsSpawned} agents, ${pipelineResult.totalDurationMs}ms, success=${pipelineResult.success}`);
  return pipelineResult;
}

/* ───────────────── Sub-agent spawning ───────────────── */

async function runSubAgent(
  task: SubTask,
  priorResults: Map<string, SubAgentResult>,
  workspaceRoot: string,
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
  timeout?: number,
): Promise<SubAgentResult> {
  const startTime = Date.now();

  // Resolve agent spec
  const spec = getAgentByDomain(task.domain);
  if (!spec) {
    return makeFailedResult(task, `No agent registered for domain: ${task.domain}`, 0);
  }

  // Build tools (optionally filtered)
  let tools = buildToolRegistry();
  if (spec.allowedTools && spec.allowedTools.length > 0) {
    const allowed = new Set(spec.allowedTools);
    tools = tools.filter(t => allowed.has(t.name));
  }

  const toolContext: ToolContext = {
    workspaceRoot,
    outputChannel: getOutputChannel(),
    token: undefined,
    onProgress: (msg) => onEvent?.({ type: 'status', content: `  [${task.id}] ${msg}` }),
  };

  // Build context from prior dependency results
  const depContext = task.dependencies
    .map(depId => {
      const r = priorResults.get(depId);
      if (!r) { return ''; }
      return `## Result from "${depId}" (${r.domain})\n${r.response.slice(0, 3000)}`;
    })
    .filter(Boolean)
    .join('\n\n');

  // Gather current workspace state
  const wsContext = await gatherWorkspaceContext(workspaceRoot);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(
    spec.name,
    spec.instructions,
    tools,
    wsContext,
  );

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...(depContext ? [{ role: 'user' as const, content: `## Context from prior tasks\n\n${depContext}` }] : []),
    { role: 'user' as const, content: `## Your Task\n\n**${task.title}**\n\n${task.description}${task.relevantFiles ? `\n\nRelevant files: ${task.relevantFiles.join(', ')}` : ''}` },
  ];

  // Run with timeout
  const controller = new AbortController();
  const combinedSignal = signal
    ? combineAbortSignals(signal, controller.signal)
    : controller.signal;

  const timeoutHandle = timeout
    ? setTimeout(() => controller.abort(), timeout)
    : undefined;

  try {
    const result = await runAgentLoop({
      messages,
      tools: spec.requiresWorkspaceAccess ? tools : [],
      toolContext: spec.requiresWorkspaceAccess ? toolContext : undefined,
      maxIterations: spec.maxIterations,
      signal: combinedSignal,
      onEvent: (event) => {
        // Prefix events from sub-agents with task ID
        if (event.type === 'text' || event.type === 'tool_call') {
          onEvent?.({ ...event, content: `[${task.id}] ${event.content}` });
        }
      },
    });

    const durationMs = Date.now() - startTime;
    const filesModified = result.toolCalls
      .filter(tc => ['write_file', 'edit_file', 'delete_file'].includes(tc.tool) && tc.success)
      .map(tc => String(tc.args.path ?? tc.args.file_path ?? ''))
      .filter(Boolean);

    return {
      taskId: task.id,
      domain: task.domain,
      success: true,
      response: result.response,
      filesModified,
      toolCallCount: result.toolCalls.length,
      iterations: result.iterations,
      durationMs,
      tokensUsed: estimateTokens(result.response),
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    return makeFailedResult(task, msg, durationMs);
  } finally {
    if (timeoutHandle) { clearTimeout(timeoutHandle); }
  }
}

/* ───────────────── Topological tier sorting ───────────────── */

/**
 * Group tasks into execution tiers.
 * Tier 0 = tasks with no dependencies.
 * Tier N = tasks whose dependencies are all in tiers < N.
 * Tasks within the same tier can execute in parallel.
 */
export function topologicalTiers(graph: TaskGraph): SubTask[][] {
  const taskMap = new Map(graph.tasks.map(t => [t.id, t]));
  const inDegree = new Map<string, number>();
  const dependants = new Map<string, string[]>();

  for (const task of graph.tasks) {
    inDegree.set(task.id, task.dependencies.length);
    dependants.set(task.id, []);
  }

  for (const task of graph.tasks) {
    for (const dep of task.dependencies) {
      const arr = dependants.get(dep);
      if (arr) { arr.push(task.id); }
    }
  }

  const tiers: SubTask[][] = [];
  const remaining = new Set(graph.tasks.map(t => t.id));

  while (remaining.size > 0) {
    // Find all tasks with in-degree 0 among remaining
    const tier: SubTask[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) <= 0) {
        const task = taskMap.get(id);
        if (task) { tier.push(task); }
      }
    }

    if (tier.length === 0) {
      // Cycle or orphan — force remaining into one tier
      logWarn('Topological sort stuck, forcing remaining tasks');
      const forced: SubTask[] = [];
      for (const id of remaining) {
        const task = taskMap.get(id);
        if (task) { forced.push(task); }
      }
      tiers.push(forced);
      break;
    }

    // Sort tier by priority (descending)
    tier.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
    tiers.push(tier);

    // Remove tier from graph
    for (const task of tier) {
      remaining.delete(task.id);
      for (const next of dependants.get(task.id) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      }
    }
  }

  return tiers;
}

/* ───────────────── Helpers ───────────────── */

function makeSkippedResult(task: SubTask, reason: string): SubAgentResult {
  return {
    taskId: task.id,
    domain: task.domain,
    success: false,
    response: reason,
    filesModified: [],
    toolCallCount: 0,
    iterations: 0,
    durationMs: 0,
    tokensUsed: 0,
    error: reason,
  };
}

function makeFailedResult(task: SubTask, error: string, durationMs: number): SubAgentResult {
  return {
    taskId: task.id,
    domain: task.domain,
    success: false,
    response: `Sub-agent failed: ${error}`,
    filesModified: [],
    toolCallCount: 0,
    iterations: 0,
    durationMs,
    tokensUsed: 0,
    error,
  };
}

function buildPipelineSummary(
  results: SubAgentResult[],
  graph: TaskGraph,
  peakParallelism: number,
): string {
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success && r.error !== 'Skipped: dependency failed').length;
  const skipped = results.filter(r => r.error?.startsWith('Skipped')).length;
  const totalFiles = new Set(results.flatMap(r => r.filesModified)).size;
  const totalTools = results.reduce((sum, r) => sum + r.toolCallCount, 0);

  const lines: string[] = [
    `## Sub-Agent Pipeline Summary`,
    ``,
    `**Goal**: ${graph.goal}`,
    `**Sub-tasks**: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (${results.length} total)`,
    `**Peak parallelism**: ${peakParallelism} concurrent agents`,
    `**Files modified**: ${totalFiles}`,
    `**Total tool calls**: ${totalTools}`,
    ``,
    `### Results by Task`,
  ];

  for (const r of results) {
    const icon = r.success ? '✅' : (r.error?.startsWith('Skipped') ? '⏭️' : '❌');
    lines.push(`- ${icon} **${r.taskId}** [${r.domain}] — ${r.durationMs}ms, ${r.iterations} steps`);
    if (r.filesModified.length > 0) {
      lines.push(`  Files: ${r.filesModified.join(', ')}`);
    }
    if (r.error && !r.success) {
      lines.push(`  Error: ${r.error}`);
    }
  }

  return lines.join('\n');
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) { controller.abort(sig.reason); return controller.signal; }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
