import * as vscode from 'vscode';

/* ────────────────────────────────────────────────────────
   Configuration & Secrets
   API keys are stored via VS Code SecretStorage API —
   never persisted in plain-text settings.
   ──────────────────────────────────────────────────────── */

export type ModelProvider = 'nvidia' | 'openrouter';

export interface AgentConfig {
  /** Active model provider. */
  provider: ModelProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** OpenRouter-specific API key (stored separately in SecretStorage). */
  openRouterApiKey: string;
  /** OpenRouter API base URL. */
  openRouterBaseUrl: string;
  /** Model to use when provider is 'openrouter'. */
  openRouterModel: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  maxIterations: number;
  autoApply: boolean;
  contextLines: number;
  maxFileSize: number;
  commandTimeout: number;
  telemetry: boolean;
  /** Enable Claude-style quality pipeline (Generate → Critic → Rewrite → Verify). */
  styleEnforcement: boolean;
  /** Number of candidates to generate per request (k). */
  candidateCount: number;
  /** Minimum combined style score (0-100) before triggering a rewrite pass. */
  styleThreshold: number;
  /** Temperature override for code generation (0.0–0.15 for deterministic output). */
  codeTemperature: number;
  /** Enable dynamic sub-agent decomposition for complex tasks. */
  enableSubAgents: boolean;
  /** Maximum number of sub-agents to run concurrently. */
  maxSubAgents: number;
  /** Per sub-agent timeout in milliseconds. */
  subAgentTimeout: number;
  /** Minimum complexity score (0-100) before triggering sub-agent pipeline. */
  complexityThreshold: number;
  /** Enable persistent conversation memory. */
  enableMemory: boolean;
  /** Enable RAG (workspace-aware retrieval). */
  enableRAG: boolean;
  /** Think mode: 'off' | 'auto' | 'always'. */
  thinkMode: 'off' | 'auto' | 'always';
  /** Think mode token budget (max reasoning tokens). */
  thinkBudget: number;
  /** Enable MCP (Model Context Protocol) servers. */
  enableMCP: boolean;
}

const DEFAULTS: Omit<AgentConfig, 'apiKey' | 'openRouterApiKey'> = {
  provider: 'nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
  openRouterBaseUrl: 'https://openrouter.ai/api/v1',
  openRouterModel: 'anthropic/claude-sonnet-4',
  temperature: 0.6,
  topP: 0.95,
  maxTokens: 8192,
  maxIterations: 40,
  autoApply: false,
  contextLines: 200,
  maxFileSize: 100_000,
  commandTimeout: 30_000,
  telemetry: false,
  styleEnforcement: true,
  candidateCount: 3,
  styleThreshold: 70,
  codeTemperature: 0.05,
  enableSubAgents: true,
  maxSubAgents: 4,
  subAgentTimeout: 120_000,
  complexityThreshold: 50,
  enableMemory: true,
  enableRAG: true,
  thinkMode: 'auto',
  thinkBudget: 2048,
  enableMCP: true,
};

const SECRET_KEY = 'nexoAgent.apiKey';
const OPENROUTER_SECRET_KEY = 'nexoAgent.openRouterApiKey';

let _secretStorage: vscode.SecretStorage | undefined;
let _cachedApiKey: string | undefined;
let _cachedOpenRouterKey: string | undefined;

/** Must be called once during activation to inject the SecretStorage handle. */
export function initSecrets(secrets: vscode.SecretStorage): void {
  _secretStorage = secrets;

  // Invalidate cached keys when user changes them
  secrets.onDidChange(e => {
    if (e.key === SECRET_KEY) { _cachedApiKey = undefined; }
    if (e.key === OPENROUTER_SECRET_KEY) { _cachedOpenRouterKey = undefined; }
  });
}

/** Retrieve the API key from SecretStorage (cached in memory). */
export async function getApiKey(): Promise<string | undefined> {
  if (_cachedApiKey) { return _cachedApiKey; }

  // 1. Try SecretStorage first
  if (_secretStorage) {
    const stored = await _secretStorage.get(SECRET_KEY);
    if (stored) { _cachedApiKey = stored; return stored; }
  }

  // 2. Fallback: environment variable
  const envKey = process.env.NVIDIA_API_KEY;
  if (envKey) { _cachedApiKey = envKey; return envKey; }

  // 3. Fallback: legacy plain-text setting (will be migrated)
  const legacyKey = vscode.workspace.getConfiguration('nexoAgent').get<string>('apiKey', '');
  if (legacyKey) {
    // Migrate to SecretStorage and remove from settings
    if (_secretStorage) {
      await _secretStorage.store(SECRET_KEY, legacyKey);
      await vscode.workspace.getConfiguration('nexoAgent').update('apiKey', undefined, vscode.ConfigurationTarget.Global);
    }
    _cachedApiKey = legacyKey;
    return legacyKey;
  }

  return undefined;
}

/** Store the API key in SecretStorage. */
export async function storeApiKey(key: string): Promise<void> {
  if (_secretStorage) {
    await _secretStorage.store(SECRET_KEY, key);
  }
  _cachedApiKey = key;
}

/** Delete the stored API key. */
export async function deleteApiKey(): Promise<void> {
  if (_secretStorage) {
    await _secretStorage.delete(SECRET_KEY);
  }
  _cachedApiKey = undefined;
}

/* ─── OpenRouter API Key ─── */

/** Retrieve the OpenRouter API key from SecretStorage (cached). */
export async function getOpenRouterApiKey(): Promise<string | undefined> {
  if (_cachedOpenRouterKey) { return _cachedOpenRouterKey; }
  if (_secretStorage) {
    const stored = await _secretStorage.get(OPENROUTER_SECRET_KEY);
    if (stored) { _cachedOpenRouterKey = stored; return stored; }
  }
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) { _cachedOpenRouterKey = envKey; return envKey; }
  return undefined;
}

/** Store the OpenRouter API key in SecretStorage. */
export async function storeOpenRouterApiKey(key: string): Promise<void> {
  if (_secretStorage) {
    await _secretStorage.store(OPENROUTER_SECRET_KEY, key);
  }
  _cachedOpenRouterKey = key;
}

/** Delete the stored OpenRouter API key. */
export async function deleteOpenRouterApiKey(): Promise<void> {
  if (_secretStorage) {
    await _secretStorage.delete(OPENROUTER_SECRET_KEY);
  }
  _cachedOpenRouterKey = undefined;
}

/** Get the full config. apiKey comes from SecretStorage (pass separately). */
export function getConfig(apiKeyOverride?: string): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('nexoAgent');
  return {
    provider: cfg.get<ModelProvider>('provider', DEFAULTS.provider),
    apiKey: apiKeyOverride ?? _cachedApiKey ?? '',
    baseUrl: cfg.get<string>('baseUrl', DEFAULTS.baseUrl),
    model: cfg.get<string>('model', DEFAULTS.model),
    openRouterApiKey: _cachedOpenRouterKey ?? '',
    openRouterBaseUrl: cfg.get<string>('openRouterBaseUrl', DEFAULTS.openRouterBaseUrl),
    openRouterModel: cfg.get<string>('openRouterModel', DEFAULTS.openRouterModel),
    temperature: cfg.get<number>('temperature', DEFAULTS.temperature),
    topP: cfg.get<number>('topP', DEFAULTS.topP),
    maxTokens: cfg.get<number>('maxTokens', DEFAULTS.maxTokens),
    maxIterations: cfg.get<number>('maxIterations', DEFAULTS.maxIterations),
    autoApply: cfg.get<boolean>('autoApply', DEFAULTS.autoApply),
    contextLines: cfg.get<number>('contextLines', DEFAULTS.contextLines),
    maxFileSize: cfg.get<number>('maxFileSize', DEFAULTS.maxFileSize),
    commandTimeout: cfg.get<number>('commandTimeout', DEFAULTS.commandTimeout),
    telemetry: cfg.get<boolean>('telemetry', DEFAULTS.telemetry),
    styleEnforcement: cfg.get<boolean>('styleEnforcement', DEFAULTS.styleEnforcement),
    candidateCount: cfg.get<number>('candidateCount', DEFAULTS.candidateCount),
    styleThreshold: cfg.get<number>('styleThreshold', DEFAULTS.styleThreshold),
    codeTemperature: cfg.get<number>('codeTemperature', DEFAULTS.codeTemperature),
    enableSubAgents: cfg.get<boolean>('enableSubAgents', DEFAULTS.enableSubAgents),
    maxSubAgents: cfg.get<number>('maxSubAgents', DEFAULTS.maxSubAgents),
    subAgentTimeout: cfg.get<number>('subAgentTimeout', DEFAULTS.subAgentTimeout),
    complexityThreshold: cfg.get<number>('complexityThreshold', DEFAULTS.complexityThreshold),
    enableMemory: cfg.get<boolean>('enableMemory', DEFAULTS.enableMemory),
    enableRAG: cfg.get<boolean>('enableRAG', DEFAULTS.enableRAG),
    thinkMode: cfg.get<'off' | 'auto' | 'always'>('thinkMode', DEFAULTS.thinkMode),
    thinkBudget: cfg.get<number>('thinkBudget', DEFAULTS.thinkBudget),
    enableMCP: cfg.get<boolean>('enableMCP', DEFAULTS.enableMCP),
  };
}

/**
 * Prompt the user for an API key if one is not configured.
 * Returns the key or undefined if the user cancelled.
 * Behaviour depends on the active provider.
 */
export async function ensureApiKey(): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration('nexoAgent');
  const provider = cfg.get<ModelProvider>('provider', 'nvidia');

  if (provider === 'openrouter') {
    return ensureOpenRouterApiKey();
  }

  const existing = await getApiKey();
  if (existing) { return existing; }

  const key = await vscode.window.showInputBox({
    title: 'NVIDIA API Key Required',
    prompt: 'Enter your NVIDIA API key (nvapi-…). It will be stored securely.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'nvapi-xxxx',
    validateInput(value) {
      if (!value.trim()) { return 'API key cannot be empty.'; }
      if (!value.startsWith('nvapi-')) { return 'Key should start with "nvapi-". Check your key at build.nvidia.com.'; }
      return null;
    },
  });

  if (key) {
    await storeApiKey(key);
    vscode.window.showInformationMessage('NVIDIA API key stored securely.');
  }
  return key;
}

/**
 * Prompt the user for an OpenRouter API key if one is not configured.
 */
export async function ensureOpenRouterApiKey(): Promise<string | undefined> {
  const existing = await getOpenRouterApiKey();
  if (existing) { return existing; }

  const key = await vscode.window.showInputBox({
    title: 'OpenRouter API Key Required',
    prompt: 'Enter your OpenRouter API key (sk-or-…). It will be stored securely.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-or-xxxx',
    validateInput(value) {
      if (!value.trim()) { return 'API key cannot be empty.'; }
      return null;
    },
  });

  if (key) {
    await storeOpenRouterApiKey(key);
    vscode.window.showInformationMessage('OpenRouter API key stored securely.');
  }
  return key;
}
