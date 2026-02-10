import { ChildProcess, spawn } from 'child_process';
import { logInfo, logError, logWarn, logDebug } from '../logger';

/* ────────────────────────────────────────────────────────
   MCP Client — Model Context Protocol

   Implements the client side of the MCP specification.
   Connects to MCP servers over stdio, discovers their
   tools/resources/prompts, and proxies calls.

   See: https://modelcontextprotocol.io/specification
   ──────────────────────────────────────────────────────── */

export interface MCPServerConfig {
  /** Unique name for this MCP server. */
  name: string;
  /** Command to launch the server (e.g. "npx", "python"). */
  command: string;
  /** Arguments to pass to the command. */
  args: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
  /** Whether this server is enabled. */
  enabled: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export interface MCPPromptTemplate {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  serverName: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP Client — manages connection to a single MCP server over stdio.
 */
export class MCPClient {
  private _process: ChildProcess | null = null;
  private _config: MCPServerConfig;
  private _requestId = 0;
  private _pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private _buffer = '';
  private _tools: MCPTool[] = [];
  private _resources: MCPResource[] = [];
  private _prompts: MCPPromptTemplate[] = [];
  private _initialized = false;

  constructor(config: MCPServerConfig) {
    this._config = config;
  }

  get name(): string { return this._config.name; }
  get isConnected(): boolean { return this._process !== null && !this._process.killed; }
  get tools(): MCPTool[] { return [...this._tools]; }
  get resources(): MCPResource[] { return [...this._resources]; }
  get prompts(): MCPPromptTemplate[] { return [...this._prompts]; }

  /**
   * Start the MCP server process and perform initialization handshake.
   */
  async connect(): Promise<void> {
    if (this._process) {
      logWarn(`MCP server "${this._config.name}" already connected`);
      return;
    }

    logInfo(`Starting MCP server: ${this._config.name} (${this._config.command} ${this._config.args.join(' ')})`);

    this._process = spawn(this._config.command, this._config.args, {
      cwd: this._config.cwd,
      env: { ...process.env, ...this._config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout (JSON-RPC responses)
    this._process.stdout?.on('data', (data: Buffer) => {
      this._handleData(data.toString());
    });

    // Handle stderr (logs)
    this._process.stderr?.on('data', (data: Buffer) => {
      logDebug(`MCP [${this._config.name}] stderr: ${data.toString().trim()}`);
    });

    // Handle process exit
    this._process.on('exit', (code) => {
      logInfo(`MCP server "${this._config.name}" exited with code ${code}`);
      this._cleanup();
    });

    this._process.on('error', (err) => {
      logError(`MCP server "${this._config.name}" error`, err);
      this._cleanup();
    });

    // Initialize handshake
    try {
      await this._initialize();
      await this._discoverCapabilities();
      this._initialized = true;
      logInfo(`MCP server "${this._config.name}" ready: ${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`);
    } catch (err) {
      logError(`MCP initialization failed for "${this._config.name}"`, err);
      this.disconnect();
      throw err;
    }
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this._initialized) { throw new Error(`MCP server "${this._config.name}" not initialized`); }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    }) as { content: Array<{ type: string; text?: string }> };

    // Extract text content
    if (Array.isArray(result?.content)) {
      return result.content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('\n');
    }

    return JSON.stringify(result);
  }

  /**
   * Read a resource from the MCP server.
   */
  async readResource(uri: string): Promise<string> {
    if (!this._initialized) { throw new Error(`MCP server "${this._config.name}" not initialized`); }

    const result = await this._sendRequest('resources/read', { uri }) as {
      contents: Array<{ text?: string; uri: string }>;
    };

    if (Array.isArray(result?.contents)) {
      return result.contents.map((c: { text?: string }) => c.text ?? '').join('\n');
    }

    return JSON.stringify(result);
  }

  /**
   * Get a prompt template expanded with arguments.
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<string> {
    if (!this._initialized) { throw new Error(`MCP server "${this._config.name}" not initialized`); }

    const result = await this._sendRequest('prompts/get', {
      name,
      arguments: args,
    }) as { messages: Array<{ content: { type: string; text?: string } }> };

    if (Array.isArray(result?.messages)) {
      return result.messages
        .map((m: { content: { text?: string } }) => m.content?.text ?? '')
        .join('\n');
    }

    return JSON.stringify(result);
  }

  /**
   * Gracefully disconnect from the MCP server.
   */
  disconnect(): void {
    if (this._process) {
      try {
        this._process.kill('SIGTERM');
      } catch { /* ignore */ }
      this._cleanup();
    }
    logInfo(`MCP server "${this._config.name}" disconnected`);
  }

  /* ═══════════ Internal ═══════════ */

  private async _initialize(): Promise<void> {
    await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'nexo-agent',
        version: '1.0.0',
      },
    });

    // Send initialized notification (no response expected)
    this._sendNotification('notifications/initialized', {});
  }

  private async _discoverCapabilities(): Promise<void> {
    // Discover tools
    try {
      const toolsResult = await this._sendRequest('tools/list', {}) as {
        tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      };
      this._tools = (toolsResult?.tools ?? []).map(t => ({
        ...t,
        serverName: this._config.name,
      }));
    } catch {
      logDebug(`MCP server "${this._config.name}" does not support tools`);
    }

    // Discover resources
    try {
      const resourcesResult = await this._sendRequest('resources/list', {}) as {
        resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
      };
      this._resources = (resourcesResult?.resources ?? []).map(r => ({
        ...r,
        serverName: this._config.name,
      }));
    } catch {
      logDebug(`MCP server "${this._config.name}" does not support resources`);
    }

    // Discover prompts
    try {
      const promptsResult = await this._sendRequest('prompts/list', {}) as {
        prompts: Array<MCPPromptTemplate>;
      };
      this._prompts = (promptsResult?.prompts ?? []).map(p => ({
        ...p,
        serverName: this._config.name,
      }));
    } catch {
      logDebug(`MCP server "${this._config.name}" does not support prompts`);
    }
  }

  private _sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._process?.stdin?.writable) {
        reject(new Error('MCP server not connected'));
        return;
      }

      const id = ++this._requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after 30s`));
      }, 30_000);

      this._pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + '\n';
      this._process.stdin!.write(payload);
      logDebug(`MCP → [${this._config.name}] ${method} (id=${id})`);
    });
  }

  private _sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this._process?.stdin?.writable) { return; }
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this._process.stdin!.write(payload);
  }

  private _handleData(data: string): void {
    this._buffer += data;

    // Process complete JSON-RPC messages (newline-delimited)
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse;
        if (message.id !== undefined && this._pending.has(message.id)) {
          const pending = this._pending.get(message.id)!;
          this._pending.delete(message.id);
          clearTimeout(pending.timer);

          if (message.error) {
            pending.reject(new Error(`MCP error: ${message.error.message} (code: ${message.error.code})`));
          } else {
            pending.resolve(message.result);
          }
        }
      } catch {
        logDebug(`MCP [${this._config.name}] unparseable: ${trimmed.slice(0, 100)}`);
      }
    }
  }

  private _cleanup(): void {
    // Reject all pending requests
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP server disconnected'));
    }
    this._pending.clear();
    this._process = null;
    this._initialized = false;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
  }
}
