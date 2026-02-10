/* ─────────────────────────────────────────────
   NexoAgent — Sidebar Chat Script
   ───────────────────────────────────────────── */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const btnSend = document.getElementById('btn-send');
  const btnCancel = document.getElementById('btn-cancel');
  const btnNew = document.getElementById('btn-new');
  const btnUndo = document.getElementById('btn-undo');
  const btnThink = document.getElementById('btn-think');
  const btnAttachFile = document.getElementById('btn-attach-file');
  const btnAttachImage = document.getElementById('btn-attach-image');
  const btnAttachGit = document.getElementById('btn-attach-git');
  const btnAttachSelection = document.getElementById('btn-attach-selection');
  const attachmentsBar = document.getElementById('attachments-bar');
  const statusIndicator = document.getElementById('status-indicator');
  const charCount = document.getElementById('char-count');

  let isStreaming = false;
  let currentAssistantEl = null;
  let currentContentEl = null;
  let currentTextBuffer = '';
  let toolCallCount = 0;
  let thinkModeActive = false;
  let pendingAttachments = [];

  /* ─── Welcome screen ─── */

  function showWelcome() {
    messagesEl.innerHTML = `
      <div class="welcome">
        <h2>🚀 NexoAgent</h2>
        <p>Your multi-agent coding assistant powered by AI.</p>
        <div class="examples">
          <div class="example" data-prompt="Create a REST API with Express and TypeScript">
            💡 Create a REST API with Express and TypeScript
          </div>
          <div class="example" data-prompt="Add error handling and input validation to this project">
            💡 Add error handling and input validation
          </div>
          <div class="example" data-prompt="Refactor the codebase to use async/await instead of callbacks">
            💡 Refactor to async/await
          </div>
          <div class="example" data-prompt="Write unit tests for the main module">
            💡 Write unit tests for the main module
          </div>
        </div>
      </div>
    `;

    messagesEl.querySelectorAll('.example').forEach(el => {
      el.addEventListener('click', () => {
        const prompt = el.getAttribute('data-prompt');
        if (prompt) {
          inputEl.value = prompt;
          sendMessage();
        }
      });
    });
  }

  showWelcome();

  /* ─── Input handling ─── */

  inputEl.addEventListener('input', () => {
    charCount.textContent = inputEl.value.length.toString();
    // Auto-resize textarea
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  btnSend.addEventListener('click', sendMessage);
  btnCancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  btnNew.addEventListener('click', () => {
    pendingAttachments = [];
    updateAttachmentsBar();
    vscode.postMessage({ type: 'newChat' });
  });
  btnUndo.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  btnThink.addEventListener('click', () => vscode.postMessage({ type: 'toggleThinkMode' }));
  btnAttachFile.addEventListener('click', () => vscode.postMessage({ type: 'attachFiles' }));
  btnAttachImage.addEventListener('click', () => vscode.postMessage({ type: 'attachImage' }));
  btnAttachGit.addEventListener('click', () => vscode.postMessage({ type: 'attachGitDiff' }));
  btnAttachSelection.addEventListener('click', () => vscode.postMessage({ type: 'attachSelection' }));

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

    // Clear welcome if shown
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();

    addUserMessage(text);
    vscode.postMessage({ type: 'sendMessage', text });
    inputEl.value = '';
    charCount.textContent = '0';
    inputEl.style.height = 'auto';
    // Attachments are consumed on send
    pendingAttachments = [];
    updateAttachmentsBar();
  }

  /* ─── Attachment bar ─── */

  function updateAttachmentsBar() {
    if (pendingAttachments.length === 0) {
      attachmentsBar.style.display = 'none';
      attachmentsBar.innerHTML = '';
      return;
    }
    attachmentsBar.style.display = 'flex';
    attachmentsBar.innerHTML = pendingAttachments.map((a, i) => {
      const icon = a.type === 'image' ? '🖼️' : a.type === 'git-diff' ? '📋' : a.type === 'selection' ? '✂️' : '📎';
      return `<span class="attachment-chip">${icon} ${escapeHtml(a.name)} <span class="remove-attachment" data-idx="${i}">×</span></span>`;
    }).join('');

    attachmentsBar.querySelectorAll('.remove-attachment').forEach(el => {
      el.addEventListener('click', (e) => {
        const idx = parseInt(e.target.getAttribute('data-idx'), 10);
        vscode.postMessage({ type: 'removeAttachment', index: idx });
      });
    });
  }

  /* ─── Message rendering ─── */

  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'message';
    el.innerHTML = `
      <div class="message-role user">You</div>
      <div class="message-content">${escapeHtml(text)}</div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function startAssistantMessage() {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'message';
    currentAssistantEl.innerHTML = `
      <div class="message-role assistant">Agent</div>
      <div class="message-content"></div>
    `;
    currentContentEl = currentAssistantEl.querySelector('.message-content');
    currentTextBuffer = '';
    toolCallCount = 0;
    messagesEl.appendChild(currentAssistantEl);
    setStreaming(true);
    scrollToBottom();
  }

  function appendText(text) {
    currentTextBuffer += text;
    if (currentContentEl) {
      currentContentEl.innerHTML = renderMarkdown(currentTextBuffer);
      scrollToBottom();
    }
  }

  function appendThinking(text) {
    if (!currentAssistantEl) return;
    let thinkEl = currentAssistantEl.querySelector('.think-block');
    if (!thinkEl) {
      thinkEl = document.createElement('details');
      thinkEl.className = 'think-block';
      thinkEl.innerHTML = '<summary>🧠 Thinking…</summary><div class="think-content"></div>';
      // Insert before content
      if (currentContentEl) {
        currentAssistantEl.insertBefore(thinkEl, currentContentEl);
      } else {
        currentAssistantEl.appendChild(thinkEl);
      }
    }
    const contentEl = thinkEl.querySelector('.think-content');
    if (contentEl) {
      contentEl.textContent += text;
    }
    scrollToBottom();
  }

  function endAssistantMessage() {
    setStreaming(false);
    currentAssistantEl = null;
    currentContentEl = null;
    currentTextBuffer = '';
  }

  function addToolCall(toolName, args) {
    if (!currentAssistantEl) return;

    toolCallCount++;
    const el = document.createElement('div');
    el.className = 'tool-call';

    const icon = getToolIcon(toolName);
    const argsPreview = Object.entries(args || {})
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? truncate(v, 60) : JSON.stringify(v)}`)
      .join(', ');

    el.innerHTML = `
      <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="chevron">▶</span>
        <span class="icon">${icon}</span>
        <span>${toolName}</span>
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:normal; opacity:0.7; margin-left:6px">${escapeHtml(argsPreview)}</span>
        <span class="status running">⟳</span>
      </div>
      <div class="tool-call-body">Executing…</div>
    `;

    // Insert before current text content
    if (currentContentEl && currentContentEl.innerHTML.trim()) {
      currentAssistantEl.insertBefore(el, currentContentEl);
    } else {
      currentAssistantEl.appendChild(el);
    }
    scrollToBottom();
    return el;
  }

  function addToolResult(content, data) {
    // Find the last tool call without a result
    const toolCalls = messagesEl.querySelectorAll('.tool-call');
    const lastCall = toolCalls[toolCalls.length - 1];
    if (!lastCall) return;

    const body = lastCall.querySelector('.tool-call-body');
    const statusEl = lastCall.querySelector('.status');

    if (body) {
      body.textContent = truncate(content, 500);
    }
    if (statusEl) {
      const success = data?.success !== false;
      statusEl.textContent = success ? '✓' : '✗';
      statusEl.className = `status ${success ? 'success' : 'error'}`;
    }
    scrollToBottom();
  }

  function addStatusMessage(text) {
    // Update the status indicator in the toolbar
    if (statusIndicator) {
      statusIndicator.innerHTML = isStreaming
        ? `<span class="spinner"></span> ${escapeHtml(text)}`
        : escapeHtml(text);
    }
  }

  function addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'error-msg';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  /* ─── Message handler from extension ─── */

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'startAssistant':
        startAssistantMessage();
        break;
      case 'endAssistant':
        endAssistantMessage();
        break;
      case 'text':
        appendText(msg.content);
        break;
      case 'thinking':
        appendThinking(msg.content);
        break;
      case 'tool_call':
        addToolCall(msg.content, msg.data);
        break;
      case 'tool_result':
        addToolResult(msg.content, msg.data);
        break;
      case 'status':
        addStatusMessage(msg.content);
        break;
      case 'error':
        addErrorMessage(msg.content);
        break;
      case 'done':
        if (msg.content && currentContentEl) {
          appendText(msg.content.startsWith(currentTextBuffer) ? msg.content.slice(currentTextBuffer.length) : '');
        }
        addStatusMessage('Done');
        break;
      case 'clear':
        showWelcome();
        addStatusMessage('');
        break;
      case 'addUserMessage':
        const welcome = messagesEl.querySelector('.welcome');
        if (welcome) welcome.remove();
        addUserMessage(msg.content);
        break;
      case 'thinkModeChanged':
        thinkModeActive = msg.content === 'on';
        btnThink.classList.toggle('active', thinkModeActive);
        btnThink.title = thinkModeActive ? 'Think Mode: ON (click to toggle)' : 'Think Mode: OFF (click to toggle)';
        break;
      case 'attachmentsUpdated':
        try {
          pendingAttachments = JSON.parse(msg.content);
        } catch { pendingAttachments = []; }
        updateAttachmentsBar();
        break;
    }
  });

  /* ─── Streaming state ─── */

  function setStreaming(active) {
    isStreaming = active;
    btnSend.style.display = active ? 'none' : 'flex';
    btnCancel.style.display = active ? 'inline-flex' : 'none';
    inputEl.disabled = active;
    if (!active) {
      statusIndicator.innerHTML = '';
    }
  }

  /* ─── Markdown rendering (lightweight) ─── */

  function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Unordered lists
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs (double newline)
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>(<h[234]>)/g, '$1');
    html = html.replace(/(<\/h[234]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');

    return html;
  }

  /* ─── Utilities ─── */

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function truncate(text, max) {
    if (!text) return '';
    text = String(text);
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function getToolIcon(name) {
    const icons = {
      read_file: '📖',
      write_file: '✏️',
      edit_file: '🔧',
      delete_file: '🗑️',
      list_directory: '📁',
      search_files: '🔍',
      search_text: '🔎',
      get_workspace_structure: '🗂️',
      run_command: '⚡',
      get_diagnostics: '🩺',
    };
    return icons[name] || '🔧';
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // Notify extension that webview is ready
  vscode.postMessage({ type: 'ready' });
})();
