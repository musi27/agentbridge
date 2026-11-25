# @agentbridge/presence

macOS platform layer for the bridge. It implements the interfaces in
`packages/protocol/src/platform.ts`:

| Interface | Class | SPEC |
|---|---|---|
| `PresenceChecker` | `MacPresenceChecker` — LocalAuthentication `.deviceOwnerAuthentication` (Touch ID, falling back to the password) | §9.2 |
| `SecretStore` | `MacKeychainStore` (login keychain), `InMemorySecretStore` (tests) | §15.5 |
| `Notifier` | `OsascriptNotifier` — `osascript display notification` (also from the launchd agent) | §9.1 |
| `ServiceManager` | `LaunchdServiceManager` — `~/Library/LaunchAgents/live.musi.agentbridge.plist` | §14.1 |

## Entry points for the bridge

`packages/bridge` loads these factories:

- `createSecretStore()` and `createPresenceChecker()` first run `verifyHelper()`, which checks
  that the helper exists and answers `version` with protocol 1. If not, they throw
  `HelperMissingError`: "AgentBridge helper missing at … ; run the build: npm run build:helper -w
  @agentbridge/presence". `doctor` can show this message as is.
- `createNotifier({ launchd?: 'show' | 'defer' })` returns the osascript notifier. It **posts in
  every context, including the launchd agent** (default `'show'`; the re-probe below showed the
  banners). It rejects only when osascript fails (non-zero exit or timeout), and the bridge then
  keeps the popup unshown for the next CLI call (§9.1). Exit 0 does not prove a banner was seen, so
  the bridge also keeps **must-act** popups for the next `agentbridge status`:
  - approval needed / expired
  - queue expired
  - Grok delivery failed
  - policy tampered
  - Claude session unreachable
  - relay disconnected (M2)
  
  `launchd: 'defer'` is an opt-out: under launchd it throws instead of posting. Guaranteed
  delivery and attribution come later with the `AgentBridge.app` design in
  [docs/notifications.md](../../docs/notifications.md).

Package exports carry the repo-wide `agentbridge-source` condition, which points at
`src/index.ts`. Tests run with `node --conditions=agentbridge-source`.

## The native helper: `AgentBridge.app`

`native/build.sh` builds `bin/AgentBridge.app`, a background app bundle:

- `Contents/MacOS/AgentBridge`: `native/main.swift` as one universal (arm64 + x86_64) binary
- `Contents/Info.plist`: copied from `native/Info.plist`. Bundle id `live.musi.agentbridge`, name
  "AgentBridge", `LSUIElement` (no Dock icon, no menu bar). It is a fixed file with no version
  stamped in, so the ad-hoc cdhash only changes when the code, plist or icon does.
- `Contents/Resources/AppIcon.icns`: the icon (direction "08 The gap", graphite)

The whole bundle is ad-hoc signed with the identifier `live.musi.agentbridge`. Because the
executable runs from inside the bundle, macOS dialogs name it **"AgentBridge"** and show its icon:
"AgentBridge is trying to ⟨reason⟩." The bridge always runs it by its full path
(`DEFAULT_HELPER_PATH`); it is never opened with `open` or LaunchServices. Later the same bundle is
meant to host notifications (docs/notifications.md) and the agent panel.

`AppIcon.icns` is committed. To regenerate it from the 1024 px master PNG:

```bash
mkdir AppIcon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out AppIcon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon-1024.png --out AppIcon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns AppIcon.iconset -o native/AppIcon.icns
```

Each call works like this:

```
AgentBridge <subcommand>          # argv carries only the subcommand
stdin:  one JSON object           # e.g. {"service":"agentbridge","account":"bot.r.token","value":"…"}
stdout: one JSON line             # {"ok":true,…} | {"ok":false,…}
exit:   0 = a response was written (even ok:false); 2 = usage or protocol error
```

| Subcommand | Request | Response |
|---|---|---|
| `presence` | `reason`, `timeout_ms`? (1–600000, default 120000) | `ok`, or `la_code` + `detail` + `stage` (`can_evaluate` \| `evaluate` \| `timeout`) |
| `keychain-get` | `account`, `service`? | `value` (string or `null`) |
| `keychain-set` | `account`, `value`, `service`? | `ok` |
| `keychain-delete` | `account`, `service`? | `deleted` (idempotent) |

**The keychain service is fixed to `agentbridge`.** `service` may only name a throwaway test
service `agentbridge.test.<suffix>`; anything else is a `bad_request`. So this trusted binary
cannot be used to read other apps' items.
| `version` | — | `version`, `protocol` |

**Secrets never appear in argv or env.** Values travel only over stdin and stdout. The Node side
also starts the helper with a minimal env (`PATH` only). The helper never writes to stderr.

**LAError → result code** mapping lives in TypeScript (`src/protocol.ts`), where it is tested:

| LAError | Code |
|---|---|
| −2 userCancel | `cancelled` |
| −1 authenticationFailed | `failed` |
| −4 systemCancel | `system_cancel` |
| −5 passcodeNotSet, −6 biometryNotAvailable, −7 biometryNotEnrolled, −8 biometryLockout, −11 watch/companion not available, −12 biometryNotPaired, −13 biometryDisconnected, −1004 notInteractive | `unavailable` |
| `stage: "timeout"`, anything else, a crash, garbage output | `error` |

**Timeout:** the helper enforces `timeout_ms` itself. It calls `LAContext.invalidate()`, which
closes the dialog, and answers `stage: "timeout"`. As a backstop, Node sends SIGTERM 5 s later,
then SIGKILL after another 2 s.

`presenceMessage()` turns each result into a distinct CLI message. Presence checks are
serialised, so only one OS dialog shows at a time.

**Keychain items:** generic passwords; service `agentbridge`; account = the secret name
(`SECRET_NAMES`). They live in the **legacy file-based login keychain**. The data-protection
keychain was tested and is not available: `SecItemAdd` with `kSecUseDataProtectionKeychain`
fails with −34018 "A required entitlement isn't present" for an ad-hoc binary, and fixing that
needs a keychain-access-groups entitlement backed by a provisioning profile and Team ID. The
helper still sets `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, but **the file-based keychain
does not enforce it**. Items are readable whenever the login keychain is unlocked (normally the
whole login session) and travel with keychain backups. It is recorded only for a later move to
the data-protection keychain.

**`keychain-set` is delete-then-add**, never an in-place update. Each write gets a fresh ACL
naming the helper and fresh attributes, and an item pre-created by another process (with an ACL
trusting itself) cannot capture the secret. This is tested by pre-seeding a foreign item with
`security add-generic-password`. The cost: the write is not atomic. A crash between delete and
add loses the old value.

The item ACL trusts the binary that created it. With an
ad-hoc signature, that identity is the bundle's cdhash (the identifier is not part of it), so
**after a change to the helper's code, Info.plist or icon, the first access to each item shows a
macOS "AgentBridge wants to use your confidential information" prompt**. Moving from the bare
`agentbridge-helper` into `AgentBridge.app` was one such change; a copy of the same build at
another path is not. A Developer ID signature fixes this (see
[docs/release-signing.md](../../docs/release-signing.md)).

**Notifications:** title, body and subtitle are passed to `osascript` as argv items **after `--`**
and read with `item N of argv`. The AppleScript source is a constant. Quotes, backslashes and
`" & do shell script "…` are inert because the text is never parsed as source. A leading `-e` /
`-l` is inert because of the `--`: without it, osascript keeps parsing options until the first
non-option, so a title of `-e` would make the body a script line (`property p : (do shell script
…)` ran in review). Both cases have regression tests. Notification text is not secret, so argv is
fine here. Control characters are
stripped and lengths are capped. Tests round-trip hostile strings through the real `osascript`
and compile the scripts with `osacompile`.

## Building: why the binary is not committed

`native/build.sh` (`npm run build:helper -w @agentbridge/presence`) takes about 6 s. Tests call it
with `--if-missing`, so `npm run check` builds the helper on demand (CI is macOS with Xcode).
`bin/` is gitignored. The binary is small (≈ 200 KB universal) and deterministic for a given
toolchain (two builds gave the same SHA-1), but it is not committed because:

1. It is reproducible only with an identical Swift toolchain. Every contributor's rebuild would
   churn a binary in git history.
2. The committed ad-hoc binary would not be the shipped artefact. Release binaries must be
   re-signed with Developer ID and notarised (docs/release-signing.md).
3. A committed binary that handles Touch ID and the keychain is opaque to review. Building from
   the 150-line Swift source keeps what runs auditable.

End users never need Swift. The npm release tarball ships a prebuilt, ad-hoc signed
`bin/AgentBridge.app` (`files` includes `bin`); Developer ID signing and notarisation come later
(TODO item 10).

## Tests

`npm run check` at the repo root covers:

- error-code mapping, request/response parsing
- presence checker against a stub helper (argv/stdin/env assertions, timeout, crash, serialisation)
- real-helper protocol errors, universal-arch check
- plist generation (`plutil`)
- AppleScript argv safety
- keychain store against the real login keychain under a unique throwaway service, always cleaned
  up; skipped when `CI=true`

Tests never touch `~/Library/LaunchAgents` or the `agentbridge` keychain service, and never pop a
Touch ID dialog.

## launchd context: does it work from a launchd agent? (answered 2026-11-22)

Opt-in manual probe:

```bash
npm run launchd-probe -w @agentbridge/presence
```

```bash
npm run launchd-probe -w @agentbridge/presence -- --notify-only
```

It installs a throwaway agent `live.musi.agentbridge.probe` through `LaunchdServiceManager`. The
plist is in a temp dir, not `~/Library/LaunchAgents`. The job (`scripts/launchd-probe-job.ts`)
does the following, prints the result, then boots the job out and deletes it:

1. posts a notification
2. runs a keychain round trip under a throwaway `agentbridge.test.probe-*` service
3. runs a presence check (approve it)
4. runs a presence check with a 4 s helper-enforced timeout (leave it alone)

With `--notify-only` it posts one notification after 5 s and nothing else.

**Results (macOS 26.6, Apple Silicon, MacBook Air with Touch ID, Node 25.9, ad-hoc helper; owner present; 5 runs):**

- **Context confirmed as launchd:** ppid 1, no TTY, `XPC_SERVICE_NAME = live.musi.agentbridge.probe`,
  `PATH` from the plist.
- **Presence: works.** `{ok:true}` on every approved run (1.9–55 s). The dialog read
  **"agentbridge-helper is trying to ⟨reason⟩."** (owner screenshot), so **reasons must be verb
  phrases**. Since `AgentBridge.app` it reads "AgentBridge is trying to ⟨reason⟩." with the icon.
- **Helper-enforced timeout: works.** `stage: "timeout"` after 4.04 s from launchd and 4.08 s
  from a shell. The owner confirmed the dialog closed by itself.
- **Keychain round trip: works** (set/get/delete) from launchd, with no prompt.
- **Notifications: work from launchd; delivery isn't confirmable.**
  - **Runs 1–2:** the banner was posted immediately before a Touch ID dialog. The owner noticed
    only the dialog.
  - **Re-probe, `--notify-only`:** launchd job (ppid 1, `XPC_SERVICE_NAME` = probe label), 5 s
    delay, no Touch ID panel. The owner saw "agentbridge probe-8168".
  - **Baseline:** a few seconds later, an osascript banner from a Claude-app shell. The owner saw
    it too.
  - **Full run 5:** banner then Touch ID. The owner saw "agentbridge probe-5612".
  - **Every run:** osascript exit 0, nothing on stderr.
  - **Notification Center history:** couldn't be read programmatically. The usernoted database is
    TCC-protected ("Operation not permitted"). The owner checked on screen and confirmed receiving
    both re-probe notifications.
  - **Script Editor permission:** "Script Editor" is listed in System Settings → Notifications;
    the owner confirmed it, and banners appear. Its per-app flags couldn't be read
    (`com.apple.ncprefs` isn't visible to this process). No Focus mode was reported.
  - **Decision (integrator):** `createNotifier()` posts under launchd by default, and the bridge
    keeps must-act popups for the CLI as well. Full table and future design:
    [docs/notifications.md](../../docs/notifications.md).
- The job was removed each time (`launchctl print` → not found).
- `status()` can read `stopped` right after `bootstrap`, while the job is spawning. `doctor`
  should poll briefly.

## End to end with the real bridge (2026-11-22, after rebasing onto PR #1)

Setup:
- `agentbridge serve` from `packages/bridge` with a temp `AGENTBRIDGE_HOME`
- no `AGENTBRIDGE_DEV_SECRETS`
- `AGENTBRIDGE_KEYCHAIN_SERVICE=agentbridge.test.e2e-…`, a test-only override that
  `createSecretStore()` and the helper accept only as `agentbridge.test.<suffix>`

Results:
- **Startup:** the log said `platform: @agentbridge/presence`. `policy.hmac_key`,
  `policy.version` and `policy.snapshot` were written to the throwaway keychain service, and the
  production `agentbridge` service was untouched.
- **`config get` (unprivileged):** no prompt.
- **`config set limits.turns 31`, owner approved Touch ID:** exit 0, policy v1 → v2.
- **`config set limits.turns 32`, owner cancelled:** exit 1, `unauthenticated: user presence
  check failed (cancelled: Authentication canceled.)`. Policy stayed at v2, and a
  `presence_failed {code: cancelled}` event was logged.
- **Cleanup:** the bridge was stopped with SIGTERM, the keychain items deleted, and the temp home
  removed.

Follow-up done in the same PR: the run showed the bridge's reason rendering as
"agentbridge-helper is trying to agentbridge: change setting limits.turns." `presenceReason()` in
`packages/bridge/src/ipc/cli-methods.ts` now builds lowercase verb phrases with no prefix. Since
`AgentBridge.app` the dialog already names the app, so reasons don't repeat it: "AgentBridge is
trying to change its setting limits.turns." A test checks every privileged method.
