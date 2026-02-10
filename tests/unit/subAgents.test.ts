import * as assert from 'assert';

/* ────────────────────────────────────────────────────────
   Unit Tests — Sub-Agent System
   Tests the agent registry, task decomposer parsing,
   topological tier sorting, and complexity assessment.

   Registry imports are safe (no vscode dependency).
   Decomposer/executor/manager pure logic is replicated here
   to avoid pulling in transitive vscode deps at test time.
   ──────────────────────────────────────────────────────── */

// ═══════════════════════════════════════
//  1. Agent Registry — direct import (no vscode dependency)
// ═══════════════════════════════════════

import {
  registerAgent,
  unregisterAgent,
  getAgentById,
  getAgentByDomain,
  getAllAgents,
  getRegisteredDomains,
  resetRegistry,
  registrySize,
} from '../../src/agents/registry';

import type { SubAgentSpec, SubTask, TaskGraph, SubAgentDomain } from '../../src/types';

suite('Agent Registry', () => {
  setup(() => {
    resetRegistry();
  });

  test('has built-in agents on init', () => {
    assert.ok(registrySize() >= 8, `Expected at least 8 built-in agents, got ${registrySize()}`);
  });

  test('getAgentByDomain returns security agent', () => {
    const agent = getAgentByDomain('security');
    assert.ok(agent, 'Security agent should exist');
    assert.strictEqual(agent!.domain, 'security');
    assert.strictEqual(agent!.id, 'security-auditor');
  });

  test('getAgentByDomain returns testing agent', () => {
    const agent = getAgentByDomain('testing');
    assert.ok(agent, 'Testing agent should exist');
    assert.strictEqual(agent!.domain, 'testing');
  });

  test('getAgentByDomain returns documentation agent', () => {
    const agent = getAgentByDomain('documentation');
    assert.ok(agent, 'Documentation agent should exist');
  });

  test('getAgentByDomain returns performance agent', () => {
    const agent = getAgentByDomain('performance');
    assert.ok(agent, 'Performance agent should exist');
  });

  test('getAgentByDomain returns api-design agent', () => {
    const agent = getAgentByDomain('api-design');
    assert.ok(agent, 'API design agent should exist');
  });

  test('getAgentByDomain returns migration agent', () => {
    const agent = getAgentByDomain('migration');
    assert.ok(agent, 'Migration agent should exist');
  });

  test('getAgentByDomain returns database agent', () => {
    const agent = getAgentByDomain('database');
    assert.ok(agent, 'Database agent should exist');
  });

  test('getAgentByDomain returns devops agent', () => {
    const agent = getAgentByDomain('devops');
    assert.ok(agent, 'DevOps agent should exist');
  });

  test('getAgentById returns correct agent', () => {
    const agent = getAgentById('security-auditor');
    assert.ok(agent);
    assert.strictEqual(agent!.name, 'Security Auditor');
  });

  test('getAgentById returns undefined for unknown id', () => {
    const agent = getAgentById('does-not-exist');
    assert.strictEqual(agent, undefined);
  });

  test('registerAgent adds a custom agent', () => {
    const custom: SubAgentSpec = {
      id: 'custom-lint',
      name: 'Custom Linter',
      domain: 'custom',
      instructions: 'Lint the code',
      maxIterations: 5,
      requiresWorkspaceAccess: true,
      priority: 50,
    };
    const sizeBefore = registrySize();
    registerAgent(custom);
    assert.strictEqual(registrySize(), sizeBefore + 1);
    assert.deepStrictEqual(getAgentById('custom-lint'), custom);
  });

  test('unregisterAgent removes an agent', () => {
    const sizeBefore = registrySize();
    const removed = unregisterAgent('security-auditor');
    assert.strictEqual(removed, true);
    assert.strictEqual(registrySize(), sizeBefore - 1);
    assert.strictEqual(getAgentById('security-auditor'), undefined);
  });

  test('unregisterAgent returns false for unknown id', () => {
    assert.strictEqual(unregisterAgent('nope'), false);
  });

  test('getAllAgents returns all registered agents', () => {
    const agents = getAllAgents();
    assert.ok(agents.length >= 8);
    assert.ok(agents.every(a => a.id && a.name && a.domain));
  });

  test('getRegisteredDomains returns all unique domains', () => {
    const domains = getRegisteredDomains();
    assert.ok(domains.includes('security'));
    assert.ok(domains.includes('testing'));
    assert.ok(domains.includes('documentation'));
    assert.ok(domains.includes('performance'));
    assert.ok(domains.includes('database'));
    assert.ok(domains.includes('devops'));
  });

  test('resetRegistry restores built-ins only', () => {
    const custom: SubAgentSpec = {
      id: 'test-custom',
      name: 'Test Custom',
      domain: 'custom',
      instructions: 'test',
      maxIterations: 5,
      requiresWorkspaceAccess: false,
      priority: 50,
    };
    registerAgent(custom);
    const sizeWithCustom = registrySize();
    resetRegistry();
    assert.ok(registrySize() < sizeWithCustom, 'Reset should remove custom agents');
    assert.strictEqual(getAgentById('test-custom'), undefined);
    assert.ok(getAgentById('security-auditor'), 'Built-in should still exist');
  });

  test('agents have valid configurations', () => {
    for (const agent of getAllAgents()) {
      assert.ok(agent.maxIterations > 0, `${agent.id} should have positive maxIterations`);
      assert.ok(agent.priority >= 0, `${agent.id} should have non-negative priority`);
      assert.ok(agent.instructions.length > 50, `${agent.id} should have substantial instructions`);
    }
  });
});

// ═══════════════════════════════════════
//  2. Task Decomposer — Parsing (replicated logic)
//     Replicated to avoid transitive vscode dependency
// ═══════════════════════════════════════

const VALID_DOMAINS: Set<SubAgentDomain> = new Set([
  'planner', 'coder', 'reviewer', 'security', 'testing',
  'documentation', 'performance', 'api-design', 'migration',
  'database', 'devops', 'custom',
]);

function validateDomain(d: string): SubAgentDomain {
  if (VALID_DOMAINS.has(d as SubAgentDomain)) { return d as SubAgentDomain; }
  return 'coder';
}

function parseDecompositionResponse(raw: string, goal: string): TaskGraph {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const parsed = JSON.parse(cleaned);
  if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('Decomposition response has no tasks array');
  }
  const taskIds = new Set<string>();
  const tasks: SubTask[] = [];
  for (const rawTask of parsed.tasks) {
    if (!rawTask.id || !rawTask.title || !rawTask.description || !rawTask.domain) { continue; }
    const domain = validateDomain(rawTask.domain);
    const task: SubTask = {
      id: String(rawTask.id),
      title: String(rawTask.title),
      description: String(rawTask.description),
      domain,
      dependencies: Array.isArray(rawTask.dependencies) ? rawTask.dependencies.map(String) : [],
      status: 'pending',
      relevantFiles: Array.isArray(rawTask.relevantFiles) ? rawTask.relevantFiles.map(String) : undefined,
      priority: typeof rawTask.priority === 'number' ? rawTask.priority : 50,
      complexity: typeof rawTask.complexity === 'number' ? Math.min(5, Math.max(1, rawTask.complexity)) : 3,
    };
    taskIds.add(task.id);
    tasks.push(task);
  }
  for (const task of tasks) {
    task.dependencies = task.dependencies.filter(dep => taskIds.has(dep));
  }
  const edges: Record<string, string[]> = {};
  for (const task of tasks) { edges[task.id] = []; }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!edges[dep]) { edges[dep] = []; }
      edges[dep].push(task.id);
    }
  }
  const totalComplexity = tasks.reduce((sum, t) => sum + (t.complexity ?? 3), 0);
  return { goal, tasks, edges, createdAt: Date.now(), totalComplexity };
}

function hasCycle(tasks: SubTask[]): boolean {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  function dfs(id: string): boolean {
    visited.add(id);
    recStack.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependencies) {
        if (!visited.has(dep)) { if (dfs(dep)) { return true; } }
        else if (recStack.has(dep)) { return true; }
      }
    }
    recStack.delete(id);
    return false;
  }
  for (const task of tasks) {
    if (!visited.has(task.id)) { if (dfs(task.id)) { return true; } }
  }
  return false;
}

suite('Task Decomposer — parseDecompositionResponse', () => {
  test('parses valid JSON into TaskGraph', () => {
    const json = JSON.stringify({
      tasks: [
        { id: 'plan', title: 'Plan', description: 'Plan the work', domain: 'planner', dependencies: [], complexity: 2 },
        { id: 'code', title: 'Code', description: 'Write code', domain: 'coder', dependencies: ['plan'], complexity: 4 },
        { id: 'test', title: 'Test', description: 'Write tests', domain: 'testing', dependencies: ['code'], complexity: 3 },
      ],
    });
    const graph = parseDecompositionResponse(json, 'Build a feature');
    assert.strictEqual(graph.tasks.length, 3);
    assert.strictEqual(graph.goal, 'Build a feature');
    assert.strictEqual(graph.totalComplexity, 9);
    assert.deepStrictEqual(graph.tasks[0].dependencies, []);
    assert.deepStrictEqual(graph.tasks[1].dependencies, ['plan']);
    assert.deepStrictEqual(graph.tasks[2].dependencies, ['code']);
  });

  test('strips markdown code fences', () => {
    const json = '```json\n' + JSON.stringify({
      tasks: [{ id: 'a', title: 'A', description: 'Task A', domain: 'coder', dependencies: [] }],
    }) + '\n```';
    const graph = parseDecompositionResponse(json, 'test');
    assert.strictEqual(graph.tasks.length, 1);
  });

  test('removes references to non-existent dependencies', () => {
    const json = JSON.stringify({
      tasks: [{ id: 'a', title: 'A', description: 'Task A', domain: 'coder', dependencies: ['ghost'] }],
    });
    const graph = parseDecompositionResponse(json, 'test');
    assert.deepStrictEqual(graph.tasks[0].dependencies, []);
  });

  test('builds adjacency list (edges)', () => {
    const json = JSON.stringify({
      tasks: [
        { id: 'a', title: 'A', description: 'A', domain: 'planner', dependencies: [] },
        { id: 'b', title: 'B', description: 'B', domain: 'coder', dependencies: ['a'] },
        { id: 'c', title: 'C', description: 'C', domain: 'testing', dependencies: ['a'] },
      ],
    });
    const graph = parseDecompositionResponse(json, 'test');
    assert.deepStrictEqual(graph.edges['a']!.sort(), ['b', 'c']);
    assert.deepStrictEqual(graph.edges['b'], []);
    assert.deepStrictEqual(graph.edges['c'], []);
  });

  test('clamps complexity to 1-5 range', () => {
    const json = JSON.stringify({
      tasks: [
        { id: 'a', title: 'A', description: 'A', domain: 'coder', dependencies: [], complexity: 99 },
        { id: 'b', title: 'B', description: 'B', domain: 'coder', dependencies: [], complexity: -5 },
      ],
    });
    const graph = parseDecompositionResponse(json, 'test');
    assert.strictEqual(graph.tasks[0].complexity, 5);
    assert.strictEqual(graph.tasks[1].complexity, 1);
  });

  test('validates unknown domains to coder', () => {
    const json = JSON.stringify({
      tasks: [{ id: 'a', title: 'A', description: 'A', domain: 'unicorn-magic', dependencies: [] }],
    });
    const graph = parseDecompositionResponse(json, 'test');
    assert.strictEqual(graph.tasks[0].domain, 'coder');
  });

  test('throws on empty tasks array', () => {
    assert.throws(() => parseDecompositionResponse('{"tasks":[]}', 'test'), /no tasks/i);
  });

  test('throws on invalid JSON', () => {
    assert.throws(() => parseDecompositionResponse('not json at all', 'test'));
  });

  test('skips malformed tasks without id', () => {
    const json = JSON.stringify({
      tasks: [
        { title: 'No ID', description: 'Oops', domain: 'coder', dependencies: [] },
        { id: 'good', title: 'Good', description: 'OK', domain: 'coder', dependencies: [] },
      ],
    });
    const graph = parseDecompositionResponse(json, 'test');
    assert.strictEqual(graph.tasks.length, 1);
    assert.strictEqual(graph.tasks[0].id, 'good');
  });

  test('sets default priority and complexity', () => {
    const json = JSON.stringify({
      tasks: [{ id: 'a', title: 'A', description: 'A', domain: 'coder', dependencies: [] }],
    });
    const graph = parseDecompositionResponse(json, 'test');
    assert.strictEqual(graph.tasks[0].priority, 50);
    assert.strictEqual(graph.tasks[0].complexity, 3);
  });
});

// ═══════════════════════════════════════
//  3. Cycle Detection
// ═══════════════════════════════════════

suite('Task Decomposer — hasCycle', () => {
  test('no cycle in linear chain', () => {
    const tasks: SubTask[] = [
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: ['b'], status: 'pending' },
    ];
    assert.strictEqual(hasCycle(tasks), false);
  });

  test('detects direct cycle', () => {
    const tasks: SubTask[] = [
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: ['b'], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
    ];
    assert.strictEqual(hasCycle(tasks), true);
  });

  test('detects indirect cycle', () => {
    const tasks: SubTask[] = [
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: ['c'], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: ['b'], status: 'pending' },
    ];
    assert.strictEqual(hasCycle(tasks), true);
  });

  test('no cycle in parallel tasks', () => {
    const tasks: SubTask[] = [
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: ['a', 'b'], status: 'pending' },
    ];
    assert.strictEqual(hasCycle(tasks), false);
  });

  test('single task with no cycle', () => {
    const tasks: SubTask[] = [
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
    ];
    assert.strictEqual(hasCycle(tasks), false);
  });
});

// ═══════════════════════════════════════
//  4. Topological Tier Sorting (replicated pure logic)
// ═══════════════════════════════════════

function topologicalTiers(graph: TaskGraph): SubTask[][] {
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
    const tier: SubTask[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) <= 0) {
        const task = taskMap.get(id);
        if (task) { tier.push(task); }
      }
    }
    if (tier.length === 0) {
      const forced: SubTask[] = [];
      for (const id of remaining) {
        const task = taskMap.get(id);
        if (task) { forced.push(task); }
      }
      tiers.push(forced);
      break;
    }
    tier.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
    tiers.push(tier);
    for (const task of tier) {
      remaining.delete(task.id);
      for (const next of dependants.get(task.id) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      }
    }
  }
  return tiers;
}

function makeGraph(tasks: SubTask[]): TaskGraph {
  const edges: Record<string, string[]> = {};
  for (const t of tasks) { edges[t.id] = []; }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!edges[dep]) { edges[dep] = []; }
      edges[dep].push(t.id);
    }
  }
  return { goal: 'test', tasks, edges, createdAt: Date.now(), totalComplexity: 10 };
}

suite('Topological Tiers', () => {
  test('single tier for independent tasks', () => {
    const graph = makeGraph([
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: [], status: 'pending' },
    ]);
    const tiers = topologicalTiers(graph);
    assert.strictEqual(tiers.length, 1);
    assert.strictEqual(tiers[0].length, 3);
  });

  test('linear chain produces one tier per task', () => {
    const graph = makeGraph([
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: ['b'], status: 'pending' },
    ]);
    const tiers = topologicalTiers(graph);
    assert.strictEqual(tiers.length, 3);
    assert.strictEqual(tiers[0][0].id, 'a');
    assert.strictEqual(tiers[1][0].id, 'b');
    assert.strictEqual(tiers[2][0].id, 'c');
  });

  test('diamond graph has correct tiers', () => {
    const graph = makeGraph([
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
      { id: 'd', title: 'D', description: '', domain: 'coder', dependencies: ['b', 'c'], status: 'pending' },
    ]);
    const tiers = topologicalTiers(graph);
    assert.strictEqual(tiers.length, 3);
    assert.strictEqual(tiers[0].length, 1);
    assert.strictEqual(tiers[1].length, 2);
    assert.strictEqual(tiers[2].length, 1);
    assert.deepStrictEqual(tiers[1].map(t => t.id).sort(), ['b', 'c']);
  });

  test('complex DAG with multiple roots', () => {
    const graph = makeGraph([
      { id: 'a', title: 'A', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'b', title: 'B', description: '', domain: 'coder', dependencies: [], status: 'pending' },
      { id: 'c', title: 'C', description: '', domain: 'coder', dependencies: ['a'], status: 'pending' },
      { id: 'd', title: 'D', description: '', domain: 'coder', dependencies: ['b'], status: 'pending' },
      { id: 'e', title: 'E', description: '', domain: 'coder', dependencies: ['c', 'd'], status: 'pending' },
    ]);
    const tiers = topologicalTiers(graph);
    assert.strictEqual(tiers.length, 3);
    assert.strictEqual(tiers[0].length, 2);
    assert.strictEqual(tiers[1].length, 2);
    assert.strictEqual(tiers[2].length, 1);
  });

  test('sorts within tiers by priority', () => {
    const graph = makeGraph([
      { id: 'low', title: 'Low', description: '', domain: 'coder', dependencies: [], status: 'pending', priority: 10 },
      { id: 'high', title: 'High', description: '', domain: 'coder', dependencies: [], status: 'pending', priority: 90 },
      { id: 'mid', title: 'Mid', description: '', domain: 'coder', dependencies: [], status: 'pending', priority: 50 },
    ]);
    const tiers = topologicalTiers(graph);
    assert.strictEqual(tiers[0][0].id, 'high');
    assert.strictEqual(tiers[0][1].id, 'mid');
    assert.strictEqual(tiers[0][2].id, 'low');
  });

  test('handles single task', () => {
    const graph = makeGraph([
      { id: 'only', title: 'Only', description: '', domain: 'coder', dependencies: [], status: 'pending' },
    ]);
    const tiers = topologicalTiers(graph);
    assert.strictEqual(tiers.length, 1);
    assert.strictEqual(tiers[0].length, 1);
  });
});

// ═══════════════════════════════════════
//  5. Complexity Assessment (replicated pure logic)
// ═══════════════════════════════════════

function assessComplexity(goal: string): number {
  const lower = goal.toLowerCase();
  let score = 0;

  if (goal.length > 500) { score += 20; }
  else if (goal.length > 200) { score += 10; }

  const multiFilePatterns = [
    /multiple\s+files/i, /across\s+(?:the\s+)?(?:project|codebase|repo)/i,
    /full[- ]stack/i, /end[- ]to[- ]end/i, /entire\s+(?:system|application|project)/i,
    /\band\b.*\band\b.*\band\b/i,
  ];
  for (const p of multiFilePatterns) {
    if (p.test(lower)) { score += 15; break; }
  }

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

  const complexityMarkers = [
    'production', 'enterprise', 'scalable', 'microservice',
    'architecture', 'refactor the entire', 'rewrite',
    'comprehensive', 'complete', 'full implementation',
    'from scratch', 'ground up',
  ];
  for (const marker of complexityMarkers) {
    if (lower.includes(marker)) { score += 10; break; }
  }

  const numberedSteps = lower.match(/\d+\.\s/g);
  if (numberedSteps && numberedSteps.length >= 3) { score += 15; }

  const fileRefs = goal.match(/\b\w+\.\w{1,5}\b/g);
  if (fileRefs && fileRefs.length >= 4) { score += 10; }

  return Math.min(100, score);
}

suite('Complexity Assessment', () => {
  test('short simple prompt scores low', () => {
    const score = assessComplexity('Fix the button color');
    assert.ok(score < 50, `Expected <50, got ${score}`);
  });

  test('long multi-domain prompt scores high', () => {
    const score = assessComplexity(
      'Build a production full-stack application with authentication, database schema with migrations, ' +
      'REST API endpoints, comprehensive unit tests, security audit, performance optimization, ' +
      'CI/CD pipeline with Docker, and full API documentation across the entire project',
    );
    assert.ok(score >= 50, `Expected ≥50, got ${score}`);
  });

  test('multi-file keyword increases score', () => {
    const withMultiFile = assessComplexity('Refactor the authentication system across the entire codebase with tests');
    const simpleRefactor = assessComplexity('Rename a variable');
    assert.ok(withMultiFile > simpleRefactor, `Multi-file (${withMultiFile}) should score higher than simple (${simpleRefactor})`);
  });

  test('security + testing domains increase score', () => {
    const score = assessComplexity('Add authentication with security audit and integration tests');
    assert.ok(score >= 20, `Expected ≥20, got ${score}`);
  });

  test('numbered steps increase score', () => {
    const score = assessComplexity(
      '1. Create the models\n2. Build the API\n3. Add validation\n4. Write tests\n5. Deploy',
    );
    assert.ok(score >= 15, `Expected ≥15, got ${score}`);
  });

  test('enterprise markers increase score', () => {
    const score = assessComplexity('Build a scalable microservice architecture from scratch');
    assert.ok(score >= 10, `Expected ≥10, got ${score}`);
  });

  test('scores capped at 100', () => {
    const score = assessComplexity(
      'Build a production enterprise scalable microservice full-stack application ' +
      'with security audit, comprehensive unit tests, integration tests, e2e tests, ' +
      'database schema migrations, REST API, GraphQL endpoints, CI/CD pipeline with Docker, ' +
      'Kubernetes deployment, Terraform infrastructure, complete API documentation, ' +
      'performance optimization and caching across the entire project codebase. ' +
      '1. Auth 2. DB 3. API 4. Tests 5. Deploy 6. Docs 7. Perf 8. Security',
    );
    assert.ok(score <= 100, `Score should be ≤100, got ${score}`);
  });

  test('empty string scores 0', () => {
    assert.strictEqual(assessComplexity(''), 0);
  });
});
