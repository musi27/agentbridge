# Releasing agentbridge

agentbridge ships to npm as one self-contained package, `agentbridge` (built from [`packaging/npm`](../packaging/npm)).
CI builds and verifies the tarball and attaches it to a GitHub release draft. **CI never publishes to npm**: the owner
publishes the verified tarball by hand.

## What the package contains

- `dist/`: the CLI (`cli.mjs`, the `agentbridge` bin) and the launchd entry (`service-main.mjs`) as esbuild ESM
  bundles, with every workspace package and dependency inlined. The tarball declares no dependencies.
- `plugin/` and `.claude-plugin/marketplace.json`: the Claude Code plugin (its runtime is the bundle committed in
  `adapters/claude-code/plugin/runtime`). `agentbridge init` runs `claude plugin marketplace add <installed package>`.
- `bin/agentbridge-helper`: the Swift helper for Touch ID and the keychain, universal (arm64 + x86_64), **ad-hoc signed**
  (no Apple Developer ID yet; see [release-signing.md](release-signing.md)). npm installs are not quarantined, so it
  runs. A copy downloaded with a browser would be quarantined and blocked by Gatekeeper.

## Build and test locally

```bash
npm ci
npm run check
npm run pack:release
```

`pack:release` builds the helper if missing, builds the package, runs `npm pack` into `packaging/npm/out/`, and
verifies the tarball (`packaging/npm/scripts/verify.ts`): it installs it into a temp prefix, runs `agentbridge help`
and `agentbridge doctor` without a bridge, checks the helper answers and is universal and ad-hoc signed, checks the
plugin layout and the launchd entry, and that no `@agentbridge/*` import is left. It prints the tarball size and a
contents summary.

## Cut a release

1. Bump `version` in `packaging/npm/package.json` (and `BRIDGE_VERSION` in `packages/bridge/src/core/engine.ts`).
2. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`. The [release workflow](../.github/workflows/release.yml)
   runs `npm ci`, `npm run check`, builds the helper fresh (universal, ad-hoc), builds and verifies the package, and
   creates a **draft** GitHub release with `musi27-agentbridge-0.1.0.tgz` attached. (Manual runs from the Actions tab build
   and verify the tarball and upload it as a workflow artifact.)
3. Download the tarball from the draft release and, optionally, verify it again on your Mac:
   `node packaging/npm/scripts/verify.ts musi27-agentbridge-0.1.0.tgz`.

## Publish (owner only)

```bash
npm login
npm publish musi27-agentbridge-0.1.0.tgz --access public
```

Then publish the GitHub release draft. Publishing the exact tarball CI verified (rather than running `npm publish` in a
checkout) keeps what users install identical to what was tested.
