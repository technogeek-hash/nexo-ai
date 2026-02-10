import * as vscode from 'vscode';
import * as path from 'path';
import { StreamEvent, ChatMessage } from '../types';
import { runSupervisor } from '../supervisor';
import { ensureApiKey, getConfig } from '../config';
import { logError, logInfo } from '../logger';
import { undoLastTask, canUndo } from '../supervisor/state';
import { MemoryStore } from '../memory/store';
import { summarizeAndCompact } from '../memory/summarizer';
import { Attachment, attachFile, attachImage, attachGitDiff, attachGitLog, attachSelection, attachDiagnostics, pickFilesToAttach } from '../context/attachments';

/**
 * Webview sidebar panel providing the chat interface.
 */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nexoAgent.chatView';

  private _view?: vscode.WebviewView;
  private _abortController?: AbortController;
  private _conversationHistory: ChatMessage[] = [];
  private _memoryStore?: MemoryStore;
  private _pendingAttachments: Attachment[] = [];
  private _thinkModeActive = false;

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Initialize memory store if workspace is available
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      const cfg = getConfig();
      if (cfg.enableMemory) {
        this._memoryStore = new MemoryStore(wsRoot);
        logInfo('Persistent memory store initialized');
      }
      this._thinkModeActive = cfg.thinkMode === 'always';
    }
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    view.webview.html = this._getHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendMessage':
          await this._handleUserMessage(msg.text);
          break;
        case 'cancel':
          this._abortController?.abort();
          break;
        case 'newChat':
          this._conversationHistory = [];
          this._pendingAttachments = [];
          this._memoryStore?.newConversation();
          this._postMessage({ type: 'clear', content: '' });
          break;
        case 'undo':
          this._handleUndo();
          break;
        case 'toggleThinkMode':
          this._thinkModeActive = !this._thinkModeActive;
          this._postMessage({ type: 'thinkModeChanged', content: this._thinkModeActive ? 'on' : 'off' });
          break;
        case 'attachFiles':
          await this._handleAttachFiles();
          break;
        case 'attachImage':
          await this._handleAttachImage();
          break;
        case 'attachGitDiff':
          await this._handleAttachGitDiff();
          break;
        case 'attachSelection':
          this._handleAttachSelection();
          break;
        case 'removeAttachment':
          this._pendingAttachments = this._pendingAttachments.filter((_, i) => i !== msg.index);
          this._postMessage({ type: 'attachmentsUpdated', content: JSON.stringify(this._pendingAttachments.map(a => ({ name: a.name, type: a.type }))) });
          break;
        case 'ready':
          // Send initial think mode state
          this._postMessage({ type: 'thinkModeChanged', content: this._thinkModeActive ? 'on' : 'off' });
          break;
      }
    });
  }

  /** Send a message from outside the webview (e.g., from a command). */
  public async sendPrompt(text: string): Promise<void> {
    if (!this._view) {
      // Reveal the sidebar first
      await vscode.commands.executeCommand('nexoAgent.chatView.focus');
      // Wait for view to initialize
      await new Promise(r => setTimeout(r, 500));
    }
    this._postMessage({ type: 'addUserMessage', content: text });
    await this._handleUserMessage(text);
  }

  /* ───────────── Message handling ───────────── */

  private async _handleUserMessage(text: string): Promise<void> {
    if (!text.trim()) { return; }

    // Ensure API key
    const apiKey = await ensureApiKey();
    if (!apiKey) {
      this._postMessage({ type: 'error', content: 'NVIDIA API key is required. Set it in Settings → NVIDIA AI Agent → API Key.' });
      return;
    }

    const cfg = getConfig();
    this._postMessage({ type: 'status', content: 'Thinking…' });
    this._postMessage({ type: 'startAssistant', content: '' });

    // Add to history
    this._conversationHistory.push({ role: 'user', content: text });

    // Save to persistent memory
    if (this._memoryStore && cfg.enableMemory) {
      this._memoryStore.addMessage('user', text);
    }

    // Determine think mode for this request
    const useThinkMode = cfg.thinkMode === 'always' ||
      (cfg.thinkMode === 'auto' && this._thinkModeActive);

    // Grab pending attachments and clear them
    const attachments = [...this._pendingAttachments];
    this._pendingAttachments = [];
    this._postMessage({ type: 'attachmentsUpdated', content: '[]' });

    this._abortController = new AbortController();

    try {
      const result = await runSupervisor({
        goal: text,
        signal: this._abortController.signal,
        priorMessages: this._conversationHistory.slice(-20),
        memoryStore: this._memoryStore,
        attachments,
        thinkMode: useThinkMode,
        onEvent: (event) => this._handleStreamEvent(event),
      });

      // Add assistant response to history
      this._conversationHistory.push({ role: 'assistant', content: result.response });

      // Save to persistent memory
      if (this._memoryStore && cfg.enableMemory) {
        this._memoryStore.addMessage('assistant', result.response);
        this._memoryStore.flush();

        // Trigger background compaction if needed
        const entries = this._memoryStore.getEntriesForCompaction();
        if (entries.length > 0) {
          summarizeAndCompact(this._memoryStore, this._abortController?.signal).catch(err =>
            logError('Background compaction failed', err),
          );
        }
      }

    } catch (err) {
      if (this._abortController.signal.aborted) {
        this._postMessage({ type: 'status', content: 'Cancelled.' });
      } else {
        logError('User message handling failed', err);
        this._postMessage({
          type: 'error',
          content: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this._postMessage({ type: 'endAssistant', content: '' });
      this._abortController = undefined;
    }
  }

  private _handleStreamEvent(event: StreamEvent): void {
    this._postMessage(event);
  }

  private _handleUndo(): void {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return; }

    if (!canUndo()) {
      this._postMessage({ type: 'status', content: 'Nothing to undo.' });
      return;
    }

    const result = undoLastTask(wsFolder.uri.fsPath);
    if (result.undone) {
      this._postMessage({
        type: 'status',
        content: `↩ Reverted ${result.count} change(s) from task ${result.taskId}.`,
      });
    }
  }

  private _postMessage(msg: StreamEvent | { type: string; content: string }): void {
    this._view?.webview.postMessage(msg);
  }

  /* ───────────── Attachment handlers ───────────── */

  private async _handleAttachFiles(): Promise<void> {
    try {
      const files = await pickFilesToAttach();
      for (const attachment of files) {
        this._pendingAttachments.push(attachment);
      }
      this._postMessage({
        type: 'attachmentsUpdated',
        content: JSON.stringify(this._pendingAttachments.map(a => ({ name: a.name, type: a.type }))),
      });
    } catch (err) {
      logError('Attach files failed', err);
    }
  }

  private async _handleAttachImage(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
        title: 'Attach Image(s)',
      });
      if (!uris) { return; }
      for (const uri of uris) {
        const attachment = await attachImage(uri.fsPath);
        if (attachment) { this._pendingAttachments.push(attachment); }
      }
      this._postMessage({
        type: 'attachmentsUpdated',
        content: JSON.stringify(this._pendingAttachments.map(a => ({ name: a.name, type: a.type }))),
      });
    } catch (err) {
      logError('Attach image failed', err);
    }
  }

  private async _handleAttachGitDiff(): Promise<void> {
    try {
      const attachment = await attachGitDiff();
      if (attachment) {
        this._pendingAttachments.push(attachment);
        this._postMessage({
          type: 'attachmentsUpdated',
          content: JSON.stringify(this._pendingAttachments.map(a => ({ name: a.name, type: a.type }))),
        });
      }
    } catch (err) {
      logError('Attach git diff failed', err);
    }
  }

  private _handleAttachSelection(): void {
    const attachment = attachSelection();
    if (attachment) {
      this._pendingAttachments.push(attachment);
      this._postMessage({
        type: 'attachmentsUpdated',
        content: JSON.stringify(this._pendingAttachments.map(a => ({ name: a.name, type: a.type }))),
      });
    }
  }

  /** Flush memory on dispose. */
  public dispose(): void {
    this._memoryStore?.flush();
  }

  /* ───────────── HTML generation ───────────── */

  private _getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
  <title>NexoAgent</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <button id="btn-new" title="New Chat">✨ New</button>
      <button id="btn-undo" title="Undo Last Changes">↩ Undo</button>
      <button id="btn-think" title="Toggle Think Mode" class="think-btn">🧠</button>
      <div id="status-indicator"></div>
    </div>
    <div id="messages"></div>
    <div id="attachments-bar" style="display:none;"></div>
    <div id="input-area">
      <textarea id="input" rows="3" placeholder="Describe what you want to build…"></textarea>
      <div id="input-controls">
        <button id="btn-attach-file" title="Attach File(s)" class="attach-btn">📎</button>
        <button id="btn-attach-image" title="Attach Image" class="attach-btn">🖼️</button>
        <button id="btn-attach-git" title="Attach Git Diff" class="attach-btn">📋</button>
        <button id="btn-attach-selection" title="Attach Selection" class="attach-btn">✂️</button>
        <span id="char-count">0</span>
        <button id="btn-send" title="Send (Enter)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1.5l14 6.5-14 6.5v-5l10-1.5-10-1.5z"/></svg>
        </button>
        <button id="btn-cancel" title="Cancel" style="display:none;">■ Stop</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
