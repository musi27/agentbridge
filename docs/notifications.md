# Desktop notifications from the bridge service (§9.1): findings and proposal

Status: design note for **guaranteed delivery and attribution** (later). Today (M1),
`createNotifier()` posts osascript banners in every context, including the launchd agent. It
rejects only when osascript fails. The bridge also keeps must-act popups for the next
`agentbridge status`, because exit 0 does not prove a banner was seen. `launchd: 'defer'` is an
opt-out that throws under launchd instead.

## What we measured (2026-11-22, macOS 26.6, Apple Silicon, owner watching)

All runs used `npm run launchd-probe -w @agentbridge/presence`. The job was a real launchd agent
in `gui/501`: ppid 1, no TTY, `XPC_SERVICE_NAME = live.musi.agentbridge.probe`.

| Run | What was posted | osascript | Owner saw |
|---|---|---|---|
| 1, 2 (first session) | banner, immediately followed by a Touch ID dialog | exit 0 | only the Touch ID dialog; no banner noticed |
| 3 `--notify-only` | banner after a 5 s delay, no Touch ID | exit 0 | **banner shown** |
| 3b (baseline) | banner from a Claude-app shell | exit 0 | banner shown |
| 4, 5 (full) | banner, then Touch ID (+ keychain round trip, timeout dialog) | exit 0 | run 4 unsure; run 5 **banner shown** |

- **Script Editor permission:** "Script Editor" is listed in System Settings → Notifications on
  this Mac. osascript banners are attributed to it. Its per-app settings could not be read from
  a Claude Code session: `com.apple.ncprefs` is not visible, and the Notification Center
  database (`~/Library/Group Containers/group.com.apple.usernoted`) is TCC-protected
  ("Operation not permitted"). So we could not check Notification Center history programmatically.
- **Conclusion:** osascript notifications **do work from a launchd agent**. The first session's
  "no notification" was most likely the banner being hidden behind or overshadowed by the Touch
  ID panel posted right after it, not a launchd restriction.
- **What remains true:** `osascript display notification` exits 0 **whether or not anything is
  shown**. The banner is silently dropped if Script Editor's notifications are off, a Focus is on,
  or the first-use permission was never granted. That's why a resolved `notify()` cannot mean
  "the user saw it". So the bridge keeps must-act popups for the next CLI status as well.

## Problems with osascript as the long-term notifier

1. **No delivery or permission signal.** We cannot tell whether a banner was shown, and the
   bridge cannot ask for permission.
2. **Wrong identity.** Banners appear as "Script Editor" with its icon. Users must allow
   notifications for Script Editor, which means nothing to them, and turning it off for another
   reason silently kills agentbridge popups.
3. **No actions.** No "Approve" / "Open" buttons; clicking opens Script Editor.
4. The Touch ID dialog used to say "agentbridge-helper" with a generic exec icon. Fixed by the
   first step below: the helper now runs inside `AgentBridge.app`.

## Proposal: `AgentBridge.app`, a small background app bundle

**Status:** the bundle exists (TODO item 15): `bin/AgentBridge.app` in the npm package, built by
`packages/presence/native/build.sh`, hosting the presence and keychain helper. Releases ship it
Developer ID-signed (TODO item 10, [release-signing.md](release-signing.md)); dev builds are ad-hoc.
Notifications below are not built yet; osascript is still the notifier.

A minimal `LSUIElement` app (no Dock icon, no menu bar) that replaces osascript and, ideally,
also hosts the presence and keychain helper.

- **Bundle:** `AgentBridge.app`, `CFBundleIdentifier = live.musi.agentbridge`, `LSUIElement = YES`,
  installed under `~/.agentbridge/app/AgentBridge.app` (or inside the npm package).
- **Notifications** via `UNUserNotificationCenter`:
  - `requestAuthorization(options: [.alert, .sound])` once, during `agentbridge init`, while the
    user is at the terminal. `init` reports the outcome, and `doctor` reads
    `getNotificationSettings()` to say whether popups are allowed, off, or Focus-limited.
  - Categories with actions ("Open conversation", "Approve…"). An action only opens the CLI or
    Claude session; approval itself still needs presence (§9.2).
  - The app gets its own row in System Settings → Notifications as "AgentBridge".
- **IPC:** the bridge launches it per request (`open -g -a … --args <subcommand>`, or exec of
  `Contents/MacOS/AgentBridge`) with the same one-JSON-request-on-stdin protocol as
  the helper in the bundle today. Alternatively a tiny launchd-managed XPC service. Start with exec:
  it is what we have and it works from launchd.
  - `UNUserNotificationCenter` requires a bundle. Running the bundle's executable directly from
    the service works as long as it is inside a signed `.app` with a bundle id. Spike first.
- **Host the helper too:** move `presence` and `keychain-*` into the same executable. Then:
  - the Touch ID dialog names **"AgentBridge"** with our icon
  - keychain ACLs trust one signed identity
  - there is one artefact to sign and notarise instead of two
  
  Done for presence and keychain: no shim was kept, since nothing outside the package calls the helper.
- **Delivery semantics for the bridge:** `notify()` resolves only when
  `UNUserNotificationCenter.add` succeeds **and** settings say alerts are enabled. Otherwise it
  throws, and §9.1 falls back to the next CLI call. Still not proof of attention, but no longer
  silent.

### Signing and notarisation implications

- `UNUserNotificationCenter` and stable keychain ACLs both need a **real signature**. Ad-hoc
  bundles work for development, but authorisation and keychain trust reset whenever the cdhash
  changes.
- Release: sign the whole bundle with **Developer ID Application**, hardened runtime, secure
  timestamp (done since TODO item 10 for the single-executable bundle; nested code would be signed
  inside-out). For a standalone download (not npm), notarise a zip
  of the `.app` with `notarytool`. **Staple** the ticket to the `.app` (`xcrun stapler staple
  AgentBridge.app`). Unlike the bare helper, a bundle can be stapled, so Gatekeeper checks pass
  offline.
- Moving from the ad-hoc `agentbridge-helper` to the ad-hoc `AgentBridge.app` changed the
  keychain-trusted identity: existing items prompt once per item ("AgentBridge wants to use…").
  Moving to a Developer ID signature does it once more, and then no more on updates. keychain-set's delete-then-add re-creates
  an item with the new identity whenever a secret is rewritten. Details: release-signing.md.
- No entitlements are needed (no sandbox; LocalAuthentication, legacy keychain and notifications
  all work without them).
- See [release-signing.md](release-signing.md).

## Interim behaviour (adopted in M1)

osascript banners are shown from the service (`launchd: 'show'`, the default). The bridge treats
a must-act popup as **unconfirmed**: it shows it *and* keeps it for the next CLI status
(`MUST_ACT_POPUPS` in `packages/bridge/src/core/engine.ts`). Must-act popups are:
- approval needed / expired
- queue expired
- Grok delivery failed
- policy tampered
- session unreachable
- relay disconnected

Informational popups are only shown. A failed osascript call leaves any popup unshown. This
covers both outcomes until `AgentBridge.app` provides real delivery status.
