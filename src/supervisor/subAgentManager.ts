import {
  TaskGraph, SubTask, SubAgentResult, SubAgentPipelineResult,
  StreamEvent, SubAgentDomain,
} from '../types';
import { decomposeTask } from './decomposer';
import { executeTaskGraph } from './executor';
import { getConfig } from '../config';
import { logInfo, logError, logWarn } from '../logger';
import { gatherWorkspaceContext } from '../context/workspace';

/* ────────────────────────────────────────────────────────
   Sub-Agent Manager — High-level orchestration facade

   Coordinates the full lifecycle of dynamic sub-agent
   execution for complex enterprise tasks:

   1. Analyses the goal and decides whether sub-agents are needed
   2. Decomposes the task into a dependency graph
   3. Executes the graph via the parallel executor
   4. Tracks progress, token budgets, and execution limits
   5. Produces an aggregated enterprise-grade summary

   This is the single entry-point the supervisor calls when
   it detects a complex task that benefits from decomposition.
   ──────────────────────────────────────────────────────── */

export interface SubAgentManagerOptions {
  /** The user's goal / prompt. */
  goal: string;
  /** Workspace root path. */
  workspaceRoot: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Streaming events callback. */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Execute a complex goal using the dynamic sub-agent pipeline.
 */
export async function runSubAgentPipeline(opts: SubAgentManagerOptions): Promise<SubAgentPipelineResult> {
  const { goal, workspaceRoot, signal, onEvent } = opts;
  const cfg = getConfig();

  onEvent?.({ type: 'status', content: '🧠 Analysing task complexity…' });
  logInfo('Sub-agent pipeline starting', goal);

  // ── 1. Gather workspace context ──
  const workspaceContext = await gatherWorkspaceContext(workspaceRoot);

  // ── 2. Decompose into task graph ──
  const taskGraph = await decomposeTask({
    goal,
    workspaceContext,
    signal,
    onEvent,
  });

  if (signal?.aborted) {
    return makeCancelledResult(taskGraph);
  }

  // ── 3. Log the execution plan ──
  logInfo(`Task graph: ${taskGraph.tasks.length} tasks, complexity=${taskGraph.totalComplexity}`);
  onEvent?.({
    type: 'text',
    content: formatTaskGraphPreview(taskGraph),
  });

  // ── 4. Validate token budget ──
  const estimatedBudget = taskGraph.totalComplexity * 4096;
  logInfo(`Estimated token budget: ${estimatedBudget}`);

  // ── 5. Execute the graph ──
  const result = await executeTaskGraph({
    taskGraph,
    workspaceRoot,
    signal,
    onEvent,
    maxParallel: cfg.maxSubAgents ?? 4,
    agentTimeout: cfg.subAgentTimeout ?? 120_000,
  });

  // ── 6. Post-execution summary ──
  onEvent?.({ type: 'text', content: result.summary });
  onEvent?.({
    type: 'done',
    content: `Sub-agent pipeline ${result.success ? 'completed' : 'finished with failures'}: ${result.agentsSpawned} agents, ${result.totalDurationMs}ms`,
  });

  return result;
}

/**
 * Complexity heuristic — determines whether a goal needs sub-agent decomposition.
 *
 * Returns a score 0-100. Scores ≥ 50 suggest dynamic sub-agent pipeline.
 */
export function assessComplexity(goal: string): number {
  const lower = goal.toLowerCase();
  let score = 0;

  // ── Length-based (longer prompts = likely more complex) ──
  if (goal.length > 500) { score += 20; }
  else if (goal.length > 200) { score += 10; }

  // ── Multi-file indicators ──
  const multiFilePatterns = [
    /multiple\s+files/i, /across\s+(?:the\s+)?(?:project|codebase|repo)/i,
    /full[- ]stack/i, /end[- ]to[- ]end/i, /entire\s+(?:system|application|project)/i,
    /\band\b.*\band\b.*\band\b/i, // "X and Y and Z" — multi-part
  ];
  for (const p of multiFilePatterns) {
    if (p.test(lower)) { score += 15; break; }
  }

  // ── Domain-crossing indicators (need multiple agent types) ──
  const domainKeywords: Record<string, string[]> = {
    security: ['security', 'vulnerability', 'audit', 'owasp', 'authentication', 'authorization', 'xss', 'injection'],
    testing: ['test', 'coverage', 'unit test', 'integration test', 'e2e', 'spec'],
    documentation: ['document', 'jsdoc', 'readme', 'api doc', 'changelog'],
    performance: ['performance', 'optimize', 'benchmark', 'profil', 'cache', 'latency'],
    migration: ['migrate', 'upgrade', 'deprecat', 'convert', 'port to'],
    database: ['database', 'schema', 'migration', 'query', 'orm', 'sql', 'nosql'],
    devops: ['ci/cd', 'docker', 'pipeline', 'deploy', 'kubernetes', 'terraform', 'github action'],
    'api-design': ['api', 'endpoint', 'rest', 'graphql', 'grpc', 'openapi', 'swagger'],
  };

  let domainsMatched = 0;
  for (const [, keywords] of Object.entries(domainKeywords)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) { domainsMatched++; break; }
    }
  }

  if (domainsMatched >= 3) { score += 30; }
  else if (domainsMatched >= 2) { score += 20; }
  else if (domainsMatched >= 1) { score += 10; }

  // ── Explicit complexity markers ──
  const complexityMarkers = [
    'production', 'enterprise', 'scalable', 'microservice',
    'architecture', 'refactor the entire', 'rewrite',
    'comprehensive', 'complete', 'full implementation',
    'from scratch', 'ground up',
  ];
  for (const marker of complexityMarkers) {
    if (lower.includes(marker)) { score += 10; break; }
  }

  // ── Enumerated list detection (numbered steps) ──
  const numberedSteps = lower.match(/\d+\.\s/g);
  if (numberedSteps && numberedSteps.length >= 3) { score += 15; }

  // ── File references ──
  const fileRefs = goal.match(/\b\w+\.\w{1,5}\b/g); // file.ext patterns
  if (fileRefs && fileRefs.length >= 4) { score += 10; }

  return Math.min(100, score);
}

/* ───────────────── Formatting ───────────────── */

function formatTaskGraphPreview(graph: TaskGraph): string {
  const lines: string[] = [
    `## 🧩 Task Decomposition`,
    ``,
    `**Goal**: ${graph.goal}`,
    `**Sub-tasks**: ${graph.tasks.length} | **Estimated complexity**: ${graph.totalComplexity}/60`,
    ``,
  ];

  // Group by dependency tier
  const tierMap = new Map<number, SubTask[]>();
  const taskDepth = new Map<string, number>();

  // BFS to assign tiers
  const queue: string[] = [];
  for (const task of graph.tasks) {
    if (task.dependencies.length === 0) {
      taskDepth.set(task.id, 0);
      queue.push(task.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const depth = taskDepth.get(id) ?? 0;
    for (const next of graph.edges[id] ?? []) {
      const existing = taskDepth.get(next) ?? -1;
      if (depth + 1 > existing) {
        taskDepth.set(next, depth + 1);
        queue.push(next);
      }
    }
  }

  for (const task of graph.tasks) {
    const tier = taskDepth.get(task.id) ?? 0;
    if (!tierMap.has(tier)) { tierMap.set(tier, []); }
    tierMap.get(tier)!.push(task);
  }

  for (const [tier, tasks] of [...tierMap.entries()].sort((a, b) => a[0] - b[0])) {
    const parallel = tasks.length > 1 ? ' *(parallel)*' : '';
    lines.push(`**Phase ${tier + 1}**${parallel}:`);
    for (const task of tasks) {
      const deps = task.dependencies.length > 0 ? ` ← depends on: ${task.dependencies.join(', ')}` : '';
      lines.push(`  - 🤖 **${task.title}** [${task.domain}] (complexity: ${task.complexity ?? 3}/5)${deps}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function makeCancelledResult(taskGraph: TaskGraph): SubAgentPipelineResult {
  return {
    success: false,
    summary: 'Pipeline cancelled by user.',
    results: [],
    taskGraph,
    totalDurationMs: 0,
    totalTokensUsed: 0,
    agentsSpawned: 0,
    peakParallelism: 0,
  };
}
