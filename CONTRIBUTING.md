# Contributing

Thanks for helping. agentbridge is pre-release; [SPEC.md](SPEC.md) (v0.4) is the authoritative design. If a
change contradicts it, change the spec in the same pull request and say why.

Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Repository layout

```
agentbridge/
├── .claude-plugin/
│   └── marketplace.json   in-repo Claude Code plugin marketplace (lists adapters/claude-code/plugin)
├── packages/
│   ├── protocol/      schemas, enums, framing, limits, platform interfaces (@agentbridge/protocol)
│   ├── bridge/        bridge service, storage, policy, IPC, delivery queue, `agentbridge` CLI (@agentbridge/bridge)
│   │                  `add grok` / `revoke grok:` live in src/cli/grok.ts and src/grok/setup.ts
│   ├── presence/      macOS Keychain, Touch ID helper, notifications, launchd (@agentbridge/presence)
│   └── relay/         Vercel + Upstash relay and the bridge-side relay client (@agentbridge/relay)
├── adapters/
│   ├── claude-code/   Claude Code plugin: MCP server + hooks (@agentbridge/adapter-claude-code)
│   ├── grok-bot/      Grok Bot adapter: delivery packing and webhook results (@agentbridge/adapter-grok)
│   └── fake/          in-process fake adapter for tests (@agentbridge/adapter-fake)
├── docs/              user docs, security, self-hosting, design notes
├── scripts/           repo tooling (the docs link check)
├── SPEC.md
└── LICENSE            MIT
```

Each package's README covers its internals and its contracts with the other packages:
[packages/bridge](packages/bridge/README.md), [packages/presence](packages/presence/README.md) and
[adapters/claude-code](adapters/claude-code/README.md).

## Setup

You need macOS, Node 24 or later, and npm. CI runs on `macos-latest` with Node 24.

```bash
npm ci
```

```bash
npm run check
```

`npm run check` runs the TypeScript build (`tsc -b`), all tests, and the docs link check. It must pass before you
open a pull request; CI runs the same command.

## Conventions

**TypeScript and modules**

- TypeScript, ES modules (`"type": "module"`), Node 24+. Packages are npm workspaces.
- `npm run typecheck` is `tsc -b` (build mode with project references). Don't use `tsc -b --noEmit`: it fails with
  TS6310 once projects reference each other. `dist/` and `*.tsbuildinfo` are gitignored.
- **Running from source.** Packages export an `agentbridge-source` condition that points at `src/index.ts`. Tests and
  local scripts run TypeScript directly with Node's type stripping, so pass the condition:

  ```bash
  node --conditions=agentbridge-source --test packages/bridge/test/*.test.ts
  ```

  If another package imports yours from source, add the same condition first in your `package.json` `exports`
  (`"agentbridge-source": "./src/index.ts"`). `tsconfig.base.json` sets `customConditions: ["agentbridge-source"]`
  so the type checker agrees.

**Tests**

- Node's built-in test runner (`node:test`), files under `<package>/test/**/*.test.ts`. The root `npm test` runs all of
  them with `--conditions=agentbridge-source`.
- Drive time with an injectable clock rather than real timers, as the bridge does (`FakeClock`).
- Security behaviour from [SPEC §19.3](SPEC.md#193-security-tests-within-the-2-boundary) needs a test.

**Dependencies**

- Pin exact versions (no `^` or `~`), as the existing `package.json` files do.
- Prefer versions at least two weeks old. SDK ranges can pull very fresh transitive dependencies;
  `npm install --before=<date two weeks ago>` keeps them older.

**Docs**

- User-facing docs live in `docs/`, indexed in [docs/README.md](docs/README.md). Plain, precise English; every claim
  should trace to SPEC.md or to the code.
- Where a command, flag or setting isn't in the code yet, write the spec's name and mark it with an HTML comment
  (`<!-- TODO: … -->`).
- `npm run check:links` fails on relative links that point at missing files or headings, and on any file in `docs/`
  that [docs/README.md](docs/README.md) doesn't link to. `node scripts/check-links.mjs --product` also fails on links
  to pre-release verification material, which isn't part of the published repository.

## Commits and pull requests

- Small, focused commits with a subject line that names the area, for example `relay: …`, `bridge: …`, `docs: …`,
  `SPEC §12.5: …`.
- Commit attribution trailers are **not required** for human contributors. Commits made by AI coding agents in this
  repository carry a `Co-Authored-By:` trailer naming the agent.
- Open pull requests against `main`. Describe what changed, which SPEC sections it implements or changes, and how you
  tested it (including any manual check against real Claude Code or Grok Bot).

## Naming

The project name and any new names must not suggest an official xAI, SpaceXSI, Cursor or Anthropic product.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
