# Releasing agentbridge

agentbridge ships to npm as one self-contained package, `agentbridge` (built from [`packaging/npm`](../packaging/npm)).
CI builds and verifies the tarball and attaches it to a GitHub release draft. **CI never publishes to npm**: the owner
publishes the verified tarball by hand.

## What the package contains

- `dist/`: the CLI (`cli.mjs`, the `agentbridge` bin) and the launchd entry (`service-main.mjs`) as esbuild ESM
  bundles, with every workspace package and dependency inlined. The tarball declares no dependencies.
- `plugin/` and `.claude-plugin/marketplace.json`: the Claude Code plugin (its runtime is the bundle committed in
  `adapters/claude-code/plugin/runtime`). `agentbridge init` runs `claude plugin marketplace add <installed package>`.
- `bin/AgentBridge.app`: background app bundle (`live.musi.agentbridge`, no Dock icon) whose executable is the Swift
  helper for Touch ID and the keychain, universal (arm64 + x86_64), **signed with the project's Developer ID**
  (hardened runtime, secure timestamp, not notarised). It is the bundle committed at `packages/presence/signed/`,
  copied as is ([release-signing.md](release-signing.md)). npm installs are not quarantined, so it runs. A copy
  downloaded with a browser would be quarantined and blocked by Gatekeeper.

## Build and test locally

```bash
npm ci
npm run check
npm run pack:release
```

`pack:release` checks the committed signed helper (valid Developer ID signature of team `67B9AY2VHJ`, matches
`signed/manifest.json`, built from the current helper sources; otherwise it stops with "re-sign on your Mac"), builds the package, runs `npm pack` into `packaging/npm/out/`, and
verifies the tarball (`packaging/npm/scripts/verify.ts`): it installs it into a temp prefix, runs `agentbridge help`,
`agentbridge --version` (must print the package version) and `agentbridge doctor` without a bridge, checks the helper answers, is universal, carries the Developer ID signature (team, identifier, designated requirement, hardened runtime, timestamp) and isn't quarantined, checks the
plugin layout and version and the launchd entry, and that no `@agentbridge/*` import is left. It prints the tarball size and a
contents summary.

## Cut a release

1. Bump the version everywhere it lives; one release version covers the CLI, the bridge and the plugin, and
   `npm run check` fails if they disagree:
   - `version` in `packaging/npm/package.json`
   - `BRIDGE_VERSION` in `packages/bridge/src/version.ts`
   - `PLUGIN_VERSION` in `adapters/claude-code/src/version.ts` and `version` in
     `adapters/claude-code/plugin/.claude-plugin/plugin.json`, then `npm run build:plugin -w @agentbridge/adapter-claude-code`
   - the README status line (`Status: vX.Y.Z`)
   - write the release notes, `docs/release-notes/vX.Y.Z.md`, in the format described in
     [release-notes/README.md](release-notes/README.md). They become the GitHub release body as written, so write them
     for users. `npm run check` fails if the file for the version in `packaging/npm/package.json` is missing or empty.
2. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`. The [release workflow](../.github/workflows/release.yml)
   first checks that `docs/release-notes/v0.1.0.md` exists and isn't empty, and **fails before building anything if it
   doesn't**, so no release goes out with a placeholder body. It then runs `npm ci`, `npm run check`, checks the
   committed signed helper still matches its sources (`npm run check:signed-helper -w @agentbridge/presence`; it never
   signs), builds and verifies the package, and creates a **draft** GitHub release with
   `musi27-agentbridge-0.1.0.tgz` attached and the notes file as its body. The `npm publish` command for the tarball is
   printed in the run's summary. (Manual runs from the Actions tab skip the notes check, build and verify the tarball,
   and upload it as a workflow artifact.)
3. Download the tarball from the draft release and, optionally, verify it again on your Mac:
   `node packaging/npm/scripts/verify.ts musi27-agentbridge-0.1.0.tgz`.

## Re-signing the helper

Re-sign whenever a helper source changed since the last signing: `packages/presence/native/main.swift`, `Info.plist`,
`AppIcon.icns` or `build.sh`. `npm run check` then prints a diagnostic, and `npm run pack:release` and the release
workflow refuse to pack ("helper sources changed (…): re-sign on your Mac"). Also re-sign if the certificate is
revoked or replaced. Expiry alone doesn't need it: the secure timestamp keeps existing signatures valid.

On the owner's Mac, with the agentbridge "Developer ID Application" certificate in the login keychain:

```bash
npm run sign:helper -w @agentbridge/presence
```

It builds the bundle, signs it (macOS may ask to allow `codesign` to use the key: enter the login password; **Always
Allow** avoids asking next time), checks the signature, and replaces `packages/presence/signed/AgentBridge.app` and
`signed/manifest.json`. Commit both in the PR that changed the sources, or in the release PR:

```bash
git add packages/presence/signed
```

Check the committed bundle without the key at any time with `npm run check:signed-helper -w @agentbridge/presence`.
If the keychain holds several Developer ID identities of the team, pick one with
`npm run sign:helper -w @agentbridge/presence -- --identity <sha1>` (`security find-identity -v -p codesigning` lists them).

A new signature from the same team and identifier keeps keychain access silent for users. Only a different team or
identifier, or a return to ad-hoc signing, would prompt again.

## Publish (owner only)

```bash
npm login
npm publish musi27-agentbridge-0.1.0.tgz --access public
```

Then publish the GitHub release draft; its body is already the committed release notes, so there is nothing to edit.
Publishing the exact tarball CI verified (rather than running `npm publish` in a checkout) keeps what users install
identical to what was tested.
