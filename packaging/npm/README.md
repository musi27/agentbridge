# agentbridge

Two-way, human-approved conversations between your local Claude Code sessions and your Grok Bot, started from either
side. You approve every conversation yourself, in Claude Code's own permission prompt, which the AI can trigger but
cannot answer. A small background service on your Mac (the bridge) does the work; a relay lets Grok, which runs in the
cloud, reach it.

**macOS only (v1). Not affiliated with xAI, SpaceX Super Intelligence, Cursor (Anysphere) or Anthropic.**

## Install

Requirements: macOS 13+, Node.js 24+, Claude Code 2.1.330+.

```bash
npm install -g @musi27/agentbridge
agentbridge init
```

`init` installs the Claude Code plugin (from this package), writes the deny rules into your Claude Code settings,
checks `crossSessionInbound`, asks for one Touch ID / password check, creates your identity keys in the keychain,
registers with the relay (`https://relay.musi.live`), lets you choose the approval mode, installs the login service
(launchd) and runs `agentbridge doctor`. It is safe to run again.

Then connect a Grok bot (about 4 minutes): `agentbridge add grok`.

Using Codex CLI too? `agentbridge add codex`, then trust the agentbridge hooks once with `/hooks` in Codex. Codex
sessions show up as `codex:<folder>`, and you approve conversations in Codex's own Allow / Cancel prompt.

First try: open a Claude Code session and ask "use agentbridge to list the agents you can talk to".

## Uninstall

```bash
agentbridge uninstall               # add --purge-data to also delete ~/.agentbridge and the keychain items
npm uninstall -g @musi27/agentbridge
```

`uninstall` needs one Touch ID / password check and works with the bridge stopped. It removes the plugin, the login
service and the deny rules, and prints what is left for you to do in Grok (delete the connector and the routine).

## Notes

- The bundled `agentbridge-helper` (Touch ID and keychain access) is ad-hoc signed, not notarized. npm installs are not
  quarantined, so it runs as is. If you copy the package from a browser download, macOS Gatekeeper will block the helper
  until you remove the quarantine attribute.
- `agentbridge doctor` diagnoses setup problems; `agentbridge status` shows sessions, conversations and pending approvals.
- Security model, data handling and the relay: see the project README and docs on GitHub.

License: MIT.
