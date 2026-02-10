# Changelog

All notable changes to the **NexoAgent** VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-02-10

### Added — Multi-Provider Support
- **OpenRouter integration**: Use 16+ models (Claude Sonnet, GPT-4o, Gemini, DeepSeek, Llama, etc.) alongside NVIDIA
- **Provider switching**: `Cmd+Shift+P → Switch Provider` or click status bar to toggle NVIDIA ↔ OpenRouter
- **Separate API key management**: Secure SecretStorage for each provider's key
- **Provider-aware status bar**: Shows active provider + model, click to switch

### Added — Persistent Memory & RAG
- **Conversation memory**: JSONL-based persistent store with keyword search, tag extraction, auto-compaction
- **LLM-powered summarization**: Automatic conversation compaction when memory grows large
- **RAG pipeline**: BM25/TF-IDF workspace search with chunking, vector store, and auto-reindexing every 5 min
- **Memory-aware supervisor**: Injects relevant memory + RAG context into every agent run

### Added — Attachments & Context
- **File attachments**: Attach workspace files to chat context
- **Image attachments**: Base64 image support for vision-capable models
- **Git diff/log**: Attach current git changes to chat
- **Editor selection**: Send highlighted code directly to chat
- **Diagnostics**: Attach current file errors/warnings

### Added — Think Mode & MCP
- **Think mode toggle**: Enable/disable model reasoning (think blocks) from sidebar UI
- **Collapsible think blocks**: Rendered in sidebar with `<details>` disclosure
- **MCP client**: JSON-RPC 2.0 Model Context Protocol over stdio (protocol 2024-11-05)
- **MCP registry**: Multi-server management with automatic tool bridging

### Added — Enterprise Agents & Full-App Creation
- **Architect agent**: System design, architecture decisions, tech stack recommendations
- **Frontend agent**: React/Vue/Svelte component generation with styling
- **Backend agent**: API routes, database schemas, server setup
- **Full-app orchestrator**: 757-line Path D pipeline for scaffolding entire applications
- **Dynamic sub-agent spawning**: Path C enterprise pipeline with parallel sub-agents

### Changed
- Supervisor now routes across 4 execution paths (Simple/Standard/Enterprise/Full App)
- Agent prompts upgraded to enterprise-grade with explicit quality instructions
- Webpack bundle: 172 KiB (from 132 KiB in v1.0.0)

## [1.0.0] - 2025-01-01

### Added
- **Multi-agent pipeline**: Planner → Coder → Reviewer with automatic fix loop
- **ReAct agent loop**: Reason + Act pattern with XML tool-call parsing
- **10 workspace tools**: read_file, write_file, edit_file, delete_file, list_directory, search_files, search_text, get_workspace_structure, run_command, get_diagnostics
- **Streaming chat UI**: Sidebar webview with real-time token streaming
- **NVIDIA API client**: SSE streaming with retry/backoff, token tracking, clear error messages
- **Secure API key handling**: VS Code SecretStorage (OS keychain), legacy key auto-migration
- **Token & cost meter**: Status bar showing session usage with estimated cost
- **Audit logging**: Workspace-local `.nexo-ai/audit.log` for all agent actions
- **Agent YAML schema**: Customizable agent definitions with permissions and validation
- **Code actions**: Quick fix and refactor via lightbulb menu
- **Context menu**: Explain, Fix, Refactor, Test, Document selected code
- **Undo stack**: Revert all changes from last agent task
- **Keyboard shortcuts**: Cmd+Shift+I (run agent), Cmd+Shift+A (focus chat)
- **7 models pre-configured**: Nemotron, DeepSeek R1, Qwen Coder, Llama 3.3, Gemma 3, MiniMax
- **CI pipeline**: GitHub Actions (lint, build, test, package VSIX)
- **Legal docs**: LICENSE (Apache-2.0), SECURITY.md, PRIVACY.md
- **Community docs**: CONTRIBUTING.md, CODE_OF_CONDUCT.md

### Security
- API keys never stored in plain-text settings
- All file operations sandboxed to workspace directory
- Shell commands require user approval by default
