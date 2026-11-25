# Release signing plan for `AgentBridge.app` (the helper)

Status: **plan only**. Nothing is signed yet. Builds, including releases, are ad-hoc signed by
`packages/presence/native/build.sh`.

Since TODO item 15 the helper is the executable of a background app bundle,
`bin/AgentBridge.app` (`live.musi.agentbridge`, `LSUIElement`), so the Touch ID and keychain
dialogs say "AgentBridge" and show its icon. Before that it was a bare `bin/agentbridge-helper`
with the identifier `live.musi.agentbridge.helper`. The steps below are for the bundle.

## What a release build needs

1. **Apple Developer Program membership** (individual or organisation) and a **Developer ID
   Application** certificate in the release machine's keychain, or in CI as a base64 `.p12` secret
   imported into a temporary keychain.
2. **Build** the bundle exactly as `build.sh` does (`swiftc -O`, arm64 + x86_64,
   `lipo -create`, the fixed `native/Info.plist` and `native/AppIcon.icns`). Pin the Xcode version
   in CI so builds stay comparable.
3. **Sign** the bundle with hardened runtime and a secure timestamp, keeping the stable identifier
   (it has a single executable and no nested code, so one `codesign` covers it):
   ```bash
   codesign --force --options runtime --timestamp \
     --identifier live.musi.agentbridge \
     --sign "Developer ID Application: <Name> (<TEAMID>)" bin/AgentBridge.app
   ```
   No entitlements are needed. LocalAuthentication and the legacy login keychain both work under
   the hardened runtime without entitlements. Do not add `keychain-access-groups`: that would move
   items to the data-protection keychain, which needs a provisioning profile.
4. **Notarise** a zip of the bundle with `notarytool`:
   ```bash
   ditto -c -k --keepParent bin/AgentBridge.app helper.zip
   xcrun notarytool submit helper.zip --keychain-profile agentbridge-notary --wait
   xcrun notarytool log <submission-id> --keychain-profile agentbridge-notary   # on failure
   ```
   The credentials are an App Store Connect API key (preferred for CI) or an app-specific
   password, stored with `notarytool store-credentials`.
5. **Staple:** `xcrun stapler staple bin/AgentBridge.app`, then `xcrun stapler validate`.
   Gatekeeper then passes offline even if the bundle is quarantined. (The old bare helper could
   not be stapled.)
6. **Verify** before publishing:
   ```bash
   codesign --verify --strict --verbose=2 bin/AgentBridge.app
   codesign -dv bin/AgentBridge.app 2>&1 | grep -E 'Identifier|TeamIdentifier|flags=.*runtime'
   spctl --assess --type execute -vv bin/AgentBridge.app   # "source=Notarized Developer ID"
   ```
7. **Publish:** the signed bundle goes into the npm tarball (`files` includes `bin/`). Record its
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
  requirement*. Ad-hoc: DR = cdhash only (the identifier is not part of it), so every change to
  the bundle's code, Info.plist or icon makes macOS ask "AgentBridge wants to use your
  confidential information…" for each item on first access. Developer ID: DR =
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
don't prompt again.

## Ad-hoc `AgentBridge.app` and the keychain (checked 2026-11-25)

Tested with a throwaway keychain file and a test program making the helper's calls:

- An item created by an ad-hoc binary is read silently by the **same cdhash** at another path or
  under another file name, and by an identical rebuild.
- The same code inside an app bundle, **with the old identifier or the new one**, has a different
  cdhash, and macOS shows "AgentBridge wants to use your confidential information stored in …".
  Keeping `live.musi.agentbridge.helper` would not have avoided the prompt, so the bundle uses its
  bundle id as the identifier.

So the first release with `AgentBridge.app` prompts once per keychain item (identity keys, policy
key/version/snapshot, three per Grok bot). Enter the login password and choose **Always Allow**.
There were no other users to migrate, so no rewrite step was built. Later releases prompt again
only if the bundle's cdhash changes: `native/Info.plist` is a fixed file (no version stamped in)
for that reason, and the Swift build is deterministic for a given toolchain, but a new Xcode on
the `macos-latest` release runner can change it.

- **Permissions:** notification permission (when the app posts notifications,
  docs/notifications.md) is tied to the bundle id and signature, so it has the same weakness
  under ad-hoc signing. Developer ID fixes both (TODO item 10).

## Fallback if the release is unsigned

If there is no Developer ID at release time:

1. Ship the ad-hoc-signed bundle (as built by `build.sh`), or let `npm install` build it from
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
