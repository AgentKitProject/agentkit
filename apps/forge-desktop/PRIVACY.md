# Privacy

AgentKitForge v0.1 is local-first.

- No account is required for local use.
- There is no AgentKitForge backend in v0.1.
- No telemetry is collected unless it is explicitly added in a future release.

## Local Data

AgentKitForge stores app settings, My Kits library data, and default folder preferences locally on your machine.

Provider API keys are stored locally in this app's settings file on your machine, not in an OS keychain. Do not use shared or untrusted machines. You can clear stored keys from Settings.

## AI Providers

When you use AI features, your prompt, selected Agent Kit context, and any additional run context are sent to the AI provider you selected.

- OpenAI, Anthropic, Gemini, and other hosted providers receive the data needed to complete the selected request.
- Ollama and other local providers receive requests at the configured local endpoint.
- Custom OpenAI-compatible providers are user-controlled. You are responsible for trusting the provider and base URL you configure.

AgentKitForge blocks non-local plain HTTP provider URLs by default. Local HTTP endpoints such as `localhost` are allowed for local model servers.

## Imports

Git imports read from the repository URL you provide. AgentKitForge uses local Git credentials for private repositories and does not store GitHub, GitLab, or Bitbucket tokens in v0.1.

AgentKitForge does not execute scripts from imported repositories or packages during import.
