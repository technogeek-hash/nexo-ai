import * as vscode from 'vscode';
import { AgentViewProvider } from './webview/viewProvider';
import { initSecrets, ensureApiKey, storeApiKey, deleteApiKey, getConfig, getApiKey, getOpenRouterApiKey, storeOpenRouterApiKey, deleteOpenRouterApiKey, ModelProvider } from './config';
import { getOutputChannel, logInfo, logError } from './logger';
import { undoLastTask, canUndo } from './supervisor/state';
import { onUsageUpdate, resetSessionUsage, SessionUsage } from './client/nvidiaClient';
import { initAudit, flushAudit, auditUndo } from './audit';
import { connectMCPServers, disconnectMCPServers, getMCPStatus } from './mcp';
import { initRAGIndex, clearRAGIndex, getRAGStats } from './rag';

/* ────────────────────────────────────────────────────────
   Extension activation & registration
   ──────────────────────────────────────────────────────── */

let _tokenStatusBar: vscode.StatusBarItem;
let _styleStatusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  logInfo('NexoAgent activating…');

  // ── Initialise secure secret storage ──
  initSecrets(context.secrets);

  // ── Preload API keys (populates cache for synchronous getConfig) ──
  getApiKey().catch(() => {});
  getOpenRouterApiKey().catch(() => {});

  // ── Initialise audit logging ──
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) { initAudit(wsRoot); }

  // ── Initialise MCP servers (background, non-blocking) ──
  const cfg = getConfig();
  if (wsRoot && cfg.enableMCP) {
    connectMCPServers(wsRoot).then(() => {
      const status = getMCPStatus();
      if (status.length > 0) { logInfo(`Connected to ${status.length} MCP server(s)`); }
    }).catch((err: unknown) => logError('MCP server initialization failed', err));
  }

  // ── Initialise RAG index (background, non-blocking) ──
  if (wsRoot && cfg.enableRAG) {
    try {
      initRAGIndex(wsRoot);
    } catch (err) {
      logError('RAG index initialization failed', err);
    }
  }

  // ── Sidebar webview provider ──
  const viewProvider = new AgentViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ═══════════════════════════════════════════════════
  //  COMMANDS
  // ═══════════════════════════════════════════════════

  // Main agent command (Ctrl+Shift+I / Cmd+Shift+I)
  registerCmd(context, 'nexoAgent.runAgent', async () => {
    const goal = await vscode.window.showInputBox({
      title: 'NexoAgent',
      prompt: 'What would you like me to do?',
      placeHolder: 'e.g., Add input validation to the login form…',
      ignoreFocusOut: true,
    });
    if (goal) { await viewProvider.sendPrompt(goal); }
  });

  // Set / update API key
  registerCmd(context, 'nexoAgent.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Set NVIDIA API Key',
      prompt: 'Enter your NVIDIA API key (nvapi-…). It will be stored securely.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'nvapi-xxxx',
      validateInput(value) {
        if (!value.trim()) { return 'API key cannot be empty.'; }
        if (!value.startsWith('nvapi-')) { return 'Key should start with "nvapi-".'; }
        return null;
      },
    });
    if (key) {
      await storeApiKey(key);
      vscode.window.showInformationMessage('✓ NVIDIA API key stored securely.');
    }
  });

  // Delete API key
  registerCmd(context, 'nexoAgent.deleteApiKey', async () => {
    await deleteApiKey();
    vscode.window.showInformationMessage('NVIDIA API key removed.');
  });

  // Set / update OpenRouter API key
  registerCmd(context, 'nexoAgent.setOpenRouterApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Set OpenRouter API Key',
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
      vscode.window.showInformationMessage('✓ OpenRouter API key stored securely.');
    }
  });

  // Delete OpenRouter API key
  registerCmd(context, 'nexoAgent.deleteOpenRouterApiKey', async () => {
    await deleteOpenRouterApiKey();
    vscode.window.showInformationMessage('OpenRouter API key removed.');
  });

  // Switch provider (NVIDIA ↔ OpenRouter)
  registerCmd(context, 'nexoAgent.switchProvider', async () => {
    const current = getConfig().provider;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(cloud) NVIDIA', description: 'NVIDIA API (build.nvidia.com)', value: 'nvidia' as ModelProvider, picked: current === 'nvidia' },
        { label: '$(globe) OpenRouter', description: 'OpenRouter (openrouter.ai) — Claude, GPT, Gemini, etc.', value: 'openrouter' as ModelProvider, picked: current === 'openrouter' },
      ],
      { title: 'Select Model Provider', placeHolder: `Currently: ${current}` },
    );
    if (pick) {
      await vscode.workspace.getConfiguration('nexoAgent').update('provider', pick.value, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Switched to ${pick.label.replace(/\$\([^)]+\)\s*/, '')} provider.`);
    }
  });

  // Quick actions on selected code
  registerCmd(context, 'nexoAgent.explainCode', async () => {
    const text = getSelectedText();
    if (!text) { return vscode.window.showWarningMessage('Select some code first.'); }
    await viewProvider.sendPrompt(`Explain this code:\n\n\`\`\`\n${text}\n\`\`\``);
  });

  registerCmd(context, 'nexoAgent.fixCode', async () => {
    const text = getSelectedText();
    if (!text) { return vscode.window.showWarningMessage('Select some code first.'); }
    const file = activeRelativePath();
    await viewProvider.sendPrompt(`Fix any bugs or issues in this code from ${file}:\n\n\`\`\`\n${text}\n\`\`\``);
  });

  registerCmd(context, 'nexoAgent.refactorCode', async () => {
    const text = getSelectedText();
    if (!text) { return vscode.window.showWarningMessage('Select some code first.'); }
    const file = activeRelativePath();
    await viewProvider.sendPrompt(`Refactor this code from ${file} for better readability, performance, and maintainability:\n\n\`\`\`\n${text}\n\`\`\``);
  });

  registerCmd(context, 'nexoAgent.addTests', async () => {
    const text = getSelectedText();
    if (!text) { return vscode.window.showWarningMessage('Select some code first.'); }
    const file = activeRelativePath();
    await viewProvider.sendPrompt(`Write comprehensive unit tests for this code from ${file}:\n\n\`\`\`\n${text}\n\`\`\``);
  });

  registerCmd(context, 'nexoAgent.addDocs', async () => {
    const text = getSelectedText();
    if (!text) { return vscode.window.showWarningMessage('Select some code first.'); }
    const file = activeRelativePath();
    await viewProvider.sendPrompt(`Add comprehensive documentation (JSDoc/docstrings) to this code from ${file}:\n\n\`\`\`\n${text}\n\`\`\``);
  });

  // Fix errors in current file
  registerCmd(context, 'nexoAgent.fixErrors', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return vscode.window.showWarningMessage('Open a file first.'); }

    const uri = editor.document.uri;
    const diagnostics = vscode.languages.getDiagnostics(uri);
    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

    if (errors.length === 0) {
      return vscode.window.showInformationMessage('No errors in the current file!');
    }

    const file = vscode.workspace.asRelativePath(uri);
    const errorList = errors.map(e =>
      `Line ${e.range.start.line + 1}: ${e.message}${e.source ? ` [${e.source}]` : ''}`
    ).join('\n');

    await viewProvider.sendPrompt(`Fix the following errors in ${file}:\n\n${errorList}`);
  });

  // Create full app from a single prompt
  registerCmd(context, 'nexoAgent.createApp', async () => {
    const description = await vscode.window.showInputBox({
      title: 'NexoAI: Create Full App',
      prompt: 'Describe the app you want to create',
      placeHolder: 'e.g., Create a clone of Spotify with playlists, search, and user profiles',
      ignoreFocusOut: true,
    });
    if (!description) { return; }

    // Confirm workspace is ready
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      return vscode.window.showWarningMessage('Please open an empty folder first to scaffold your app.');
    }

    const confirm = await vscode.window.showWarningMessage(
      `This will create a full-stack application in your workspace. Continue?`,
      { modal: true },
      'Create App',
    );
    if (confirm !== 'Create App') { return; }

    await viewProvider.sendPrompt(description);
  });

  // Undo last changes
  registerCmd(context, 'nexoAgent.undo', async () => {
    if (!canUndo()) {
      return vscode.window.showInformationMessage('Nothing to undo.');
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { return; }
    const result = undoLastTask(ws.uri.fsPath);
    if (result.undone) {
      auditUndo(result.taskId ?? 'unknown', result.count);
      vscode.window.showInformationMessage(`↩ Reverted ${result.count} change(s).`);
    }
  });

  // Reset token counter
  registerCmd(context, 'nexoAgent.resetTokens', () => {
    resetSessionUsage();
    vscode.window.showInformationMessage('Token counter reset.');
  });

  // Open settings
  registerCmd(context, 'nexoAgent.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'nexoAgent');
  });

  // Focus chat view
  registerCmd(context, 'nexoAgent.focusChat', () => {
    vscode.commands.executeCommand('nexoAgent.chatView.focus');
  });

  // ═══════════════════════════════════════════════════
  //  STATUS BARS
  // ═══════════════════════════════════════════════════

  // Main agent button
  const mainStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  const providerLabel = cfg.provider === 'openrouter' ? 'OpenRouter' : 'NexoAI';
  mainStatusBar.text = `$(hubot) ${providerLabel}`;
  mainStatusBar.tooltip = `NexoAgent (${cfg.provider}) – Click to switch provider`;
  mainStatusBar.command = 'nexoAgent.switchProvider';
  mainStatusBar.show();
  context.subscriptions.push(mainStatusBar);

  // Update status bar on provider change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('nexoAgent.provider')) {
        const newCfg = getConfig();
        const label = newCfg.provider === 'openrouter' ? 'OpenRouter' : 'NexoAI';
        mainStatusBar.text = `$(hubot) ${label}`;
        mainStatusBar.tooltip = `NexoAgent (${newCfg.provider}) – Click to switch provider`;
      }
    }),
  );

  // Token meter
  _tokenStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _tokenStatusBar.text = '$(dashboard) 0 tokens';
  _tokenStatusBar.tooltip = 'NexoAgent – Token usage this session. Click to reset.';
  _tokenStatusBar.command = 'nexoAgent.resetTokens';
  _tokenStatusBar.show();
  context.subscriptions.push(_tokenStatusBar);

  onUsageUpdate((usage: SessionUsage) => {
    const formatted = formatTokenCount(usage.totalTokens);
    const cost = estimateCost(usage);
    _tokenStatusBar.text = `$(dashboard) ${formatted} tokens`;
    _tokenStatusBar.tooltip = [
      `Session Token Usage`,
      `─────────────────`,
      `Prompt: ${usage.totalPromptTokens.toLocaleString()}`,
      `Completion: ${usage.totalCompletionTokens.toLocaleString()}`,
      `Total: ${usage.totalTokens.toLocaleString()}`,
      `Requests: ${usage.requestCount}`,
      `Est. cost: ~$${cost}`,
      ``,
      `Click to reset.`,
    ].join('\n');
  });

  // Style enforcement indicator
  _styleStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  updateStyleStatusBar();
  _styleStatusBar.command = 'nexoAgent.openSettings';
  _styleStatusBar.show();
  context.subscriptions.push(_styleStatusBar);

  // Update style indicator when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('nexoAgent.styleEnforcement') ||
          e.affectsConfiguration('nexoAgent.candidateCount') ||
          e.affectsConfiguration('nexoAgent.styleThreshold')) {
        updateStyleStatusBar();
      }
    }),
  );

  // ── Code action provider ──
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new AgentCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor],
    }),
  );

  logInfo('NexoAgent activated ✓');
}

export function deactivate() {
  flushAudit();
  try { disconnectMCPServers(); } catch { /* ignore cleanup errors */ }
  logInfo('NexoAgent deactivated');
}

/* ─── Helpers ─── */

function registerCmd(ctx: vscode.ExtensionContext, id: string, handler: (...args: any[]) => any): void {
  ctx.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

function getSelectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) { return undefined; }
  return editor.document.getText(editor.selection);
}

function activeRelativePath(): string {
  const editor = vscode.window.activeTextEditor;
  return editor ? vscode.workspace.asRelativePath(editor.document.uri) : 'unknown file';
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1) + 'M'; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + 'k'; }
  return String(n);
}

/** Rough cost estimate based on typical NVIDIA API pricing. */
function estimateCost(usage: SessionUsage): string {
  // Approximate: $0.30 per 1M input tokens, $0.50 per 1M output tokens
  const inputCost = (usage.totalPromptTokens / 1_000_000) * 0.30;
  const outputCost = (usage.totalCompletionTokens / 1_000_000) * 0.50;
  return (inputCost + outputCost).toFixed(4);
}

/** Update the style enforcement status bar indicator. */
function updateStyleStatusBar(): void {
  const cfg = getConfig();
  if (cfg.styleEnforcement) {
    _styleStatusBar.text = `$(beaker) Style: ON`;
    _styleStatusBar.tooltip = [
      `Claude-Style Quality Pipeline`,
      `───────────────────────────`,
      `Status: Enabled`,
      `Candidates: ${cfg.candidateCount}`,
      `Threshold: ${cfg.styleThreshold}/100`,
      `Code temperature: ${cfg.codeTemperature}`,
      ``,
      `Click to configure.`,
    ].join('\n');
    _styleStatusBar.backgroundColor = undefined;
  } else {
    _styleStatusBar.text = `$(beaker) Style: OFF`;
    _styleStatusBar.tooltip = 'Claude-Style Quality Pipeline: Disabled. Click to configure.';
    _styleStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

/* ─── Code Action Provider ─── */

class AgentCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    _document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    if (context.diagnostics.length > 0) {
      const fix = new vscode.CodeAction('Fix with NexoAgent', vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'nexoAgent.fixErrors', title: 'Fix with NexoAgent' };
      fix.isPreferred = false;
      actions.push(fix);
    }

    if (!range.isEmpty) {
      const explain = new vscode.CodeAction('Explain with AI', vscode.CodeActionKind.Refactor);
      explain.command = { command: 'nexoAgent.explainCode', title: 'Explain with AI' };
      actions.push(explain);

      const refactor = new vscode.CodeAction('Refactor with AI', vscode.CodeActionKind.Refactor);
      refactor.command = { command: 'nexoAgent.refactorCode', title: 'Refactor with AI' };
      actions.push(refactor);
    }

    return actions;
  }
}
