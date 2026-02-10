import * as vscode from 'vscode';
import {
  StreamEvent, ToolDefinition, ToolContext, ChatMessage,
  ArchitectureSpec, FullAppResult,
} from '../types';
import { chatCompletion } from '../client/nvidiaClient';
import { getConfig } from '../config';
import { logInfo, logError, logWarn, getOutputChannel } from '../logger';
import { buildToolRegistry } from '../tools';
import { gatherWorkspaceContext } from '../context/workspace';
import { runAgentLoop, buildSystemPrompt } from '../agents/base';
import { getAgentByDomain } from '../agents/registry';

/* ────────────────────────────────────────────────────────
   Full-App Orchestrator — Production App Creation Pipeline

   This is the "Create a clone of Spotify" engine.
   It runs a multi-phase pipeline:

   Phase 1  Architect  — PRD + tech stack + API contracts + DB schema + component tree
   Phase 2  Scaffold   — Create directory structure, config files, package.json
   Phase 3  Backend    — API routes, services, models, auth, middleware
   Phase 4  Frontend   — Pages, components, layouts, styling, state management
   Phase 5  Testing    — Unit tests, integration tests
   Phase 6  Security   — Security audit and fixes
   Phase 7  DevOps     — Dockerfile, CI/CD, env config
   Phase 8  Docs       — README, API docs, architecture docs

   Each phase uses the appropriate domain agent from the registry.
   ──────────────────────────────────────────────────────── */

export interface AppOrchestratorOptions {
  goal: string;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

/* ═══════════════════ Detection ═══════════════════ */

/**
 * Detect whether a user prompt is an app-creation request.
 * Examples that match:
 *   "Create a clone of Spotify"
 *   "Build me a full-stack e-commerce app"
 *   "Make a project management tool like Jira"
 *   "Create a SaaS dashboard with auth and payments"
 */
export function isAppCreationRequest(goal: string): boolean {
  const lower = goal.toLowerCase().trim();

  const appPatterns = [
    /(?:create|build|make|develop|scaffold|generate)\s+(?:a|an|me\s+a|me\s+an)\s+(?:.*?)(?:app|application|website|web\s*app|platform|dashboard|portal|clone|saas|tool|system|service)/i,
    /(?:create|build|make)\s+(?:a\s+)?(?:clone|copy|replica|version)\s+(?:of\s+)?(?:\w+)/i,
    /(?:full[- ]?stack|fullstack)\s+(?:app|application|project|website)/i,
    /(?:create|build|make)\s+(?:a\s+)?(?:next\.?js|react|vue|angular)\s+(?:app|project|website)/i,
    /(?:create|build|make)\s+(?:a\s+)?(?:.*?)\s+with\s+(?:auth|database|api|payment|stripe|supabase)/i,
    /(?:spotify|twitter|airbnb|uber|slack|discord|notion|trello|jira|netflix|youtube|instagram|tiktok|whatsapp|reddit|github|stripe|shopify)\s*(?:clone|like|similar|style)/i,
    /clone\s+(?:of\s+)?(?:spotify|twitter|airbnb|uber|slack|discord|notion|trello|jira|netflix|youtube|instagram)/i,
    /(?:e-?commerce|todo|blog|chat|crm|cms|erp|lms|social\s*media|booking|marketplace)\s+(?:app|application|platform|website|system)/i,
  ];

  for (const p of appPatterns) {
    if (p.test(lower)) { return true; }
  }

  // Multi-feature app requests
  const featureKeywords = ['auth', 'database', 'api', 'dashboard', 'admin panel',
    'user management', 'payments', 'real-time', 'notifications', 'search',
    'file upload', 'chat', 'profile', 'settings'];
  let featureCount = 0;
  for (const kw of featureKeywords) {
    if (lower.includes(kw)) { featureCount++; }
  }
  if (featureCount >= 3 && (lower.includes('create') || lower.includes('build') || lower.includes('make'))) {
    return true;
  }

  return false;
}

/* ═══════════════════ Main Pipeline ═══════════════════ */

export async function runAppCreationPipeline(opts: AppOrchestratorOptions): Promise<FullAppResult> {
  const { goal, signal, onEvent } = opts;
  const startTime = Date.now();
  const phasesCompleted: string[] = [];
  let totalTokens = 0;
  let filesCreated: string[] = [];

  // Resolve workspace
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    throw new Error('No workspace folder is open. Please open an empty folder to scaffold your app.');
  }
  const workspaceRoot = wsFolder.uri.fsPath;

  const tools = buildToolRegistry();
  const toolContext: ToolContext = {
    workspaceRoot,
    outputChannel: getOutputChannel(),
    token: undefined,
    onProgress: (msg) => onEvent?.({ type: 'status', content: msg }),
  };

  onEvent?.({ type: 'status', content: '🏗️ Starting full-app creation pipeline…' });
  onEvent?.({ type: 'text', content: `## 🏗️ Full-App Creation Pipeline\n\n**Goal**: ${goal}\n\n---\n` });

  // ═══════════════════════════════════════════════════
  //  PHASE 1: Architecture & PRD
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '📐 Phase 1/8: Generating architecture & PRD…' });
  onEvent?.({ type: 'text', content: '### 📐 Phase 1: Architecture & PRD\n' });

  let architecture: ArchitectureSpec;
  try {
    architecture = await generateArchitecture(goal, workspaceRoot, signal);
    phasesCompleted.push('architecture');
    onEvent?.({ type: 'text', content: formatArchitectureSummary(architecture) });
    onEvent?.({ type: 'status', content: `📐 Architecture complete — ${architecture.features.length} features, ${architecture.apiContracts.length} API endpoints, ${architecture.dataModels.length} models` });
  } catch (err) {
    logError('Architecture generation failed', err);
    onEvent?.({ type: 'error', content: `Architecture generation failed: ${err instanceof Error ? err.message : String(err)}` });
    return makeFailedResult(goal, 'Architecture generation failed', startTime);
  }

  if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }

  // ═══════════════════════════════════════════════════
  //  PHASE 2: Scaffold Directory Structure
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '📁 Phase 2/8: Scaffolding project structure…' });
  onEvent?.({ type: 'text', content: '\n### 📁 Phase 2: Project Scaffold\n' });

  try {
    const scaffoldResult = await runDomainAgent(
      'coder',
      buildScaffoldPrompt(architecture),
      workspaceRoot, tools, toolContext, signal, onEvent,
    );
    filesCreated.push(...extractFilesFromResponse(scaffoldResult));
    phasesCompleted.push('scaffold');
    onEvent?.({ type: 'status', content: `📁 Scaffold complete — ${filesCreated.length} files created` });
  } catch (err) {
    logError('Scaffold failed', err);
    onEvent?.({ type: 'status', content: '⚠️ Scaffold had issues, continuing…' });
  }

  if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }

  // ═══════════════════════════════════════════════════
  //  PHASE 3: Backend Implementation
  // ═══════════════════════════════════════════════════
  if (architecture.techStack.backend !== 'none') {
    onEvent?.({ type: 'status', content: '⚙️ Phase 3/8: Building backend…' });
    onEvent?.({ type: 'text', content: '\n### ⚙️ Phase 3: Backend Implementation\n' });

    try {
      const backendResult = await runDomainAgent(
        'backend',
        buildBackendPrompt(architecture),
        workspaceRoot, tools, toolContext, signal, onEvent,
      );
      filesCreated.push(...extractFilesFromResponse(backendResult));
      phasesCompleted.push('backend');
      onEvent?.({ type: 'status', content: '⚙️ Backend complete' });
    } catch (err) {
      logError('Backend phase failed', err);
      onEvent?.({ type: 'status', content: '⚠️ Backend had issues, continuing…' });
    }

    if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }
  } else {
    phasesCompleted.push('backend-skipped');
  }

  // ═══════════════════════════════════════════════════
  //  PHASE 4: Frontend Implementation
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '🎨 Phase 4/8: Building frontend UI…' });
  onEvent?.({ type: 'text', content: '\n### 🎨 Phase 4: Frontend UI Implementation\n' });

  try {
    const frontendResult = await runDomainAgent(
      'frontend',
      buildFrontendPrompt(architecture),
      workspaceRoot, tools, toolContext, signal, onEvent,
    );
    filesCreated.push(...extractFilesFromResponse(frontendResult));
    phasesCompleted.push('frontend');
    onEvent?.({ type: 'status', content: '🎨 Frontend complete' });
  } catch (err) {
    logError('Frontend phase failed', err);
    onEvent?.({ type: 'status', content: '⚠️ Frontend had issues, continuing…' });
  }

  if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }

  // ═══════════════════════════════════════════════════
  //  PHASE 5: Testing
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '🧪 Phase 5/8: Generating tests…' });
  onEvent?.({ type: 'text', content: '\n### 🧪 Phase 5: Test Generation\n' });

  try {
    const testResult = await runDomainAgent(
      'testing',
      buildTestPrompt(architecture),
      workspaceRoot, tools, toolContext, signal, onEvent,
    );
    filesCreated.push(...extractFilesFromResponse(testResult));
    phasesCompleted.push('testing');
    onEvent?.({ type: 'status', content: '🧪 Tests complete' });
  } catch (err) {
    logError('Testing phase failed', err);
    onEvent?.({ type: 'status', content: '⚠️ Testing had issues, continuing…' });
  }

  if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }

  // ═══════════════════════════════════════════════════
  //  PHASE 6: Security Audit
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '🔒 Phase 6/8: Security audit…' });
  onEvent?.({ type: 'text', content: '\n### 🔒 Phase 6: Security Audit\n' });

  try {
    await runDomainAgent(
      'security',
      `Audit all the code that was just created for the "${architecture.name}" application. Check for OWASP Top-10 vulnerabilities, hardcoded secrets, injection risks, missing input validation, insecure auth patterns. Fix any critical/high issues you find.`,
      workspaceRoot, tools, toolContext, signal, onEvent,
    );
    phasesCompleted.push('security');
    onEvent?.({ type: 'status', content: '🔒 Security audit complete' });
  } catch (err) {
    logError('Security audit failed', err);
    onEvent?.({ type: 'status', content: '⚠️ Security audit had issues' });
  }

  if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }

  // ═══════════════════════════════════════════════════
  //  PHASE 7: DevOps
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '🐳 Phase 7/8: DevOps setup…' });
  onEvent?.({ type: 'text', content: '\n### 🐳 Phase 7: DevOps & Deployment\n' });

  try {
    const devopsResult = await runDomainAgent(
      'devops',
      buildDevOpsPrompt(architecture),
      workspaceRoot, tools, toolContext, signal, onEvent,
    );
    filesCreated.push(...extractFilesFromResponse(devopsResult));
    phasesCompleted.push('devops');
    onEvent?.({ type: 'status', content: '🐳 DevOps setup complete' });
  } catch (err) {
    logError('DevOps phase failed', err);
    onEvent?.({ type: 'status', content: '⚠️ DevOps had issues' });
  }

  if (signal?.aborted) { return makeCancelledResult(goal, architecture, startTime); }

  // ═══════════════════════════════════════════════════
  //  PHASE 8: Documentation
  // ═══════════════════════════════════════════════════
  onEvent?.({ type: 'status', content: '📝 Phase 8/8: Writing documentation…' });
  onEvent?.({ type: 'text', content: '\n### 📝 Phase 8: Documentation\n' });

  try {
    const docsResult = await runDomainAgent(
      'documentation',
      buildDocsPrompt(architecture),
      workspaceRoot, tools, toolContext, signal, onEvent,
    );
    filesCreated.push(...extractFilesFromResponse(docsResult));
    phasesCompleted.push('documentation');
    onEvent?.({ type: 'status', content: '📝 Documentation complete' });
  } catch (err) {
    logError('Documentation phase failed', err);
    onEvent?.({ type: 'status', content: '⚠️ Documentation had issues' });
  }

  // ═══════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════
  const uniqueFiles = [...new Set(filesCreated)];
  const totalDuration = Date.now() - startTime;

  const summary = buildFinalSummary(architecture, phasesCompleted, uniqueFiles, totalDuration);
  onEvent?.({ type: 'text', content: summary });
  onEvent?.({ type: 'done', content: summary });

  logInfo(`App creation pipeline complete: ${phasesCompleted.length}/8 phases, ${uniqueFiles.length} files, ${totalDuration}ms`);

  return {
    success: phasesCompleted.length >= 4, // At least arch+scaffold+frontend+backend
    appName: architecture.name,
    architecture,
    filesCreated: uniqueFiles,
    summary,
    totalDurationMs: totalDuration,
    totalTokensUsed: totalTokens,
    phasesCompleted,
  };
}

/* ═══════════════════ Phase 1: Architecture LLM Call ═══════════════════ */

async function generateArchitecture(
  goal: string,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<ArchitectureSpec> {
  const spec = getAgentByDomain('architect');
  if (!spec) { throw new Error('Architect agent not found in registry'); }

  const wsContext = await gatherWorkspaceContext(workspaceRoot);

  const messages: ChatMessage[] = [
    { role: 'system', content: spec.instructions },
    {
      role: 'user',
      content: `## User Request\n${goal}\n\n## Current Workspace\n${wsContext.slice(0, 4000)}\n\nProduce the COMPLETE architecture spec as JSON. Include ALL sections: name, description, features, techStack, directoryStructure, apiContracts, dataModels, componentTree, envVars, integrations.\n\n**IMPORTANT: Return ONLY valid JSON. No comments (# or //), no trailing commas. The output is parsed by JSON.parse() directly.**`,
    },
  ];

  const raw = await chatCompletion({
    messages,
    temperature: 0.2,
    maxTokens: 8192,
    signal,
  });

  return parseArchitectureResponse(raw, goal);
}

/**
 * Strip comments (# and //) from LLM-generated JSON.
 * LLMs frequently add inline comments which are not valid JSON.
 */
function stripJsonComments(text: string): string {
  // Remove single-line // comments (but not inside strings)
  // Remove single-line # comments (but not inside strings)
  // Process line-by-line to avoid breaking string values
  const lines = text.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    let inString = false;
    let escaped = false;
    let commentStart = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === '#') { commentStart = i; break; }
        if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') { commentStart = i; break; }
      }
    }
    result.push(commentStart >= 0 ? line.slice(0, commentStart) : line);
  }
  return result.join('\n');
}

function parseArchitectureResponse(raw: string, goal: string): ArchitectureSpec {
  // Strip markdown fences
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }

  // Strip comments that LLMs sometimes add (#, //)
  cleaned = stripJsonComments(cleaned);

  // Remove trailing commas before } or ] (another common LLM mistake)
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(cleaned);
    return normalizeArchitecture(parsed, goal);
  } catch (firstErr) {
    // Try to extract JSON from mixed content
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        let extracted = stripJsonComments(jsonMatch[0]);
        extracted = extracted.replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(extracted);
        return normalizeArchitecture(parsed, goal);
      } catch { /* fall through to final error */ }
    }
    const detail = firstErr instanceof Error ? firstErr.message : String(firstErr);
    throw new Error(`Failed to parse architecture response as JSON: ${detail}`);
  }
}

function normalizeArchitecture(parsed: Record<string, unknown>, goal: string): ArchitectureSpec {
  const defaults: ArchitectureSpec = {
    name: 'my-app',
    description: goal,
    features: [],
    techStack: {
      frontend: 'next', styling: 'tailwind', backend: 'express',
      database: 'postgresql', orm: 'prisma', auth: 'nextauth', deployment: 'docker',
    },
    directoryStructure: [],
    apiContracts: [],
    dataModels: [],
    componentTree: [],
    envVars: [],
    integrations: [],
  };

  return {
    name: String(parsed.name ?? defaults.name),
    description: String(parsed.description ?? defaults.description),
    features: Array.isArray(parsed.features) ? parsed.features.map(String) : defaults.features,
    techStack: {
      ...defaults.techStack,
      ...(parsed.techStack && typeof parsed.techStack === 'object' ? parsed.techStack as Partial<ArchitectureSpec['techStack']> : {}),
    },
    directoryStructure: Array.isArray(parsed.directoryStructure)
      ? parsed.directoryStructure.map(String) : defaults.directoryStructure,
    apiContracts: Array.isArray(parsed.apiContracts)
      ? (parsed.apiContracts as ArchitectureSpec['apiContracts']) : defaults.apiContracts,
    dataModels: Array.isArray(parsed.dataModels)
      ? (parsed.dataModels as ArchitectureSpec['dataModels']) : defaults.dataModels,
    componentTree: Array.isArray(parsed.componentTree)
      ? (parsed.componentTree as ArchitectureSpec['componentTree']) : defaults.componentTree,
    envVars: Array.isArray(parsed.envVars) ? parsed.envVars.map(String) : defaults.envVars,
    integrations: Array.isArray(parsed.integrations) ? parsed.integrations.map(String) : defaults.integrations,
  };
}

/* ═══════════════════ Domain Agent Runner ═══════════════════ */

async function runDomainAgent(
  domain: string,
  taskPrompt: string,
  workspaceRoot: string,
  tools: ToolDefinition[],
  toolContext: ToolContext,
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
): Promise<string> {
  const spec = getAgentByDomain(domain as import('../types').SubAgentDomain);
  if (!spec) {
    logWarn(`No agent for domain "${domain}", falling back to coder`);
  }

  const instructions = spec?.instructions ?? 'You are an expert software engineer. Implement the requested changes.';
  const maxIter = spec?.maxIterations ?? 30;

  // Filter tools if agent has allowedTools
  let agentTools = tools;
  if (spec?.allowedTools && spec.allowedTools.length > 0) {
    const allowed = new Set(spec.allowedTools);
    agentTools = tools.filter(t => allowed.has(t.name));
  }

  const wsContext = await gatherWorkspaceContext(workspaceRoot);
  const systemPrompt = buildSystemPrompt(spec?.name ?? 'Agent', instructions, agentTools, wsContext);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: taskPrompt },
  ];

  const result = await runAgentLoop({
    messages,
    tools: agentTools,
    toolContext,
    maxIterations: maxIter,
    signal,
    onEvent: (event) => {
      if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'status') {
        onEvent?.(event);
      }
    },
  });

  return result.response;
}

/* ═══════════════════ Prompt Builders ═══════════════════ */

function buildScaffoldPrompt(arch: ArchitectureSpec): string {
  return `## Task: Scaffold the "${arch.name}" project

Create the complete directory structure and configuration files for this project.

## Technology Stack
- Frontend: ${arch.techStack.frontend} + ${arch.techStack.styling}
- Backend: ${arch.techStack.backend}
- Database: ${arch.techStack.database} + ORM: ${arch.techStack.orm}
- Auth: ${arch.techStack.auth}
- Deployment: ${arch.techStack.deployment}

## Files to Create
${arch.directoryStructure.map(f => `- ${f}`).join('\n')}

## Instructions
1. Create package.json with all necessary dependencies (exact versions)
2. Create tsconfig.json with strict mode
3. Create .env.example with these variables:
${arch.envVars.map(v => `   ${v}`).join('\n')}
4. Create .gitignore (node_modules, .env, dist, .next, etc.)
5. Create the full directory structure with placeholder files
6. If using Next.js, create app/layout.tsx, app/page.tsx with proper structure
7. If using Prisma, create prisma/schema.prisma with these models:
${arch.dataModels.map(m => `   - ${m.name}: ${m.fields.map(f => f.name).join(', ')}`).join('\n')}

Create ALL config files with production-ready settings. Use write_file for each file.`;
}

function buildBackendPrompt(arch: ArchitectureSpec): string {
  return `## Task: Implement the backend for "${arch.name}"

## Technology Stack
- Runtime: Node.js + TypeScript
- Framework: ${arch.techStack.backend}
- Database: ${arch.techStack.database} + ORM: ${arch.techStack.orm}
- Auth: ${arch.techStack.auth}

## API Contracts to Implement
${arch.apiContracts.map(api =>
    `### ${api.method} ${api.path}\n${api.description}\nAuth required: ${api.auth}\n${api.requestBody ? `Request: ${api.requestBody}` : ''}\n${api.responseBody ? `Response: ${api.responseBody}` : ''}`
  ).join('\n\n')}

## Data Models
${arch.dataModels.map(m =>
    `### ${m.name}\nFields: ${m.fields.map(f => `${f.name}: ${f.type}${f.constraints ? ` (${f.constraints})` : ''}`).join(', ')}\n${m.relations ? `Relations: ${m.relations.join(', ')}` : ''}`
  ).join('\n\n')}

## Implementation Requirements
1. Read existing files first to understand the current project structure
2. Implement ALL API routes with proper validation (use zod)
3. Create service layer — NO business logic in route handlers
4. Implement proper error handling middleware with consistent error responses
5. Set up authentication middleware (JWT or session-based)
6. Create database connection with connection pooling
7. Add input validation on ALL endpoints
8. Return proper HTTP status codes
9. Add structured logging
10. Create seed data script

Implement EVERY endpoint in the API contracts above. Use write_file and edit_file tools.`;
}

function buildFrontendPrompt(arch: ArchitectureSpec): string {
  return `## Task: Implement the frontend UI for "${arch.name}"

## Technology Stack
- Framework: ${arch.techStack.frontend}
- Styling: ${arch.techStack.styling}
- Auth: ${arch.techStack.auth}

## Component Tree
${arch.componentTree.map(c =>
    `### ${c.name} (${c.path})\n${c.description}\n${c.props ? `Props: ${c.props.join(', ')}` : ''}\n${c.children ? `Children: ${c.children.join(', ')}` : ''}`
  ).join('\n\n')}

## Pages to Implement
${arch.directoryStructure
    .filter(f => f.includes('/page.') || f.includes('/pages/') || f.includes('/app/'))
    .map(f => `- ${f}`)
    .join('\n')}

## UI Requirements

### Design System
- Use ${arch.techStack.styling === 'tailwind' ? 'Tailwind CSS' : arch.techStack.styling} for all styling
- Implement dark mode support from day 1
- Responsive design: mobile-first (sm → md → lg → xl breakpoints)
- Consistent spacing: use 4px base unit scale
- Use CSS variables or Tailwind semantic colors for theming

### Must-Have Components
1. **Layout** — responsive shell with sidebar navigation + top bar
2. **Navigation** — collapsible sidebar, mobile hamburger menu, active state
3. **Cards** — content cards with hover effects, shadows, rounded corners
4. **Forms** — styled inputs with labels, validation states, error messages
5. **Buttons** — primary, secondary, ghost variants with loading states
6. **Tables** — sortable, paginated, with empty/loading states
7. **Modals** — with overlay, focus trap, close on Escape
8. **Toast notifications** — success/error/info variants
9. **Loading skeletons** — match content layout (NOT spinners)
10. **Empty states** — friendly illustrations/icons with action buttons

### Interaction
- Smooth transitions (transition-all duration-200)
- Hover states on all interactive elements
- Active/pressed states on buttons (active:scale-95)
- Form validation with inline error messages
- Optimistic UI updates where appropriate

### Quality
- Semantic HTML (nav, main, section, article — NOT div soup)
- Accessible: ARIA labels, keyboard navigation, focus management
- TypeScript strict mode — explicit interfaces for all props
- No inline styles — all styling through ${arch.techStack.styling}

Read existing files to understand the project structure, then implement ALL pages and components using write_file and edit_file.
Make the UI look like a premium $10M SaaS product. Beautiful, polished, professional.`;
}

function buildTestPrompt(arch: ArchitectureSpec): string {
  return `## Task: Generate comprehensive tests for "${arch.name}"

Read all the source files that were created, then generate:

1. **API Tests** — test every endpoint in the API:
${arch.apiContracts.map(api => `   - ${api.method} ${api.path}: happy path + error cases`).join('\n')}

2. **Unit Tests** — test service layer functions, utility functions, validators

3. **Component Tests** — test key UI components render correctly

## Standards
- Use the project's test framework (Jest, Vitest, or Mocha)
- Each test should test ONE behavior
- Include happy path, error cases, and edge cases
- Use descriptive test names
- Mock external dependencies (database, APIs)
- Aim for ≥80% coverage of critical paths

Read existing files first, then write test files using write_file.`;
}

function buildDevOpsPrompt(arch: ArchitectureSpec): string {
  return `## Task: Set up DevOps for "${arch.name}"

Create the following files:

1. **Dockerfile** — multi-stage build (builder + runner), minimal production image
2. **docker-compose.yml** — app + database + any other services
3. **.github/workflows/ci.yml** — GitHub Actions CI pipeline:
   - Install dependencies
   - Type check (tsc --noEmit)
   - Run linter
   - Run tests
   - Build production bundle
4. **.dockerignore** — exclude node_modules, .env, .git, etc.
5. **Makefile** or **scripts/** — common dev commands (dev, build, test, lint, db:migrate, db:seed)

## Technology context
- Runtime: Node.js
- Database: ${arch.techStack.database}
- ORM: ${arch.techStack.orm}
- Deployment target: ${arch.techStack.deployment}

Read existing files to understand the structure, then create ALL DevOps files using write_file.`;
}

function buildDocsPrompt(arch: ArchitectureSpec): string {
  return `## Task: Write documentation for "${arch.name}"

Read all the source files that were created, then write:

1. **README.md** — comprehensive project README with:
   - Project description and screenshots placeholder
   - Tech stack overview
   - Getting started (prerequisites, install, run)
   - Environment variables documentation
   - Project structure overview
   - API documentation summary
   - Contributing guidelines
   - License

2. **docs/API.md** — complete API documentation:
${arch.apiContracts.map(api => `   - ${api.method} ${api.path}: ${api.description}`).join('\n')}

3. **docs/ARCHITECTURE.md** — architecture decision records:
   - Tech stack decisions with rationale
   - Directory structure explanation
   - Data model relationships
   - Auth flow
   - Deployment architecture

Read existing files first, then create documentation files using write_file.`;
}

/* ═══════════════════ Formatting ═══════════════════ */

function formatArchitectureSummary(arch: ArchitectureSpec): string {
  return `
**App**: ${arch.name}
**Description**: ${arch.description}

**Tech Stack**:
- Frontend: ${arch.techStack.frontend} + ${arch.techStack.styling}
- Backend: ${arch.techStack.backend} + ${arch.techStack.database}
- ORM: ${arch.techStack.orm} | Auth: ${arch.techStack.auth}
- Deploy: ${arch.techStack.deployment}

**Features** (${arch.features.length}):
${arch.features.slice(0, 10).map(f => `- ${f}`).join('\n')}
${arch.features.length > 10 ? `- … and ${arch.features.length - 10} more` : ''}

**API Endpoints**: ${arch.apiContracts.length}
**Data Models**: ${arch.dataModels.length}
**Components**: ${arch.componentTree.length}
**Files to create**: ${arch.directoryStructure.length}
`;
}

function buildFinalSummary(
  arch: ArchitectureSpec,
  phases: string[],
  files: string[],
  durationMs: number,
): string {
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);

  return `
---

## ✅ App Creation Complete!

**${arch.name}** has been created successfully.

### Pipeline Results
| Phase | Status |
|-------|--------|
| 📐 Architecture & PRD | ${phases.includes('architecture') ? '✅' : '❌'} |
| 📁 Project Scaffold | ${phases.includes('scaffold') ? '✅' : '❌'} |
| ⚙️ Backend | ${phases.includes('backend') ? '✅' : phases.includes('backend-skipped') ? '⏭️ Skipped' : '❌'} |
| 🎨 Frontend UI | ${phases.includes('frontend') ? '✅' : '❌'} |
| 🧪 Testing | ${phases.includes('testing') ? '✅' : '❌'} |
| 🔒 Security Audit | ${phases.includes('security') ? '✅' : '❌'} |
| 🐳 DevOps | ${phases.includes('devops') ? '✅' : '❌'} |
| 📝 Documentation | ${phases.includes('documentation') ? '✅' : '❌'} |

### Stats
- **Files created**: ${files.length}
- **Phases completed**: ${phases.length}/8
- **Duration**: ${mins}m ${secs}s

### Next Steps
1. Run \`npm install\` to install dependencies
2. Copy \`.env.example\` to \`.env\` and fill in your values
3. Run \`npm run dev\` to start development server
4. Check the README.md for full documentation
`;
}

/* ═══════════════════ Helpers ═══════════════════ */

function extractFilesFromResponse(response: string): string[] {
  const files: string[] = [];
  // Match write_file and edit_file tool calls
  const filePatterns = [
    /(?:write_file|Created|wrote|created)\s*[:\s]+["']?([^\s"']+\.\w+)/gi,
    /Successfully wrote\s+(\S+)/gi,
    /Successfully edited\s+(\S+)/gi,
  ];
  for (const pattern of filePatterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      files.push(match[1]);
    }
  }
  return files;
}

function makeFailedResult(goal: string, reason: string, startTime: number): FullAppResult {
  return {
    success: false,
    appName: 'unknown',
    architecture: {
      name: 'unknown', description: goal, features: [],
      techStack: { frontend: 'next', styling: 'tailwind', backend: 'express', database: 'postgresql', orm: 'prisma', auth: 'nextauth', deployment: 'docker' },
      directoryStructure: [], apiContracts: [], dataModels: [], componentTree: [], envVars: [], integrations: [],
    },
    filesCreated: [],
    summary: `❌ App creation failed: ${reason}`,
    totalDurationMs: Date.now() - startTime,
    totalTokensUsed: 0,
    phasesCompleted: [],
  };
}

function makeCancelledResult(goal: string, arch: ArchitectureSpec, startTime: number): FullAppResult {
  return {
    success: false,
    appName: arch.name,
    architecture: arch,
    filesCreated: [],
    summary: 'Operation cancelled by user.',
    totalDurationMs: Date.now() - startTime,
    totalTokensUsed: 0,
    phasesCompleted: [],
  };
}
