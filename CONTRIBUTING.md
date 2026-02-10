# Contributing to NexoAgent

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites
- Node.js 18+
- VS Code 1.85+
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/nexo-ai/nexo-agent.git
cd nexo-agent

# Install dependencies
npm install

# Build in development mode
npm run dev

# Watch for changes
npm run watch
```

### Running the Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension will activate in the new VS Code window

### Running Tests

```bash
# Type checking
npm run lint

# Unit tests
npm test

# Build production bundle
npm run compile
```

## Project Structure

```
src/
├── extension.ts          # Activation, commands, status bars
├── config.ts             # Configuration & SecretStorage
├── logger.ts             # Output channel logging
├── types.ts              # Shared TypeScript interfaces
├── audit.ts              # Audit log system
├── agents/
│   ├── base.ts           # ReAct loop engine
│   ├── planner.ts        # Planning agent
│   ├── coder.ts          # Coding agent
│   ├── reviewer.ts       # Review agent
│   └── yamlLoader.ts     # Custom agent YAML/JSON loader
├── client/
│   └── nvidiaClient.ts   # NVIDIA API streaming client
├── tools/
│   ├── index.ts          # Tool registry
│   ├── fileTools.ts      # File read/write/edit/delete
│   ├── terminalTools.ts  # Shell command execution
│   ├── searchTools.ts    # File/text search
│   └── diagnosticTools.ts# Compiler error diagnostics
├── supervisor/
│   ├── index.ts          # Multi-agent orchestrator
│   └── state.ts          # Agent state & undo stack
├── context/
│   └── workspace.ts      # Workspace context gathering
├── diff/
│   └── apply.ts          # File edit application & revert
└── webview/
    └── viewProvider.ts   # Sidebar chat WebviewViewProvider

tests/
├── unit/                 # Unit tests (mocha)
└── e2e/                  # Extension host tests (@vscode/test-electron)
```

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Single quotes**, **2-space indentation**, **trailing commas**
- **Functional style** — prefer pure functions, minimize state
- **Document public APIs** — JSDoc for exported functions

## Making Changes

1. **Fork** the repository
2. Create a **feature branch**: `git checkout -b feature/my-feature`
3. Make your changes with **tests**
4. Ensure `npm run lint` and `npm test` pass
5. Submit a **Pull Request** with a clear description

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add model discovery API
fix: handle 429 rate limit correctly
docs: update README with new commands
test: add SSE parsing edge cases
chore: update dependencies
```

## Reporting Issues

- Use [GitHub Issues](https://github.com/nexo-ai/nexo-agent/issues)
- Include VS Code version, extension version, and OS
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please be respectful and constructive.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
