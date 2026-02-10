# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in NexoAgent, please report it responsibly.

### How to Report

1. **Email**: Send a detailed report to **security@nexo-agent.dev** (replace with your actual security contact).
2. **GitHub**: Open a [private security advisory](https://github.com/nexo-ai/nexo-agent/security/advisories/new) on the repository.
3. **Do NOT** open a public issue for security vulnerabilities.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

### Response Timeline

- **24 hours**: Acknowledgement of your report
- **72 hours**: Initial assessment and severity rating
- **7 days**: Fix development begins for confirmed vulnerabilities
- **30 days**: Public disclosure (coordinated with reporter)

## Security Design

### API Key Handling
- API keys are stored using VS Code's SecretStorage API (OS keychain)
- Keys are **never** persisted in workspace settings, logs, or telemetry
- Keys are cached in memory only for the session duration
- Legacy plain-text keys are auto-migrated to SecretStorage

### Data Handling
- All code context is sent directly to the configured NVIDIA API endpoint
- No intermediate servers or proxies are used
- No user code is stored, cached, or transmitted outside of API calls
- Audit logs are stored locally in `.nexo-ai/audit.log` and never leave the machine

### Extension Sandboxing
- File operations are restricted to the workspace directory
- Shell commands require user approval (unless `autoApply` is enabled)
- The extension runs in VS Code's extension host (sandboxed from other extensions)

### Dependencies
- Minimal dependencies to reduce attack surface
- Regular dependency audits via Dependabot / `npm audit`
- No native modules or binary dependencies

## Dependency Vulnerability Reporting

We use GitHub Dependabot for automated dependency vulnerability scanning. If you notice a vulnerable dependency that hasn't been addressed, please report it using the process above.
