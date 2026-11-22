# Release signing plan for `agentbridge-helper`

Status: **plan only**. Nothing is signed yet. Development builds are ad-hoc signed by
`packages/presence/native/build.sh`.

## What a release build needs

1. **Apple Developer Program membership** (individual or organisation) and a **Developer ID
   Application** certificate in the release machine's keychain, or in CI as a base64 `.p12` secret
   imported into a temporary keychain.
2. **Build** the universal binary exactly as `build.sh` does (`swiftc -O`, arm64 + x86_64,
   `lipo -create`). Pin the Xcode version in CI so builds stay comparable.
3. **Sign** with hardened runtime and a secure timestamp, keeping the stable identifier:
   ```bash
   codesign --force --options runtime --timestamp \
     --identifier live.musi.agentbridge.helper \
     --sign "Developer ID Application: <Name> (<TEAMID>)" bin/agentbridge-helper
   ```
   No entitlements are needed. LocalAuthentication and the legacy login keychain both work under
   the hardened runtime without entitlements. Do not add `keychain-access-groups`: that would move
   items to the data-protection keychain, which needs a provisioning profile.
4. **Notarise** with `notarytool`. A bare Mach-O must be submitted inside a zip:
   ```bash
   ditto -c -k --keepParent bin/agentbridge-helper helper.zip
   xcrun notarytool submit helper.zip --keychain-profile agentbridge-notary --wait
   xcrun notarytool log <submission-id> --keychain-profile agentbridge-notary   # on failure
   ```
   The credentials are an App Store Connect API key (preferred for CI) or an app-specific
   password, stored with `notarytool store-credentials`.
5. **Stapling:** `stapler` cannot staple a bare Mach-O. It only staples bundles, `.dmg` and
   `.pkg`. A notarised standalone binary relies on Gatekeeper's **online** ticket lookup the first
   time it is assessed. That is fine for us (see quarantine below). If we ever ship a `.pkg` or
   `.dmg`, staple that.
6. **Verify** before publishing:
   ```bash
   codesign --verify --strict --verbose=2 bin/agentbridge-helper
   codesign -dv bin/agentbridge-helper 2>&1 | grep -E 'Identifier|TeamIdentifier|flags=.*runtime'
   spctl --assess --type execute -vv bin/agentbridge-helper   # "source=Notarized Developer ID"
   ```
7. **Publish:** the signed binary goes into the npm tarball (`files` includes `bin/`). Record its
   SHA-256 in the release notes, and have `agentbridge doctor` compare against it.

## Quarantine: is an npm-installed binary affected?

- Gatekeeper only assesses files that carry the `com.apple.quarantine` extended attribute. A
  browser, Mail, AirDrop and most GUI download tools set it.
- **`npm install` does not set it.** npm fetches tarballs with Node's HTTP stack and extracts them
  itself, and Node does not add quarantine attributes. So an npm-installed helper runs whether or
  not it is notarised. (Spot-check on each release: `xattr -l` on the installed binary should
  show no `com.apple.quarantine`.)
- It **is** quarantined if a user downloads the tarball or binary with a browser, or installs
  through a tool that propagates quarantine. Unsigned or un-notarised, it is then blocked
  ("cannot be opened because the developer cannot be verified"). Notarised, it runs.
- Apple Silicon requires every binary to be signed at least ad-hoc. Our build always signs, and
  npm leaves the signature intact.

So for the npm path, notarisation guards the less common install routes. **Developer ID signing
is the part that matters most, because of the keychain**, not Gatekeeper:

- **Keychain ACLs:** items in the legacy login keychain trust the creating binary's *designated
  requirement*. Ad-hoc: DR = cdhash, so every helper update makes macOS ask "agentbridge-helper
  wants to use your confidential information…" for each item on first access. Developer ID: DR =
  identifier + Team ID, so updates keep access silently.
- **TCC / user trust:** a stable signed identity keeps any future permission (for example
  notifications from a bundled app) tied to one identity across updates.

## Moving from ad-hoc to Developer ID re-prompts once

Existing keychain items created by the ad-hoc helper trust that binary's cdhash. The first
Developer ID-signed helper is a different identity, so macOS asks once per item ("… wants to use
your confidential information stored in 'agentbridge'"). To avoid that:

- on upgrade, have `init` / `doctor --fix` read each secret with the old helper and rewrite it
  with the new one; `keychain-set` is delete-then-add, so the new item trusts the signed identity;
- or document "choose Always Allow" for the one-time prompts.

After that, Developer ID updates keep the same designated requirement (identifier + Team ID) and
don't prompt again. The same applies when the helper moves into `AgentBridge.app`
(docs/notifications.md): one more identity change, one more rewrite.

## If the notifier becomes an app bundle

The proposed `AgentBridge.app` (`live.musi.agentbridge`, `LSUIElement`; docs/notifications.md)
changes the release steps:

- **Signing:** sign the bundle (nested code first) with Developer ID + hardened runtime +
  timestamp.
- **Notarisation:** notarise a zip of the `.app`.
- **Stapling now applies:** `xcrun stapler staple AgentBridge.app`, then `stapler validate`.
  Gatekeeper then passes offline even if the bundle is quarantined. This is the main difference
  from the bare helper, which cannot be stapled.
- **Verification:** `spctl --assess --type execute -vv AgentBridge.app` should report
  "Notarized Developer ID".
- **Permissions:** notification permission is tied to the bundle id and signature. Keep both
  stable across releases.

## Fallback if the release is unsigned

If there is no Developer ID at release time:

1. Ship the ad-hoc-signed binary (as built by `build.sh`), or let `npm install` build it from
   source when Xcode Command Line Tools are present (`build.sh` fails with a clear message when
   `swiftc` is missing).
2. Document the consequences in the README:
   - a keychain access prompt for each secret after every helper update (choose "Always Allow")
   - a Gatekeeper block if the binary was downloaded via a browser; fix with
     `xattr -d com.apple.quarantine <path>` after the user has checked the SHA-256
3. `doctor` reports "helper: ad-hoc signed (development)" so the state is visible.
4. The presence check itself is unaffected. M0 V5 and the M1 launchd probe both ran ad-hoc
   binaries successfully.

## CI sketch (later)

macOS job on tag push: import cert into a temp keychain → `build.sh` → `codesign` (above) →
`notarytool submit --wait` with an App Store Connect API key from secrets → verify → `npm publish`.
Signing secrets live only in a protected release environment, never in PR jobs.
