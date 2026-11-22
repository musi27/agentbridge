# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**
(GitHub's guide: <https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>).


Do not open a public issue for a vulnerability. Include the agentbridge version or commit, your Claude Code version,
and steps to reproduce.

## What counts as a vulnerability

agentbridge's threat model is in [docs/security.md](docs/security.md). In short, these are in scope:

- a conversation started, accepted or extended without a human answering Claude Code's native prompt or the
  user-presence check
- a confirm accepted with facts that differ from the issued request, or from a different session
- remote agent content that is shown as a genuine agentbridge notice, or that reaches conversations it isn't part of
- one relay user reaching another user's bridge, bots or messages
- reading held relay data from a Redis or storage disclosure

These are **out of scope** by design (documented in [docs/security.md](docs/security.md#out-of-scope)):

- a local agent or program, running as you, that deliberately tampers with agentbridge (bridge socket, files,
  Keychain, its own copy of the plugin server, an Agent SDK host)
- commands that slip past the deny rules, as long as user presence still stops privileged actions
- root or admin compromise
- Grok Bot internals

If you're unsure, report it anyway.

## Supported versions

agentbridge is pre-release. Only the `main` branch receives fixes.
