# @agentbridge/presence

macOS platform layer for the bridge. It implements the interfaces in
`packages/protocol/src/platform.ts`:

| Interface | Class | SPEC |
|---|---|---|
| `PresenceChecker` | `MacPresenceChecker` — LocalAuthentication `.deviceOwnerAuthentication` (Touch ID, falling back to the password) | §9.2 |
| `SecretStore` | `MacKeychainStore` (login keychain, one item for all secrets), `InMemorySecretStore` (tests) | §15.5 |
| `Notifier` | `OsascriptNotifier` — `osascript display notification` (also from the launchd agent) | §9.1 |
| `ServiceManager` | `LaunchdServiceManager` — `~/Library/LaunchAgents/live.musi.agentbridge.plist` | §14.1 |
| (agent panel) | `PanelAgent` — `~/Library/LaunchAgents/live.musi.agentbridge.panel.plist`, runs `AgentBridge panel` at login | — |

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

`native/build.sh` builds `bin/AgentBridge.app`, a background app bundle (dev and tests use this
ad-hoc signed build; releases ship the Developer ID-signed copy in `signed/`, see below):

- `Contents/MacOS/AgentBridge`: `native/main.swift`, `PanelModel.swift` and `PanelApp.swift` as one universal (arm64 +
  x86_64) binary
- `Contents/Info.plist`: copied from `native/Info.plist`. Bundle id `live.musi.agentbridge`, name
  "AgentBridge", `LSUIElement` (no Dock icon, no menu bar). It is a fixed file with no version
  stamped in, so the build's bytes only change when the code, plist or icon does.
- `Contents/Resources/AppIcon.icns`: the icon (direction "08 The gap", graphite)

The dev bundle is ad-hoc signed with the identifier `live.musi.agentbridge`. Because the
executable runs from inside the bundle, macOS dialogs name it **"AgentBridge"** and show its icon:
"AgentBridge is trying to ⟨reason⟩." The bridge always runs it by its full path
(`DEFAULT_HELPER_PATH`); it is never opened with `open` or LaunchServices. It also hosts the agent panel
(`AgentBridge panel`, below); notifications are meant to follow (docs/notifications.md).

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

**`panel` is the exception: long-running, argv options, no stdin request.** It is the agent panel's menu-bar dropdown
(`native/PanelApp.swift`, view model in `native/PanelModel.swift`) and the only path that starts AppKit; main.swift
hands `panel` off before the one-request guard, so the subcommands above behave exactly as before.

```
AgentBridge panel [--home <dir>] -- <node> [node args…] <cli entry>   # the menu-bar app (what PanelAgent's plist runs)
AgentBridge panel --print-model [--now <iso>] [--filter <text>]      # no UI: status snapshot on stdin → view model JSON
AgentBridge panel --snapshot-file <file.json>                        # the menu-bar app showing one saved snapshot
AgentBridge panel --render-png <out.png> --snapshot-file <f> [--tab agents] [--dark]   # draw it off-screen (screenshots)
```

The app runs `<node> <cli> status --watch --json` as a child and decodes one line per change
([docs/status-json.md](../../docs/status-json.md)), so the JSON shaping stays in TypeScript. It restarts the child with
backoff (1 s doubling to 30 s) when it exits, kills and restarts it after 45 s without a line (three missed
heartbeats), shows "agentbridge isn't running" for a `running: false` snapshot, and stops reading on a `schema` above 1
("Update agentbridge"). One panel per user (a lock in `$TMPDIR`); SIGTERM (launchd's bootout) stops the child and exits
0, so `KeepAlive {SuccessfulExit: false}` doesn't restart it. "Turn off menu-bar panel" runs `<cli> panel stop`.
Fixtures for 5 and 50 agents: `test/fixtures/panel-snapshots.ts` (run it with a folder to write them as JSON).

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

### Keychain item: one for all secrets

`MacKeychainStore` keeps every secret (`SECRET_NAMES`) in a single
generic password: service `agentbridge`, account `saved keys`, value a JSON map
`{"agentbridge_keys":1,"gen":<n>,"secrets":{name: value}}`. The helper labels it `agentbridge: saved keys`, and that
label is the name macOS shows in its access dialog ("AgentBridge wants to use your confidential information stored in
"agentbridge: saved keys" in your keychain") and in Keychain Access: the default access list created with the item
carries the label as its description, the text security dialogs use (`security dump-keychain -a` shows it). One item
means at most one dialog when macOS re-checks trust (a new signing team, an ad-hoc build), instead of one per secret.
The combining is done in TypeScript; the helper protocol is unchanged.

The item lives in the **legacy file-based login keychain**. The data-protection keychain was tested and is not
available: `SecItemAdd` with `kSecUseDataProtectionKeychain` fails with −34018 "A required entitlement isn't present"
for an ad-hoc binary, and fixing that needs a keychain-access-groups entitlement backed by a provisioning profile and
Team ID. The helper still sets `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, but **the file-based keychain does not
enforce it**. The item is readable whenever the login keychain is unlocked (normally the whole login session) and
travels with keychain backups. It is recorded only for a later move to the data-protection keychain.

**Writes are serialised and crash-safe.** The bridge service and CLI processes (init, uninstall) both write, so every
write is a read-modify-write under a lock file, `<agentbridge home>/run/keychain.lock` (O_EXCL; a lock whose process is
gone, or older than 15 minutes, is taken over). `keychain-set` is delete-then-add (below), so a crash between the two
would lose the item. Each write therefore saves the new version as a second item first (`saved keys (update in
progress)`), then replaces `saved keys`, then deletes the second item. Whoever next takes the lock finds a leftover
second item and finishes the write with it when its generation number is higher. A reader that finds `saved keys`
missing (mid-write) waits for the lock.

**Moving from one item per secret (0.2.6 and earlier).** Those releases saved each secret as its own item (account =
the secret name: identity keys, policy key, version and snapshot, three per Grok bot). `prepare()` (run by `init` and
at bridge start, before any read) reads the ones whose name the combined item lacks, writes the combined item, reads
it back to verify, and only then deletes the old items. Rule: **the combined item is authoritative for every name it
holds; an old item only fills a name it lacks, and is never read once the combined item holds its name** (only
deleted). So a move interrupted anywhere loses nothing, running it again is harmless, and an old item that trusts only
an older build (each read can ask for the login password) is read at most once: when `init` copies while an older
bridge still runs, the new bridge's start only deletes. `get` falls back to an old item only for a name the combined
item lacks and that did not fail before; `delete` removes the old item too.

**Failures don't stop the move or loop.** A read macOS refuses (Deny) or a delete it refuses (seen on the login
keychain for items whose partition list lacks the helper's team; on a throwaway keychain deletes by another build
always succeed) is skipped and remembered in `run/keychain-trust.json` with the helper build (cdhash) it failed on.
The same build does not try it again, so the bridge never asks on every start; the next release tries once more.
`init` retries refused reads (a person is there) and stops if one is still refused, with nothing lost. A dialog that
could not be shown (`errSecInteractionNotAllowed`, e.g. a locked keychain) is not remembered. `leftovers()` lists old
items still present (attributes only) for `agentbridge doctor`, which prints `security delete-generic-password -s
agentbridge -a <name>` for each.

**Warning before a dialog.** `prepare()` prints one line first when macOS is likely to ask: old items whose name the
combined item lacks are about to be read (only those are counted), or the combined item exists but the helper's code
identity differs from the one recorded after the last successful read (`run/keychain-trust.json`:
`team:<id>/<identifier>` for Developer ID, `cdhash:<hash>` for ad hoc, read with `codesign -d`). A trusted helper reads
the combined item first to count exactly; otherwise the count uses the names (never values) the combined item held last
time, from the same file. Existence is checked with `security find-generic-password` without `-g`, which reads
attributes only: no dialog, no value. The helper cannot read without UI today, so this predicts from the recorded
identity rather than asking the keychain. One false positive is known: 0.2.6 recorded no identity, so the first move
after it warns although nothing asks. At bridge start the line is also posted as a notification, since launchd has no
terminal.

**`keychain-set` is delete-then-add**, never an in-place update. Each write gets a fresh ACL
naming the helper and fresh attributes, and an item pre-created by another process (with an ACL
trusting itself) cannot capture the secret. This is tested by pre-seeding a foreign item with
`security add-generic-password`. The cost: the write is not atomic, hence the update item above.

The item ACL trusts the designated requirement of the binary that created it. With an
ad-hoc signature, that is the bundle's cdhash (the identifier is not part of it), so
**after a change to the helper's code, Info.plist or icon, the first read shows a
macOS "AgentBridge wants to use your confidential information" prompt**. Release builds are Developer ID-signed: their
requirement is Apple anchor + identifier + Team ID, so updates read silently (see
[docs/release-signing.md](../../docs/release-signing.md)). The dev build in `bin/` is still ad hoc, so running it
against your real keychain prompts.

**Proof with a throwaway keychain** (owner's Mac, needs the Developer ID identity):
`node --conditions=agentbridge-source packages/presence/scripts/keychain-proof.ts` builds probes of `main.swift` that
use a throwaway keychain file, with dialogs disallowed, and checks the move, a read by a second Developer ID build,
and a move killed after every helper call. `--show-dialog` ends by showing the real dialog (click Deny).

### Notifications

**Notifications:** title, body and subtitle are passed to `osascript` as argv items **after `--`**
and read with `item N of argv`. The AppleScript source is a constant. Quotes, backslashes and
`" & do shell script "…` are inert because the text is never parsed as source. A leading `-e` /
`-l` is inert because of the `--`: without it, osascript keeps parsing options until the first
non-option, so a title of `-e` would make the body a script line (`property p : (do shell script
…)` ran in review). Both cases have regression tests. Notification text is not secret, so argv is
fine here. Control characters are
stripped and lengths are capped. Tests round-trip hostile strings through the real `osascript`
and compile the scripts with `osacompile`.

## Building and signing

`native/build.sh` (`npm run build:helper -w @agentbridge/presence`) takes about 6 s. Tests call it
with `--if-missing`, so `npm run check` builds the ad-hoc dev helper on demand into `bin/`, which
is gitignored. No key is needed for anything in `npm run check`.

Releases ship **`signed/AgentBridge.app`, which is committed**: the same build, signed by the owner
on their Mac with the project's Developer ID Application certificate (Team ID `67B9AY2VHJ`,
hardened runtime, secure timestamp), with `signed/manifest.json` recording the hashes of the
sources it was built from:

```bash
npm run sign:helper -w @agentbridge/presence          # owner only: build, sign, replace signed/
npm run check:signed-helper -w @agentbridge/presence  # anyone: check signed/ (no key needed)
```

The key never leaves the owner's keychain and CI never signs. Release packing copies `signed/`
as is and refuses it if `native/main.swift`, `Info.plist`, `AppIcon.icns` or `build.sh` changed
since the signing. So a change to the helper sources needs a re-sign before the next release
([docs/releasing.md](../../docs/releasing.md#re-signing-the-helper)). `npm run check` only prints
a diagnostic for that, so contributors can still change the helper.

Committing the signed bundle trades some reviewability (a binary in git) for keeping the key off
CI. The Swift source stays the reference: anyone can rebuild it with `build.sh` and compare its
behaviour, and the manifest ties the binary to the source hashes it came from. The runtime always
runs `<package>/bin/AgentBridge.app` (`DEFAULT_HELPER_PATH`): the signed copy in the npm package,
the ad-hoc build in a checkout. Notarisation is not done (npm installs aren't quarantined); a
standalone download would need it ([docs/release-signing.md](../../docs/release-signing.md)).

## Tests

`npm run check` at the repo root covers:

- error-code mapping, request/response parsing
- presence checker against a stub helper (argv/stdin/env assertions, timeout, crash, serialisation)
- real-helper protocol errors, universal-arch check
- the committed `signed/AgentBridge.app`: Developer ID signature of team `67B9AY2VHJ`, hardened
  runtime, timestamp, designated requirement, manifest match (a source change is a diagnostic only)
- plist generation (`plutil`)
- AppleScript argv safety
- keychain store against the real login keychain under a unique throwaway service, always cleaned
  up; skipped when `CI=true`
- the one-item store against a fake keychain with per-item access lists (`test/fake-keychain.ts`): the move from one
  item per secret, a move or write killed at every step, concurrent writers in one process and in separate processes,
  and when the warning is printed

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
