# agentbridge documentation

## Using agentbridge

| Document | What's in it |
|---|---|
| [../README.md](../README.md) | What agentbridge is, requirements, install, approvals, security boundary, data and privacy, limitations |
| [setup-grok.md](setup-grok.md) | Connect a Grok bot with `agentbridge add grok`, step by step, and fix round-trip failures |
| [setup-codex.md](setup-codex.md) | Connect Codex CLI sessions with `agentbridge add codex`, trust the hooks, and how approval works there |
| [troubleshooting.md](troubleshooting.md) | Unreachable sessions, held deliveries, unsafe permission modes, Claude Code version, bridge and relay problems, Touch ID |
| [self-hosting.md](self-hosting.md) | Run your own relay on Vercel and Upstash |
| [status-json.md](status-json.md) | `agentbridge status --json` and `status --watch --json`: the versioned snapshot schema the agent panel reads, with an example |

## Security

| Document | What's in it |
|---|---|
| [security.md](security.md) | Threat model, the approval mechanism and what testing verified, framing, deny-rule gaps, relay trust, third parties |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability |

## Design

| Document | What's in it |
|---|---|
| [../SPEC.md](../SPEC.md) | The specification: design and threat model (authoritative) |
| [notifications.md](notifications.md) | Desktop notifications from the bridge service: findings and the proposal for guaranteed delivery |
| [releasing.md](releasing.md) | Building, verifying and publishing the npm package |
| [release-notes/](release-notes/README.md) | User-facing notes for each release (the GitHub release bodies) |
| [release-signing.md](release-signing.md) | How the Touch ID and keychain helper (`AgentBridge.app`) is Developer ID-signed, and why |

## Contributing

| Document | What's in it |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Repo layout, conventions, tests, spikes, commits |
| [../packages/bridge/README.md](../packages/bridge/README.md) | Bridge internals and contracts with other packages |
| [../packages/presence/README.md](../packages/presence/README.md) | macOS Keychain, Touch ID helper, notifications and launchd |
| [../adapters/claude-code/README.md](../adapters/claude-code/README.md) | The Claude Code plugin: MCP server, hooks, dev loop |
