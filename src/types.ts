import * as vscode from 'vscode';

/* ─────────────── Chat / Message types ─────────────── */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string;
  name?: string;
}

/* ─────────────── Tool types ─────────────── */

export interface ToolCallParsed {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  durationMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameterDef>;
  required: string[];
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolParameterDef {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolContext {
  workspaceRoot: string;
  outputChannel: vscode.OutputChannel;
  token?: vscode.CancellationToken;
  onProgress?: (msg: string) => void;
}

/* ─────────────── Agent / Supervisor types ─────────────── */

export type AgentRole = 'planner' | 'coder' | 'reviewer';

export interface Plan {
  goal: string;
  steps: PlanStep[];
  relevantFiles: string[];
}

export interface PlanStep {
  id: number;
  description: string;
  type: 'read' | 'write' | 'edit' | 'run' | 'search' | 'analyze';
  files?: string[];
  status: 'pending' | 'in-progress' | 'done' | 'failed';
}

export interface FileEdit {
  filePath: string;
  type: 'create' | 'edit' | 'delete';
  content?: string;       // for create / full rewrite
  oldText?: string;       // for edit
  newText?: string;       // for edit
  originalContent?: string; // backup for undo
}

export interface ReviewResult {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'suggestion';
  file: string;
  description: string;
}

export interface AgentState {
  id: string;
  goal: string;
  plan?: Plan;
  edits: FileEdit[];
  messages: ChatMessage[];
  iteration: number;
  maxIterations: number;
  status: 'planning' | 'coding' | 'reviewing' | 'debugging' | 'done' | 'error';
  error?: string;
  review?: ReviewResult;
}

/* ─────────────── Stream event types (extension ↔ webview) ─────────────── */

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'done' | 'status' | 'edit' | 'clear' | 'thinkModeChanged' | 'attachmentsUpdated' | 'startAssistant' | 'endAssistant' | 'addUserMessage';
  content: string;
  data?: unknown;
}

/* ─────────────── Conversation persistence ─────────────── */

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  messages: ConversationEntry[];
}

export interface ConversationEntry {
  id: string;
  timestamp: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCallParsed[];
  toolResults?: ToolResult[];
  edits?: FileEdit[];
}

/* ─────────────── Quality Pipeline (Claude-style) types ─────────────── */

/** A single candidate produced by multi-candidate generation. */
export interface CandidateResult {
  /** Raw text output from the model. */
  text: string;
  /** Index within the candidate batch (0-based). */
  index: number;
  /** Combined programmatic + learned style score (0-100). */
  score: number;
  /** Breakdown of the scoring. */
  scoring?: StyleScore;
}

/** Detailed score breakdown for a candidate. */
export interface StyleScore {
  /** Programmatic checks score (0-100). */
  programmaticScore: number;
  /** Learned critic score (0-100). */
  learnedScore: number;
  /** Weighted final score: 0.6 * programmatic + 0.4 * learned. */
  combinedScore: number;
  /** Individual check results. */
  checks: ProgrammaticCheckResult;
  /** Critic reason / notes. */
  criticNotes?: string;
}

/** Results of automated programmatic checks on a candidate. */
export interface ProgrammaticCheckResult {
  /** Whether the candidate has the required 4-part structure. */
  hasStructure: boolean;
  /** Whether a one-line summary is present. */
  hasSummary: boolean;
  /** Whether a code block is present. */
  hasCodeBlock: boolean;
  /** Whether tests are present. */
  hasTests: boolean;
  /** Whether notes are present. */
  hasNotes: boolean;
  /** Number of banned patterns found (eval, hard-coded secrets, etc.). */
  bannedPatternCount: number;
  /** Whether chain-of-thought leakage was detected. */
  hasChainOfThought: boolean;
  /** Estimated max function length in lines. */
  maxFunctionLength: number;
  /** Whether the candidate contains multiple code blocks (anti-pattern). */
  multipleCodeBlocks: boolean;
}

/** Final result from the quality pipeline. */
export interface QualityPipelineResult {
  /** The best candidate after reranking (and optional rewrite). */
  finalText: string;
  /** Score of the final output (0-100). */
  finalScore: number;
  /** Number of candidates generated. */
  candidateCount: number;
  /** Whether a rewrite pass was applied. */
  wasRewritten: boolean;
  /** All candidate scores for diagnostics. */
  allScores: number[];
  /** Duration of the full pipeline in ms. */
  durationMs: number;
}

/* ─────────────── Sub-Agent System (Enterprise) ─────────────── */

/** Specialized domain that a sub-agent can handle. */
export type SubAgentDomain =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'security'
  | 'testing'
  | 'documentation'
  | 'performance'
  | 'api-design'
  | 'migration'
  | 'database'
  | 'devops'
  | 'architect'
  | 'frontend'
  | 'backend'
  | 'custom';

/* ─────────────── Full-App Creation Pipeline ─────────────── */

/** Preferred technology stack for full-app creation. */
export interface TechStack {
  frontend: 'react' | 'next' | 'vue' | 'svelte' | 'angular' | 'vanilla';
  styling: 'tailwind' | 'css-modules' | 'styled-components' | 'scss';
  backend: 'express' | 'fastify' | 'nest' | 'fastapi' | 'django' | 'none';
  database: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite' | 'supabase' | 'none';
  orm: 'prisma' | 'drizzle' | 'typeorm' | 'mongoose' | 'none';
  auth: 'nextauth' | 'clerk' | 'firebase' | 'jwt-custom' | 'none';
  deployment: 'vercel' | 'docker' | 'aws' | 'railway' | 'none';
}

/** Architecture specification produced by the architect agent. */
export interface ArchitectureSpec {
  /** App name / project name. */
  name: string;
  /** One-paragraph description. */
  description: string;
  /** PRD: user stories / features. */
  features: string[];
  /** Technology stack decisions. */
  techStack: TechStack;
  /** Directory structure as a flat list of paths. */
  directoryStructure: string[];
  /** API routes / endpoints specification. */
  apiContracts: ApiContract[];
  /** Database schema / models. */
  dataModels: DataModel[];
  /** Component hierarchy for frontend. */
  componentTree: ComponentSpec[];
  /** Environment variables needed. */
  envVars: string[];
  /** Third-party integrations. */
  integrations: string[];
}

/** A single API endpoint contract. */
export interface ApiContract {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  requestBody?: string;
  responseBody?: string;
  auth: boolean;
}

/** A database model/table. */
export interface DataModel {
  name: string;
  fields: Array<{ name: string; type: string; constraints?: string }>;
  relations?: string[];
}

/** A frontend component specification. */
export interface ComponentSpec {
  name: string;
  path: string;
  description: string;
  props?: string[];
  children?: string[];
}

/** Result from the full-app creation pipeline. */
export interface FullAppResult {
  success: boolean;
  appName: string;
  architecture: ArchitectureSpec;
  filesCreated: string[];
  summary: string;
  totalDurationMs: number;
  totalTokensUsed: number;
  phasesCompleted: string[];
}

/** Specification for a sub-agent that can be dynamically spawned. */
export interface SubAgentSpec {
  /** Unique identifier for this agent type. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Domain expertise of this agent. */
  domain: SubAgentDomain;
  /** System instructions injected into the agent's prompt. */
  instructions: string;
  /** Subset of tool names this agent is allowed to use (empty = all). */
  allowedTools?: string[];
  /** Max ReAct iterations for this agent. */
  maxIterations: number;
  /** Whether this agent requires workspace tool access. */
  requiresWorkspaceAccess: boolean;
  /** Priority weight for scheduling (higher = sooner). */
  priority: number;
  /** Estimated token budget for this agent's task. */
  tokenBudget?: number;
}

/** Status of an individual sub-task. */
export type SubTaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

/** A single unit of work within a decomposed task graph. */
export interface SubTask {
  /** Unique ID for this sub-task. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Detailed description of what the sub-agent should accomplish. */
  description: string;
  /** Which domain agent should handle this sub-task. */
  domain: SubAgentDomain;
  /** IDs of sub-tasks that must complete before this one starts. */
  dependencies: string[];
  /** Current execution status. */
  status: SubTaskStatus;
  /** Files that are relevant to this sub-task. */
  relevantFiles?: string[];
  /** Priority override (higher = sooner within the same dependency tier). */
  priority?: number;
  /** Estimated complexity: 1 = trivial, 5 = very complex. */
  complexity?: number;
}

/** Directed acyclic graph of sub-tasks with execution metadata. */
export interface TaskGraph {
  /** The original high-level goal. */
  goal: string;
  /** All sub-tasks in the graph. */
  tasks: SubTask[];
  /** Adjacency list: taskId → list of dependant taskIds. */
  edges: Record<string, string[]>;
  /** Timestamp when decomposition was performed. */
  createdAt: number;
  /** Overall estimated complexity (sum of sub-task complexities). */
  totalComplexity: number;
}

/** Result produced by a single sub-agent execution. */
export interface SubAgentResult {
  /** ID of the sub-task this result corresponds to. */
  taskId: string;
  /** Domain of the agent that produced this result. */
  domain: SubAgentDomain;
  /** Whether the sub-agent completed successfully. */
  success: boolean;
  /** The agent's final text response. */
  response: string;
  /** Files that were modified by this agent. */
  filesModified: string[];
  /** Tool calls made during execution. */
  toolCallCount: number;
  /** Number of ReAct iterations used. */
  iterations: number;
  /** Wall-clock time in milliseconds. */
  durationMs: number;
  /** Estimated tokens consumed. */
  tokensUsed: number;
  /** Error message if the sub-agent failed. */
  error?: string;
}

/** Aggregated result from the full sub-agent execution pipeline. */
export interface SubAgentPipelineResult {
  /** Whether all critical sub-tasks completed successfully. */
  success: boolean;
  /** Overall summary of what was accomplished. */
  summary: string;
  /** Results from each individual sub-agent. */
  results: SubAgentResult[];
  /** The original task graph. */
  taskGraph: TaskGraph;
  /** Total wall-clock time for the entire pipeline. */
  totalDurationMs: number;
  /** Total tokens consumed across all sub-agents. */
  totalTokensUsed: number;
  /** Number of sub-agents that were spawned. */
  agentsSpawned: number;
  /** Number of sub-tasks executed in parallel at peak. */
  peakParallelism: number;
}
