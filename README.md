# NexoAgent for VS Code

A production-grade, multi-agent AI coding assistant powered by NVIDIA's hosted models and OpenRouter. Think Cursor or Lovable — but as a VS Code extension with full agent autonomy.

## ✨ Features

### Multi-Agent Architecture
- **Planner Agent** — Analyzes your workspace and creates step-by-step implementation plans
- **Coder Agent** — Implements code changes using a ReAct loop with real tool execution
- **Reviewer Agent** — Automatically reviews generated code for bugs, style, and correctness

### Full Workspace Tooling
The agent can autonomously:
- 📖 **Read files** — understand existing code before making changes
- ✏️ **Write & edit files** — create new files or make targeted edits
- 🔍 **Search** — find files and text patterns across your workspace
- ⚡ **Run commands** — install packages, run tests, build projects
- 🩺 **Check diagnostics** — read VS Code errors/warnings and fix them

### Developer Experience
- 🎨 **Beautiful sidebar chat UI** with streaming responses
- ⌨️ **Keyboard shortcuts** — `Cmd+Shift+I` to invoke the agent
- 📋 **Right-click context menu** — Explain, Fix, Refactor, Test, Document
- 🔧 **Code Actions** — AI quick fixes appear in the lightbulb menu
- ↩️ **Undo support** — revert any agent changes with one click
- 🔄 **Conversation memory** — maintains context across messages

## 🚀 Getting Started

### 1. Get an NVIDIA API Key
1. Go to [build.nvidia.com](https://build.nvidia.com)
2. Sign up and get an API key (starts with `nvapi-`)

### 2. Install the Extension
```bash
cd nexo-agent
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

### 3. Configure
1. Open Settings (`Cmd+,`)
2. Search for "NexoAgent"
3. Enter your API key
4. (Optional) Choose a model — defaults to `nvidia/llama-3.3-nemotron-super-49b-v1`

### 4. Start Coding
- Click the NexoAgent icon in the activity bar
- Type what you want to build
- Watch the agent plan, code, and review autonomously

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+I` | Open agent prompt |
| `Cmd+Shift+A` | Focus chat panel |
| `Cmd+Shift+F` | Fix errors in current file |

## 🧠 Available Models

| Model | Best For |
|---|---|
| `nvidia/llama-3.3-nemotron-super-49b-v1` | General coding (default) |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Complex reasoning tasks |
| `minimaxai/minimax-m2.1` | Fast, capable general use |
| `deepseek-ai/deepseek-r1` | Deep reasoning & math |
| `qwen/qwen2.5-coder-32b-instruct` | Code-specialized tasks |
| `meta/llama-3.3-70b-instruct` | Balanced performance |

## 🏗️ Architecture

```
User Request
     │
     ▼
┌─────────────┐
│  Supervisor  │ ← Orchestrates the multi-agent pipeline
└──────┬──────┘
       │
   ┌───┼───┐
   ▼   ▼   ▼
┌────┐┌────┐┌────────┐
│Plan││Code││ Review  │ ← Specialized agents with ReAct loops
└────┘└────┘└────────┘
   │    │       │
   └────┼───────┘
        ▼
   ┌─────────┐
   │  Tools   │ ← File I/O, terminal, search, diagnostics
   └─────────┘
```

Each agent runs a **ReAct (Reason + Act) loop**:
1. Think about what to do next
2. Call a tool (read file, edit file, run command, etc.)
3. Observe the result
4. Repeat until the task is complete

## 📁 Project Structure

```
src/
  extension.ts           → VS Code activation, commands, code actions
  types.ts               → Shared TypeScript types
  config.ts              → Settings management
  logger.ts              → Output channel logging
  client/
    nvidiaClient.ts      → NVIDIA API client (OpenAI-compatible)
  tools/
    index.ts             → Tool registry & executor
    fileTools.ts         → read_file, write_file, edit_file, delete_file
    terminalTools.ts     → run_command
    searchTools.ts       → search_files, search_text, workspace structure
    diagnosticTools.ts   → VS Code diagnostics integration
  agents/
    base.ts              → ReAct loop engine & tool-call parser
    planner.ts           → Planning agent
    coder.ts             → Coding agent
    reviewer.ts          → Review agent
  supervisor/
    index.ts             → Multi-agent orchestrator
    state.ts             → State management & undo stack
  context/
    workspace.ts         → Workspace analysis & context gathering
  diff/
    apply.ts             → File edit application & revert
    explain.ts           → Change explanation generation
  webview/
    viewProvider.ts      → Sidebar webview provider
media/
  sidebar.css            → Chat UI styles (theme-aware)
  sidebar.js             → Chat UI client-side logic
  activity.svg           → Activity bar icon
```

## ⚙️ Configuration

All settings are under `nexoAgent.*` in VS Code settings:

| Setting | Default | Description |
|---|---|---|
| `apiKey` | `""` | Your NVIDIA API key |
| `model` | `nvidia/llama-3.3-nemotron-super-49b-v1` | Model to use |
| `temperature` | `0.6` | Sampling temperature |
| `maxTokens` | `8192` | Max tokens per response |
| `maxIterations` | `40` | Max tool-use steps per run |
| `autoApply` | `false` | Auto-apply changes |
| `commandTimeout` | `30000` | Shell command timeout (ms) |

## 📄 License

Apache 2.0
