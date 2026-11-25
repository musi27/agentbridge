# Release notes

One file per release, `vX.Y.Z.md`, written in the release PR alongside the version bump. The
[release workflow](../../.github/workflows/release.yml) uses `docs/release-notes/<tag>.md` as the GitHub release body
and refuses to run if it is missing or empty (see [releasing.md](../releasing.md)).

## Format

Write for people who use agentbridge, not for maintainers: what changed for them and what they need to do.

1. A one-line summary of the release.
2. Bullets, each starting with **New:**, **Fixed:** or **Docs:**, in user language (commands and tool names in
   backticks; no internal file paths, PR numbers or private names).
3. An **Upgrading:** line with the steps to take, e.g. `npm install -g @musi27/agentbridge`, then `agentbridge init`,
   then restart open Claude Code and Codex sessions, plus anything release-specific.
4. A last line with the pinned install command.

```markdown
One-line summary of the release.

- **New:** what users can do now.
- **Fixed:** what no longer goes wrong.
- **Docs:** what's newly documented, and where.

**Upgrading:** `npm install -g @musi27/agentbridge`, then `agentbridge init`, then restart open Claude Code and Codex sessions.

`npm install -g @musi27/agentbridge@X.Y.Z`
```

Notes for releases from v0.1.1 on are here. They match the published GitHub release bodies.
