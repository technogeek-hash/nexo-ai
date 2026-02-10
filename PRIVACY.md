# Privacy Policy — NexoAgent VS Code Extension

**Last updated**: 2025-01-01

## Overview

NexoAgent is a VS Code extension that helps developers write, review, and debug code using NVIDIA-hosted AI models. This document explains how your data is handled.

## What Data Is Collected

### Data Sent to NVIDIA API
When you interact with the agent, the following data is sent to the configured NVIDIA API endpoint:

- **Code context**: Portions of your workspace files relevant to your request (file contents, directory structure)
- **Your prompts**: The text you type into the chat or via commands
- **Diagnostic information**: Compiler errors and warnings from your workspace (when using "Fix Errors")

This data is sent **directly** to the NVIDIA API endpoint (`integrate.api.nvidia.com` by default) using HTTPS encryption.

### Data NOT Collected
- ❌ No telemetry is sent to the extension authors by default
- ❌ No analytics, crash reports, or usage tracking
- ❌ No data is sent to third-party services (only to the configured API endpoint)
- ❌ No personal information beyond what you include in prompts

## Telemetry

Telemetry is **disabled by default** (`nexoAgent.telemetry: false`). If enabled by the user, only anonymous usage counts (requests per session) are logged locally. No data is transmitted externally.

## Local Storage

The extension stores the following data locally on your machine:

| Data | Location | Purpose |
|------|----------|---------|
| API Key | VS Code SecretStorage (OS keychain) | Authentication with NVIDIA API |
| Audit Log | `.nexo-ai/audit.log` in workspace | Local record of agent actions |
| Conversation History | VS Code Webview state | Chat context within session |
| Extension Settings | VS Code settings.json | User preferences |

## Data Retention

- **API calls**: Data sent to NVIDIA API is subject to [NVIDIA's privacy policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/)
- **Local data**: Audit logs, settings, and cached state persist until you delete them
- **Session data**: Token usage counters and conversation state are cleared when VS Code restarts

## Your Rights

- **Delete API key**: Use the command "NVIDIA AI: Delete API Key"
- **Delete audit logs**: Remove the `.nexo-ai/` directory from your workspace
- **Clear settings**: Reset via VS Code Settings UI
- **Opt out of telemetry**: Keep `nexoAgent.telemetry` set to `false` (the default)

## Self-Hosted Endpoints

If you configure a self-hosted model endpoint (`nexoAgent.baseUrl`), all API traffic goes to your server instead of NVIDIA's cloud. The extension does not validate or intercept this traffic.

## GDPR / CCPA Compliance

- This extension does not independently collect or process personal data
- All data processing occurs through the configured API provider (NVIDIA by default)
- Users in the EU/California should review [NVIDIA's data processing terms](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/)

## Contact

For privacy questions about this extension, open an issue on the GitHub repository or contact the maintainers.

For NVIDIA API privacy questions, refer to [NVIDIA's Privacy Center](https://www.nvidia.com/en-us/about-nvidia/privacy-center/).
