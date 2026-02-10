import { ChatMessage } from '../types';
import { AgentConfig, getConfig } from '../config';
import { logDebug, logError, logInfo, logWarn } from '../logger';

/* ────────────────────────────────────────────────────────────────
   NVIDIA / OpenAI-compatible streaming chat client.
   - Uses raw fetch (Node 18+) — zero extra dependencies.
   - Retries with exponential backoff on 429/5xx.
   - Tracks token usage per request and cumulatively.
   - Emits clear, actionable errors (401, 429, etc.).
   ──────────────────────────────────────────────────────────────── */

/* ─── Token Usage Tracking ─── */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SessionUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  requestCount: number;
}

const _session: SessionUsage = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  requestCount: 0,
};

let _usageListener: ((usage: SessionUsage) => void) | undefined;

/** Register a listener for usage updates (e.g. status bar). */
export function onUsageUpdate(listener: (usage: SessionUsage) => void): void {
  _usageListener = listener;
}

/** Get current session usage. */
export function getSessionUsage(): SessionUsage {
  return { ..._session };
}

/** Reset session counters. */
export function resetSessionUsage(): void {
  _session.totalPromptTokens = 0;
  _session.totalCompletionTokens = 0;
  _session.totalTokens = 0;
  _session.requestCount = 0;
  _usageListener?.(_session);
}

function recordUsage(usage: TokenUsage): void {
  _session.totalPromptTokens += usage.promptTokens;
  _session.totalCompletionTokens += usage.completionTokens;
  _session.totalTokens += usage.totalTokens;
  _session.requestCount++;
  _usageListener?.({ ..._session });
  logDebug(`Tokens: +${usage.totalTokens} (session total: ${_session.totalTokens})`);
}

/* ─── Callbacks & options ─── */

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  /** Think mode — enables extended reasoning/chain-of-thought before responding. */
  thinkMode?: ThinkModeConfig;
}

/** Configuration for extended thinking / reasoning mode. */
export interface ThinkModeConfig {
  /** Whether to enable think mode for this request. */
  enabled: boolean;
  /** Maximum tokens to budget for thinking (reasoning tokens). Default: 2048. */
  thinkBudget?: number;
  /** Whether to stream the thinking tokens to the UI. Default: false. */
  streamThinking?: boolean;
}

/* ─── API Error classes ─── */

export class NvidiaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly isRetryable: boolean,
  ) {
    super(message);
    this.name = 'NvidiaApiError';
  }
}

/**
 * Send a **non-streaming** chat completion and return the full text.
 */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const cfg = getConfig();
  const rp = resolveProvider(cfg);
  const body = buildBody(opts, cfg, rp, /* stream */ false);
  const res = await fetchWithRetry(rp, body);
  const json = await res.json() as any;

  if (json.error) {
    throw new NvidiaApiError(
      json.error.message ?? JSON.stringify(json.error),
      json.error.code ?? 500,
      false,
    );
  }

  // Track token usage
  if (json.usage) {
    recordUsage({
      promptTokens: json.usage.prompt_tokens ?? 0,
      completionTokens: json.usage.completion_tokens ?? 0,
      totalTokens: json.usage.total_tokens ?? 0,
    });
  }

  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Send a **streaming** chat completion. Tokens are delivered via `onToken`.
 * Returns the accumulated full text once the stream finishes.
 */
export async function chatCompletionStream(
  opts: ChatOptions,
  callbacks: StreamCallbacks,
): Promise<string> {
  const cfg = getConfig();
  const rp = resolveProvider(cfg);
  const body = buildBody(opts, cfg, rp, /* stream */ true);

  let res: Response;
  try {
    res = await fetchWithRetry(rp, body, opts.signal);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    callbacks.onError(e);
    throw e;
  }

  if (!res.body) {
    const err = new Error(`${rp.provider === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} API returned no body`);
    callbacks.onError(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let tokenCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) { continue; }
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          // Record estimated tokens for streaming (no exact usage in stream)
          recordUsage({
            promptTokens: estimateTokens(opts.messages.map(m => m.content).join(' ')),
            completionTokens: tokenCount,
            totalTokens: estimateTokens(opts.messages.map(m => m.content).join(' ')) + tokenCount,
          });
          callbacks.onDone();
          return accumulated;
        }
        try {
          const json = JSON.parse(payload);

          // Check for inline usage (some providers include it)
          if (json.usage) {
            recordUsage({
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
              totalTokens: json.usage.total_tokens ?? 0,
            });
          }

          const token: string | null | undefined = json.choices?.[0]?.delta?.content;
          if (token) {
            accumulated += token;
            tokenCount++;
            callbacks.onToken(token);
          }
        } catch {
          // skip malformed JSON chunks
        }
      }
    }
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      logInfo('Stream aborted by user');
    } else {
      const e = err instanceof Error ? err : new Error(String(err));
      callbacks.onError(e);
      throw e;
    }
  }

  callbacks.onDone();
  return accumulated;
}

/* ───────────────────── internal helpers ───────────────────── */
/** Resolved provider configuration — determines which API endpoint to call. */
interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: 'nvidia' | 'openrouter';
}

/** Resolve the active provider's base URL, API key, and model from config. */
function resolveProvider(cfg: AgentConfig): ResolvedProvider {
  if (cfg.provider === 'openrouter') {
    return {
      baseUrl: cfg.openRouterBaseUrl || 'https://openrouter.ai/api/v1',
      apiKey: cfg.openRouterApiKey,
      model: cfg.openRouterModel || 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
    };
  }
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    provider: 'nvidia',
  };
}
function buildBody(opts: ChatOptions, cfg: AgentConfig, rp: ResolvedProvider, stream: boolean): Record<string, unknown> {
  const thinkMode = opts.thinkMode;

  // When think mode is enabled, prepend a system instruction for extended reasoning
  let messages = opts.messages.map(m => ({
    role: m.role === 'tool_result' ? 'user' : m.role,
    content: m.content,
  }));

  if (thinkMode?.enabled) {
    const budget = thinkMode.thinkBudget ?? 2048;
    const thinkInstruction: { role: 'system'; content: string } = {
      role: 'system' as const,
      content: `## Extended Thinking Mode\nBefore producing your final answer, reason step-by-step inside a <think>…</think> block. Use up to ${budget} tokens for reasoning. The user will see only your final answer (outside the think block). Inside <think>, explore edge cases, verify assumptions, and plan your approach. After </think>, produce your final, concise answer.`,
    };
    // Insert think instruction after the first system message (or at the start)
    const firstSysIdx = messages.findIndex(m => m.role === 'system');
    if (firstSysIdx >= 0) {
      messages.splice(firstSysIdx + 1, 0, thinkInstruction);
    } else {
      messages.unshift(thinkInstruction);
    }
  }

  return {
    model: opts.model ?? rp.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    top_p: opts.topP ?? cfg.topP,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(opts.stop ? { stop: opts.stop } : {}),
  };
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 8000];

async function fetchWithRetry(rp: ResolvedProvider, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const url = `${rp.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const providerLabel = rp.provider === 'openrouter' ? 'OpenRouter' : 'NVIDIA';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${rp.apiKey}`,
  };

  // OpenRouter-specific headers
  if (rp.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/nexo-ai/nexo-agent';
    headers['X-Title'] = 'NexoAgent';
  }

  if (!rp.apiKey) {
    throw new NvidiaApiError(
      `${providerLabel} API key is not set. Use the command "NexoAI: Set ${providerLabel} API Key" or set the ${rp.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY'} environment variable.`,
      401,
      false,
    );
  }

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      logDebug(`${providerLabel} API request attempt ${attempt + 1}`, { model: body.model, stream: body.stream });
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      // ── Non-retryable client errors with clear messages ──
      if (res.status === 401) {
        throw new NvidiaApiError(
          `Invalid or expired ${providerLabel} API key. Please update your key via "NexoAI: Set ${providerLabel} API Key" command.`,
          401,
          false,
        );
      }

      if (res.status === 403) {
        throw new NvidiaApiError(
          `Access denied. Your ${providerLabel} API key does not have permission to use this model. Check your account at ${rp.provider === 'openrouter' ? 'openrouter.ai' : 'build.nvidia.com'}.`,
          403,
          false,
        );
      }

      if (res.status === 404) {
        throw new NvidiaApiError(
          `Model "${body.model}" not found on ${providerLabel}. Check the model name in settings.`,
          404,
          false,
        );
      }

      if (res.status === 422) {
        const errBody = await res.text();
        throw new NvidiaApiError(
          `Invalid request to ${providerLabel}: ${errBody}. Check your model parameters (temperature, max_tokens, etc.).`,
          422,
          false,
        );
      }

      // ── Retryable errors ──
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (RETRY_DELAYS[attempt] ?? 8000);
        logWarn(`Rate limited (429). Retrying in ${waitMs}ms…`);
        lastErr = new NvidiaApiError(
          `Rate limited by ${providerLabel} API. Waiting and retrying…`,
          429,
          true,
        );
        if (attempt < MAX_RETRIES) { await sleep(waitMs); continue; }
        throw new NvidiaApiError(
          `Rate limit exceeded on ${providerLabel}. Please wait a moment and try again.`,
          429,
          false,
        );
      }

      if (res.status >= 500) {
        const errBody = await res.text();
        logWarn(`Server error ${res.status}. Retrying in ${RETRY_DELAYS[attempt] ?? 8000}ms…`);
        lastErr = new NvidiaApiError(`${providerLabel} API server error ${res.status}: ${errBody}`, res.status, true);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAYS[attempt] ?? 8000); continue; }
        throw lastErr;
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new NvidiaApiError(`${providerLabel} API ${res.status}: ${errBody}`, res.status, false);
      }

      return res;
    } catch (err: unknown) {
      if (signal?.aborted) { throw err; }
      if (err instanceof NvidiaApiError && !err.isRetryable) { throw err; }
      lastErr = err instanceof Error ? err : new Error(String(err));
      logError(`${providerLabel} API attempt ${attempt + 1} failed`, lastErr);

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAYS[attempt] ?? 8000);
      }
    }
  }

  throw lastErr ?? new Error(`${providerLabel} API request failed after retries`);
}

/** Rough token estimation (~4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
