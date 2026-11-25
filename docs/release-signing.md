# Release signing for `AgentBridge.app` (the helper)

Releases ship `AgentBridge.app` (`live.musi.agentbridge`, `LSUIElement`), the presence and keychain helper, signed
with the project's **Developer ID Application** certificate (Team ID `67B9AY2VHJ`). Dev builds and tests keep an
ad-hoc signed copy. This page describes what is built, why, and the one-time keychain prompts the switch causes.
For the steps of a release, see [releasing.md](releasing.md#re-signing-the-helper).

## How it works

- **The key stays on the owner's Mac.** The certificate and its private key live in the owner's login keychain and
  are never exported, copied into CI or committed. It is a certificate used only for agentbridge, so revoking it never
  affects another app, and the other way round.
- **The owner signs locally**: `npm run sign:helper -w @agentbridge/presence`
  ([`packages/presence/scripts/sign-helper.ts`](../packages/presence/scripts/sign-helper.ts)). It
  1. finds the "Developer ID Application" identity of team `67B9AY2VHJ` in the keychain and refers to it by its
     SHA-1 (the certificate's name is never typed or printed);
  2. builds the universal bundle with `native/build.sh --out <tmp> --identity <sha1>`: the same build as dev, signed
     with `codesign --force --options runtime --timestamp --identifier live.musi.agentbridge`;
  3. checks the new signature (below), then replaces
     [`packages/presence/signed/AgentBridge.app`](../packages/presence/signed) and writes
     `signed/manifest.json`: the SHA-256 of each helper source (`native/main.swift`, `native/Info.plist`,
     `native/AppIcon.icns`, `native/build.sh`) and of all of them together, the bundle's cdhash per architecture,
     the Team ID, the identifier, the `swiftc` version and the signing time.
- **The signed bundle is committed.** `.gitattributes` marks it `binary`, so git never converts the line endings of
  the sealed `Info.plist`. Git keeps the bytes and the executable bit, which is all the signature needs.
- **Release CI packs it as is** and never sees the key. `npm run check:signed-helper -w @agentbridge/presence` (a step
  in [release.yml](../.github/workflows/release.yml)) and `packaging/npm/scripts/build.ts` both refuse a bundle that
  fails the signature checks, doesn't match its manifest, or was signed from older sources: "helper sources changed
  (…): re-sign on your Mac".
- **Signature checks** (`checkSignature` in
  [`signed-helper.ts`](../packages/presence/scripts/signed-helper.ts)), run on the committed bundle by a test in
  `npm run check`, before packing, and on the installed package by `packaging/npm/scripts/verify.ts`:
  - `codesign --verify --strict` passes (the seal over the executable, `Info.plist` and icon is intact);
  - not ad hoc, `TeamIdentifier=67B9AY2VHJ`, `Identifier=live.musi.agentbridge`;
  - hardened runtime flag and a secure timestamp;
  - it satisfies `anchor apple generic and identifier "live.musi.agentbridge" and certificate
    leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "67B9AY2VHJ"` (an Apple-issued
    Developer ID Application certificate of our team);
  - its **designated requirement** is `anchor apple generic` + that identifier + that team. This is what the keychain
    stores in each item's ACL, so it is what makes later updates silent.
- **Which bundle runs.** The runtime always runs `<package>/bin/AgentBridge.app/Contents/MacOS/AgentBridge`
  (`DEFAULT_HELPER_PATH`). In the npm package, `bin/` holds the signed bundle copied from `signed/`. In a checkout,
  `packages/presence/bin/` holds the ad-hoc build from `native/build.sh`, which tests build on demand, so contributors
  without the key can run `npm run check`.
- **No entitlements.** LocalAuthentication and the legacy login keychain work under the hardened runtime without any.
  Don't add `keychain-access-groups`: that would move items to the data-protection keychain, which needs a
  provisioning profile.

Changing the helper sources therefore means a re-sign before the next release. Contributors can change them freely;
`npm run check` only notes that the signed bundle is out of date, and the release refuses to pack until the owner
re-signs.

## Why Developer ID: the keychain

Items in the legacy login keychain trust the creating program's **designated requirement**:

- **Ad hoc**: the requirement is the cdhash only (the identifier is not part of it). Every change to the bundle's
  code, `Info.plist` or icon makes macOS ask "AgentBridge wants to use your confidential information stored in
  "agentbridge: <secret name>" in your keychain" once per item (the name is the item's label, see below). Upgrading
  to 0.2.5 (the first `AgentBridge.app`) showed about 7.
- **Developer ID**: the requirement is Apple anchor + identifier + Team ID, so any later build signed by the same team
  with the same identifier reads silently, whatever its code.

The same holds for user permissions tied to the app's identity (TCC), such as notifications from the planned agent
panel: with Developer ID they survive updates.

## Since then: one item, so at most one prompt

The release after 0.2.6 keeps all secrets in one item, `agentbridge: saved keys`, and moves the old items into it on
its first run, with no prompt for items the signed helper can already read (checked with a throwaway keychain, below).
Before a likely prompt `init` prints one line, and the bridge posts it as a notification. Details:
[the presence README](../packages/presence/README.md#keychain-item-one-for-all-secrets). The name in the dialog is the
item's label: the access list created with an item takes the label as its description, which is what security dialogs
show (`security dump-keychain -a` prints it). The helper sets the label to "agentbridge: <account>".

### Throwaway-keychain test of the one-item store

Checked 2026-11-25 on macOS 26 (Apple Silicon) with
[`packages/presence/scripts/keychain-proof.ts`](../packages/presence/scripts/keychain-proof.ts): probes of
`main.swift` that use a throwaway keychain file, signed ad hoc and with Developer ID twice (different code), with
dialogs disallowed (`SecKeychainSetUserInteractionAllowed(false)`), so a read that would ask fails instead.

| Step | Result |
|---|---|
| 11 old items (2 Grok bots) saved by Developer ID build 1; `prepare` with build 1 | copied 11, verified, deleted 11; one item `saved keys` left; **no dialog** |
| the same item read by Developer ID build 2 | **silent**; `prepare` prints no notice |
| control: ad-hoc build reads it | refused (−25293, would ask); `prepare` prints the notice first |
| old items from build 1 moved by build 2 | silent, all 11 read back by build 1 |
| move SIGKILLed after each of its 28 helper calls in turn, then build 2 runs | 28/28 recovered, all 11 secrets, old items gone |
| access-list description of the item | `agentbridge: saved keys` |

## Moving from ad hoc to Developer ID: one prompt per item, once

Items saved by an ad-hoc helper trust that build's cdhash. The first Developer ID helper is a different identity, so
macOS asks once per item: the identity keys, the policy key, version and snapshot, and three per Grok bot (about 7 on
a Mac with one bot). Enter the login password and choose **Always Allow**: the item's ACL then trusts the Developer ID
requirement, and later releases don't ask again. No migration step was built; the prompts are documented in the
release notes and [troubleshooting.md](troubleshooting.md#after-an-upgrade-macos-asks-to-use-the-agentbridge-keychain-items).

For the release notes of the first signed release:

> **One last round of keychain prompts.** The Touch ID and keychain helper (`AgentBridge.app`) is now signed with the
> project's Apple Developer ID. The first time it reads each saved secret, macOS asks "AgentBridge wants to use your
> confidential information stored in "agentbridge" in your keychain", once per item (about 7). Enter your login
> password and choose **Always Allow**. Future updates keep that access without asking.

### Throwaway-keychain test

Checked 2026-11-25 on macOS 26 (Apple Silicon) with a throwaway keychain file, never the login keychain. A probe
program made the helper's keychain calls (`SecItemAdd` with the default access list, which trusts the creating app;
`SecItemCopyMatching`) against that file. It was built into a bundle with the real `Info.plist` and icon and signed
three ways. "No UI" means `SecKeychainSetUserInteractionAllowed(false)`: a read that would show a dialog fails instead.

| Step | Build | Result |
|---|---|---|
| A | ad hoc, probe v1 | creates the item, reads it silently |
| B0 | Developer ID, probe v1 (new cdhash), no UI | refused: **would prompt** |
| C0 | Developer ID, probe v2, no UI, before B | refused: would prompt |
| B | Developer ID, probe v1, UI allowed | **one dialog** ("AgentBridge wants to use your confidential information…"); Always Allow → reads |
| B1 | Developer ID, probe v1 again, no UI | reads silently |
| C | Developer ID, **probe v2 (different code, different cdhash)**, no UI | **reads silently** |
| D | ad hoc, probe v2 (control), no UI | refused: would prompt |

After step B the item's access list holds two entries: the ad hoc build's `cdhash H"…"`, and the Developer ID
build's designated requirement, `identifier "live.musi.agentbridge" and anchor apple generic and … certificate
leaf[subject.OU] = "67B9AY2VHJ"`. Any later build from the same team and identifier satisfies the second entry. So
the move costs one prompt per item, and Developer ID updates after that cost none. Ad hoc builds (such as a
from-source `build.sh` build) still prompt.

## Notarisation: not now

The helper is not notarised. Gatekeeper only assesses files carrying the `com.apple.quarantine` attribute, which
browsers, Mail and AirDrop set, and **`npm install` does not** (Node fetches and extracts the tarball itself).
`verify.ts` checks the installed helper has no quarantine attribute. A browser-downloaded copy of the tarball would be
quarantined and blocked until notarised.

**A standalone distribution (a DMG or zip of the app, for example for the agent panel) would need notarisation**:
`ditto -c -k --keepParent AgentBridge.app helper.zip`, `xcrun notarytool submit helper.zip --keychain-profile <profile>
--wait`, then `xcrun stapler staple AgentBridge.app`, and `spctl --assess --type execute -vv` should say
"source=Notarized Developer ID". The hardened runtime and secure timestamp it requires are already in place.

## History: ad-hoc `AgentBridge.app` and the keychain (checked 2026-11-25)

Tested with a throwaway keychain file before Developer ID (TODO item 15):

- An item created by an ad-hoc binary is read silently by the **same cdhash** at another path or under another file
  name, and by an identical rebuild.
- The same code inside an app bundle, **with the old identifier or the new one**, has a different cdhash, and macOS
  prompts. So the bundle uses its bundle id as the identifier, which the Developer ID signature keeps.
