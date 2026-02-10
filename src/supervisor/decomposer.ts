import { SubTask, TaskGraph, SubAgentDomain, ChatMessage, StreamEvent } from '../types';
import { chatCompletion } from '../client/nvidiaClient';
import { getConfig } from '../config';
import { logInfo, logError, logWarn } from '../logger';
import { getRegisteredDomains } from '../agents/registry';

/* ────────────────────────────────────────────────────────
   Task Decomposer — LLM-driven DAG decomposition

   Takes a complex goal + workspace context and produces
   a TaskGraph: a directed acyclic graph of SubTasks
   with dependency edges.

   The LLM is prompted to output structured JSON which is
   then validated and normalised into a TaskGraph.
   ──────────────────────────────────────────────────────── */

const DECOMPOSITION_PROMPT = `You are an expert software architect.  Your job is to decompose a complex coding task into a directed acyclic graph (DAG) of independent sub-tasks that can be executed by specialized AI agents.

## Available Agent Domains
{DOMAINS}

## Rules
1. Each sub-task MUST have a unique id (use short kebab-case: "auth-module", "api-routes", etc.)
2. Specify dependencies as an array of other sub-task ids that MUST complete first
3. Tasks with no dependencies can run in parallel
4. Assign the most appropriate domain to each task
5. Order tasks so implementation comes before testing, and security review comes last
6. Keep tasks focused — one clear responsibility per task
7. Estimate complexity 1-5 (1=trivial, 5=very complex)
8. Maximum 12 sub-tasks for any single goal

## Output Format
Return ONLY valid JSON (no markdown fences, no explanation outside JSON):
{
  "tasks": [
    {
      "id": "task-id",
      "title": "Short task title",
      "description": "Detailed description of what the agent should do",
      "domain": "coder",
      "dependencies": [],
      "relevantFiles": ["src/file.ts"],
      "complexity": 3,
      "priority": 80
    }
  ]
}`;

export interface DecompositionOptions {
  /** The high-level goal to decompose. */
  goal: string;
  /** Current workspace context string. */
  workspaceContext: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Progress events. */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Decompose a complex goal into a TaskGraph using LLM reasoning.
 */
export async function decomposeTask(opts: DecompositionOptions): Promise<TaskGraph> {
  const { goal, workspaceContext, signal, onEvent } = opts;
  const cfg = getConfig();

  onEvent?.({ type: 'status', content: '🧩 Decomposing task into sub-tasks…' });
  logInfo('Task decomposition starting', goal);

  const domains = getRegisteredDomains();
  const domainList = domains.map(d => `- **${d}**: specialized agent for ${domainDescription(d)}`).join('\n');

  const systemPrompt = DECOMPOSITION_PROMPT.replace('{DOMAINS}', domainList);
  const userPrompt = `## Goal\n${goal}\n\n## Workspace Context\n${workspaceContext.slice(0, 6000)}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let rawJson: string;
  try {
    rawJson = await chatCompletion({
      messages,
      temperature: 0.2,       // low temp for structured output
      maxTokens: 4096,
      signal,
    });
  } catch (err) {
    logError('Task decomposition LLM call failed', err);
    // Fallback: create a simple linear plan
    return createFallbackGraph(goal);
  }

  // Parse and validate
  try {
    const graph = parseDecompositionResponse(rawJson, goal);
    logInfo(`Decomposed into ${graph.tasks.length} sub-tasks (complexity: ${graph.totalComplexity})`);
    onEvent?.({ type: 'status', content: `🧩 Decomposed into ${graph.tasks.length} sub-tasks` });
    return graph;
  } catch (err) {
    logWarn('Failed to parse decomposition, using fallback', err);
    return createFallbackGraph(goal);
  }
}

/**
 * Parse the LLM JSON response into a validated TaskGraph.
 */
export function parseDecompositionResponse(raw: string, goal: string): TaskGraph {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const parsed = JSON.parse(cleaned);

  if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('Decomposition response has no tasks array');
  }

  // Validate and normalise each task
  const taskIds = new Set<string>();
  const tasks: SubTask[] = [];

  for (const raw of parsed.tasks) {
    if (!raw.id || !raw.title || !raw.description || !raw.domain) {
      logWarn('Skipping malformed sub-task', raw);
      continue;
    }

    // Validate domain
    const domain = validateDomain(raw.domain);

    const task: SubTask = {
      id: String(raw.id),
      title: String(raw.title),
      description: String(raw.description),
      domain,
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
      status: 'pending',
      relevantFiles: Array.isArray(raw.relevantFiles) ? raw.relevantFiles.map(String) : undefined,
      priority: typeof raw.priority === 'number' ? raw.priority : 50,
      complexity: typeof raw.complexity === 'number' ? Math.min(5, Math.max(1, raw.complexity)) : 3,
    };

    taskIds.add(task.id);
    tasks.push(task);
  }

  // Validate dependencies reference existing tasks
  for (const task of tasks) {
    task.dependencies = task.dependencies.filter(dep => {
      if (!taskIds.has(dep)) {
        logWarn(`Sub-task "${task.id}" references unknown dependency "${dep}", removing`);
        return false;
      }
      return true;
    });
  }

  // Detect cycles
  if (hasCycle(tasks)) {
    logWarn('Cycle detected in task graph, removing back-edges');
    removeCycles(tasks);
  }

  // Build adjacency list
  const edges: Record<string, string[]> = {};
  for (const task of tasks) {
    edges[task.id] = [];
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!edges[dep]) { edges[dep] = []; }
      edges[dep].push(task.id);
    }
  }

  const totalComplexity = tasks.reduce((sum, t) => sum + (t.complexity ?? 3), 0);

  return {
    goal,
    tasks,
    edges,
    createdAt: Date.now(),
    totalComplexity,
  };
}

/* ───────────────── Cycle detection & removal ───────────────── */

export function hasCycle(tasks: SubTask[]): boolean {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  function dfs(id: string): boolean {
    visited.add(id);
    recStack.add(id);

    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependencies) {
        if (!visited.has(dep)) {
          if (dfs(dep)) { return true; }
        } else if (recStack.has(dep)) {
          return true;
        }
      }
    }

    recStack.delete(id);
    return false;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) { return true; }
    }
  }
  return false;
}

function removeCycles(tasks: SubTask[]): void {
  // Simple strategy: remove back-edges by topological ordering attempt
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjList.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      const arr = adjList.get(dep);
      if (arr) { arr.push(task.id); }
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm — anything not processable has a cycle
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) { queue.push(id); }
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const curr = queue.shift()!;
    processed.add(curr);
    for (const next of adjList.get(curr) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) { queue.push(next); }
    }
  }

  // Remove dependencies on tasks that were part of a cycle
  for (const task of tasks) {
    if (!processed.has(task.id)) {
      task.dependencies = [];
    }
  }
}

/* ───────────────── Fallback: simple 3-phase graph ───────────────── */

function createFallbackGraph(goal: string): TaskGraph {
  const tasks: SubTask[] = [
    {
      id: 'plan',
      title: 'Plan implementation',
      description: `Analyze the workspace and create a plan for: ${goal}`,
      domain: 'planner',
      dependencies: [],
      status: 'pending',
      complexity: 2,
      priority: 100,
    },
    {
      id: 'implement',
      title: 'Implement changes',
      description: `Implement the code changes for: ${goal}`,
      domain: 'coder',
      dependencies: ['plan'],
      status: 'pending',
      complexity: 4,
      priority: 90,
    },
    {
      id: 'review',
      title: 'Review changes',
      description: `Review the implemented code changes for: ${goal}`,
      domain: 'reviewer',
      dependencies: ['implement'],
      status: 'pending',
      complexity: 2,
      priority: 80,
    },
  ];

  return {
    goal,
    tasks,
    edges: {
      plan: ['implement'],
      implement: ['review'],
      review: [],
    },
    createdAt: Date.now(),
    totalComplexity: 8,
  };
}

/* ───────────────── Helpers ───────────────── */

const VALID_DOMAINS: Set<SubAgentDomain> = new Set([
  'planner', 'coder', 'reviewer', 'security', 'testing',
  'documentation', 'performance', 'api-design', 'migration',
  'database', 'devops', 'architect', 'frontend', 'backend', 'custom',
]);

function validateDomain(d: string): SubAgentDomain {
  if (VALID_DOMAINS.has(d as SubAgentDomain)) {
    return d as SubAgentDomain;
  }
  logWarn(`Unknown domain "${d}", falling back to "coder"`);
  return 'coder';
}

function domainDescription(domain: SubAgentDomain): string {
  const descriptions: Record<SubAgentDomain, string> = {
    planner: 'analysing codebases and creating implementation plans',
    coder: 'implementing code changes and writing production code',
    reviewer: 'reviewing code quality, correctness, and best practices',
    security: 'auditing code for security vulnerabilities and OWASP issues',
    testing: 'generating comprehensive test suites and test coverage',
    documentation: 'writing technical documentation, JSDoc, and READMEs',
    performance: 'analysing and optimising code performance',
    'api-design': 'designing clean, RESTful, type-safe API interfaces',
    migration: 'handling framework/library upgrades and code migrations',
    database: 'database schema design, query optimisation, and ORM patterns',
    devops: 'CI/CD pipelines, Docker, infrastructure-as-code',
    architect: 'creating architecture blueprints, PRDs, tech stack decisions, API contracts, and project structure',
    frontend: 'building beautiful, responsive UIs with React/Next.js, Tailwind CSS, component libraries, and polished design systems',
    backend: 'implementing server-side logic, REST/GraphQL APIs, authentication, database integration, and production middleware',
    custom: 'general-purpose custom tasks',
  };
  return descriptions[domain] ?? 'general-purpose tasks';
}
