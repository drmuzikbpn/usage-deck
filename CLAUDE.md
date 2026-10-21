# Usage Deck — working notes

Nexus 5X Device Owner kiosk that streams Claude Code utilisation from N `claude-usage` daemons
over Tailscale and pauses/resumes sessions. The repository is public: see **Public repository**.

## Environment

Every Gradle call needs both:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
```

`local.properties` holds `sdk.dir=/opt/homebrew/share/android-commandlinetools` and is gitignored.

## Modules

| Path | What lives there |
| --- | --- |
| `core/` | Pure Kotlin/JVM. `model/`, `daemon/` (REST + SSE + `MachineClient` + `PinnedTls`/`Endpoints`/`BodyLimits`), `pairing/` (link + redeem), `pause/`, `alerts/`, `update/`, `Clock.kt`. No Android APIs. |
| `app/` | Android. `kiosk/`, `wifi/`, `pairing/`, `service/` (`DeckGraph`, `DeckService`), `settings/`, `update/`, `ui/` (`theme/`, `components/`, one package per screen). |
| `fakedaemon/` | Ktor server implementing the daemon contract with scripted scenarios: loopback HTTP, pinned HTTPS (`TlsFront`), `/v1/pair`. |

## Commands

```bash
./gradlew :core:test :fakedaemon:test :app:testDebugUnitTest   # JVM + Robolectric
./gradlew :app:assembleDebug
./gradlew ktlintFormat                                          # run before every commit

scripts/emulator.sh                                             # start/create the deck29 AVD
ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDebugAndroidTest
scripts/fakedaemon.sh warnCrossing                              # idle | warnCrossing | freeze | machineDrop | tokenRotated
scripts/pair-emulator.sh                                        # pairs the emulator's debug build with it
scripts/public-check.sh --self-test
```

The emulator shows **synthetic data only**: `scripts/fakedaemon.sh` serves pinned HTTPS on
loopback (the emulator reaches it as `10.0.2.2`; `BIND=0.0.0.0 ADDRS=<addr>` opts into the
network), prints a single-use `usagedeck://pair?...` link and a token generated for that run, and
`scripts/pair-emulator.sh` pushes the link to
`/sdcard/Android/data/com.evenseal.usagedeck/files/pairing-import.json`, which only a **debug**
build reads. It refuses a non-emulator serial. Never pair the emulator with a real daemon and never
print a real pairing link. `connectedDebugAndroidTest` wipes the pairing, so pair again afterwards.
Landscape is `adb -s emulator-5554 emu rotate`. Show UI changes there and wait for the owner's OK
before pushing a release. `scripts/emulator.sh` needs the SDK packages `emulator` and
`system-images;android-29;default;arm64-v8a` (`sdkmanager` installs them).

Android 11 check: an API 30 AVD (`deck30`, same Nexus 5X profile, image `system-images;android-30;default;arm64-v8a`)
ran the app and the full instrumented suite green (2026-09-15). On API 30 adb cannot write
`/sdcard/Android/data/<pkg>` (scoped storage), so sideload a link into the debug build with
`adb push link.txt /data/local/tmp/pi.json && adb shell run-as com.evenseal.usagedeck cp /data/local/tmp/pi.json files/pairing-import.json`.

A real Nexus 5X is often attached over USB alongside the emulator — **always set
`ANDROID_SERIAL`** (or `adb -s emulator-5554`) for anything adb or instrumented, and never
`pm uninstall`/`pm clear` the app on the phone (it would drop Device Owner). The phone runs
release-signed builds, which read no sideloaded pairing file: pair it by scanning the QR.

lefthook runs `scripts/public-check.sh`, `ktlintCheck` (which includes the licence-header check)
and `:core:test` on pre-commit. Install with `lefthook install` if the hook is missing. Never
`--no-verify`.

## Global Constraints

- Package `com.evenseal.usagedeck`. App name "Usage Deck". `minSdk 29`, `targetSdk 29`, `compileSdk 34`.
- Environment: `export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` before any `./gradlew`. `local.properties` holds `sdk.dir=/opt/homebrew/share/android-commandlinetools` and is gitignored.
- Build only on `limits[]` (daemon §23); never read `legacyWindows`. Headline ids: `"session"` (5 h) and `"weekly_all"` (7 d). `resetsAt` may be null → render "resets: unknown".
- `/v1/tokens` is the spend endpoint (not `/v1/spend`). `groupBy=project` returns `{ key, label, …counts }`, `label` = cwd.
- Pause `reason` is exactly `"usage-deck:<installId>"`. Only rules whose `reason` equals this phone's string ever escalate.
- Session and project pause scopes go to one machine. Only `all` fans out.
- Users are keyed by account **and** organisation (`accountUuid/organizationUuid`): team-plan limits are
  per org, and one account can sit in two orgs. Display names are the deck's own renames
  (`Settings.userNames`, Settings › Users) falling back to the daemon's `displayName`, then the e-mail's local part.
- Home lists rank by live rate, not by tokens: `core/model/ActivityOrder` (the iPhone app's rule) puts the
  busiest project first and the busiest session first inside it; the landscape dock ranks every session
  on its own. Rates are the ones the rows show (`DeckViewModel.rate`, 60 s) compared in bands of about
  33 %, so near-equal rows do not swap every tick. `TeamState.projects` (by live tokens) is only the tie order.
- Gesture grammar everywhere: tap = soft, hold 600 ms = hard, tap on paused = resume. Red styling only on hold actions.
- Aging: fresh < 30 s since heartbeat, stale < 120 s, dead ≥ 120 s. Dead disables pause controls.
- A machine that has not checked in for a day is **gone** (`Aging.GONE`, `MachineState.gone`):
  `aged(now)` forgets its readings on that tick (and `MachineClient` drops the sessions ETag) and
  `TeamState` leaves it out of users, projects and totals. It stays paired and listed (dead dot,
  "last heard 2d ago") and returns with its first check-in.
- Escalation default 90 s; range 30 s–600 s or off; persisted across process death.
- Self-update defers while a gesture is in progress, a hold is mid-press, or any escalation is pending.
- Version: `versionName = 0.MINOR.<commit-count>+<sha>`, `versionCode = commit-count`. Release repo `BuildConfig.RELEASE_REPO`, default `drmuzikbpn/usage-deck` (shared with the daemon): APK releases are tags `deck-<version>`, pre-release, assets `usage-deck.apk` + `usage-deck.apk.sha256`; the checker considers `deck-` tags only. CI signs with `apksigner` + `app/signing/usage-deck.lineage` (v3, rotated from the debug key the phone was provisioned with) so it updates in place; Gradle never signs release.
- Before `ApkInstaller` sees a download, `Updater` requires: size ≤ `MAX_APK_BYTES`, the release's sha256 (fetched first), and `ApkGate` (`PackageApkGate`/`ApkRules`: same package, higher `versionCode`, signer in the installed app's lineage or vice versa). A release that fails any of those, or fails to install (`InstallResultReceiver` included), goes into `UpdateSkips` and the periodic check leaves it alone until a newer release or Settings › Check now. A network failure is never a skip.
- A limit alert fires **once per window**. `Alert.window` is the limit's `resetsAt`, and `AlertLedger`
  (SharedPreferences `alerts`) remembers what has spoken across process death — a self-update must
  never re-announce a 7-day window that is already over the line. Dropping back under a threshold
  forgets the key so a real re-crossing still speaks. There is no perpetual critical repeat; it used
  to re-announce every 10 minutes, which meant a Monday crossing nagged until the reset.
- Every error shown to the user comes from the daemon envelope: `hint` → `message` → per-code default.
- A 401 `unauthorized` or a pin mismatch (`pinning`) from **any** request or the stream is a lost
  pairing, never a network blip: `MachineClient` sets `MachineState.needsRepair`, stops SSE and
  polling, drops the machine's sessions, keeps it DEAD (so pause controls are off) and probes a
  bearer-gated GET (`/v1/pause/rules`) once a minute. Every write of daemon data goes through
  `updateLive`, which drops it once the flag is set; `stop()` is final (no probe or stream after
  it). Home and the machine screen show an amber `RepairCard` ("<name> no longer accepts this
  deck" → Re-pair → `Route.Repair(id)`); that pairing calls `MachineStore.replace(id, …)`, so the
  same row is replaced even when both the certificate and the address changed, after a "Replace
  <old> with <new>?" confirmation if the QR names a different machine. Pause/resume go through
  `MachineClient.api` so their 401s count too. Before this a rotated token looked "connected":
  an open stream kept heartbeating, sessions stayed listed, and an account's health is the best of
  its machines.
- Pairing (daemon §23.45–§23.47): `claude-usage pair` is the **only** pairing. Its QR/link
  `usagedeck://pair?v=2&name&addrs&port&fp&code` carries no bearer; `core/pairing/PairingClient`
  redeems the single-use code with `POST /v1/pair` over HTTPS pinned by `core/daemon/PinnedTls`
  (SHA-256 of the leaf's SPKI must equal `fp`; host names are deliberately not checked). Never log
  or persist the code or the token. `InvitePairing` runs each redeem on the graph's scope, one per
  code; a redeem moves to the next address only when the request provably never left the phone
  (`neverSent`), otherwise it stops with `reply_lost`.
- **There is no plain-HTTP path to a daemon and none may be added.** `MachineConfig.baseUrlFor` is
  always https; `OkHttpDaemonApi` and `DaemonEventSource` throw if built for a config without `fp`;
  every client is `PinnedTls.client` (TLS-only `connectionSpecs`, no redirects) and `DeckGraph.http`
  is TLS-only too. The retired v1 JSON pairing (`claude-usage configure pairing`) is recognised by
  `PairingInvite.parse` only to refuse it. A stored row without `fp` is **kept, never contacted**:
  `MachineStore` scrubs its bearer on load, `MachineClient.retired` gives it `needsRepair` with
  code `legacy` (no stream, poll or probe; its API refuses every call), and `RepairCard` reads
  "<name> needs to be paired again … `claude-usage pair`". Re-pairing replaces that row in place.
- The manifest permits cleartext (`res/xml/network_security_config.xml`) only because the
  captive-portal WebView needs it and Android cannot scope it to one WebView. `NoCleartextTest`
  fails if any shipped source but `CaptivePortalActivity.PROBE_URL` names an `http://` URL or uses
  the platform HTTP stack. `PortalPolicy` keeps that WebView to http/https, without file/content
  access, mixed content or a JavaScript interface, and wipes it on destroy.
- `MachineStore.pair` replaces the same machine in place — same `fp`, same addr+port, or a retired
  row whose non-loopback addr is one of the new `addrs` — keeping that row's id (so escalations,
  alerts and burn history survive) and taking the daemon's current name. **Nothing replaces a
  machine unasked:** `PairingImports` holds a sideloaded link that `MachineStore.wouldReplace`
  matches until `ImportConfirmDialog` ("Replace <old> with <new>?") is answered, and pairs
  unconfirmed links with `mayReplace = false`; the pairing screen asks before a scan overwrites a
  machine pinned to another certificate.
- `pairing-import.json` (`PairingImport`): v2 link only; private `filesDir` always, external files
  dir **only when `BuildConfig.DEBUG`**; polled every 5 s while `MainActivity` is RESUMED (a
  foreground kiosk never resumes again); deleted before use and refused if it cannot be deleted.
- Everything read from a daemon is bounded by `BodyLimits` (REST, error and pair bodies; SSE line
  and event via `sseGuard`); a reply that is not the expected JSON is `bad_response`, never an
  escaping exception. Names pass `Labels.machineName` (control/format characters dropped, 64
  chars); a link keeps at most `PairingInvite.MAX_ADDRS` addresses.
- Secrets at rest: `encryptedPrefs` (`pairing/SecureStorage.kt`) **fails closed** — only a
  debuggable build falls back to plain prefs (Robolectric, emulator). In release it throws
  `SecureStorageException`; `UsageDeckApp.storageFailure` is then set, no graph is built,
  `DeckService` stops itself and `MainActivity` shows `StorageErrorScreen` (still locked).
  `allowBackup` is false and the extraction rules exclude every domain. Never log a parser
  exception from a store: its message quotes the stored JSON.
- Exit PIN (`kiosk/ExitPin`): optional — with none set the 3 s corner hold alone opens the
  maintenance window. `set` only while none exists; afterwards only `change(current, new)` or
  `clear(current)`, which go through `verify` so the attempt counter and lockout apply and are reset only by a
  verified PIN. PBKDF2-HMAC-SHA256; an old salted SHA-256 record is rewritten on the next correct
  entry. The lockout is timed on `Uptime` (elapsedRealtime + boot count), never the wall clock; a
  reboot restarts it in full. A Device Owner deck with no PIN shows `FirstPinDialog` at launch.
- `ManifestSurfaceTest` pins the merged manifest: only `MainActivity` and `DeviceAdminReceiver`
  are exported, no library activity rides along, and the permission list is exact. A dependency
  that adds a component needs a `tools:node="remove"` or a deliberate change to that test.
- Single dark theme, colours and fonts from spec §11.6. Tabular numerals everywhere.
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- Every `.kt`/`.kts` starts with the two-line SPDX header (`// SPDX-License-Identifier: MIT`, `// Copyright (c) 2026 Even Seal Productions`); `ktlintCheck` fails without it. Shell, YAML and XML carry it as a comment.
- No `TODO`/`FIXME` left in committed code. No test may be `@Ignore`d.

## Remote and pushing

This project lives on the orphan branch `usage-android` of `drmuzikbpn/usage-deck` (the
daemon's repo; renamed from `usage-deck` on 2026-10-01); the iPhone + Apple Watch app lives on
`usage-ios`. Do not `git push` without explicit approval in the session. CI (`.github/workflows/ci.yml`)
has a `test` job (pull requests and pushes; read-only token, no secrets) and a `release` job
(`needs: test`, pushes to `usage-android` only — never a wildcard, the daemon's release job runs on
`main` — in the `release-android` environment, `contents: write`) that signs with `apksigner` and publishes
a `deck-<version>` pre-release with `gh release create` once the signing secrets
(`SIGNING_KEYSTORE_B64`, `SIGNING_KEY_ALIAS`, `SIGNING_STORE_PASSWORD`, optional
`SIGNING_KEY_PASSWORD`) exist. Keep every `uses:` pinned to a full commit SHA with the version in
a trailing comment, never add `set -x` to a step that sees a secret, and keep third-party actions
out of `release`. `gradle-wrapper.properties` carries `distributionSha256Sum`: update it with the
Gradle version. Dependency verification is on (`gradle/verification-metadata.xml`, sha256): after any
dependency change regenerate it as its header says and keep the aapt2 `-linux` entry, or CI fails.

## Public repository

Everything committed here is published. `scripts/public-check.sh` (lefthook pre-commit, and CI on
a pull request's additions) blocks credentials, e-mail addresses off its allowlist, `/Users/<name>/`
and `/home/<name>/` paths, IPv4 addresses outside loopback / `10.0.2.2` / the RFC 5737
documentation ranges, carrier-grade-NAT (tailnet) addresses, `*.ts.net` names, and a git identity other than
`support@evensealproductions.com`. An untracked `.public-check.local` adds private literals.
In new tests and docs use `192.0.2.x`, `*.example.test` and made-up names; in prose say "the
owner", never a person's name; never write a serial number, a real host name or a secret.

## Gotchas

- `BurnHistory` is written on the SSE thread and read by Compose on main; every method locks and
  readers work on a snapshot. Dropping the lock crashes the kiosk with ConcurrentModificationException
  every few minutes on the real phone (it did, four times in half an hour).
- Daemons before 0.1.66 resume exactly the scope they are given; newer ones
  cascade a project resume and keep one rule per scope. The phone fans a project resume out to the
  session rules under it so both behave; resuming an already-lifted scope is a no-op.
  `PauseController.resume` calls the broad scope first and skips a child whose rule ids (or
  session id) the response already lists as removed/resumed. A resume that returns nothing for a
  scope the deck saw standing is reported as a failure (status chip), never as success.
- A session or project paused by a broader rule (`all`, or its project) shows
  `PauseVisual.Inherited` (↳, disabled): resuming the child scope would be a silent no-op. The
  bottom bar / rail reads "Resume all" whenever `all` stands, from rules or session pause scopes;
  polling fetches `/v1/pause/rules` too so this holds without SSE.
- Hard freeze (daemon §23.16, from the release after 0.1.65) stops only tool subprocesses and holds
  the next tool at the gate; `pause.frozenPids` never holds the session pid and an empty list under a
  hard rule is normal. `pause.freezes` ≥ 2 means re-frozen under a standing rule (rendered "frozen again ×N").
  On 0.1.65 and earlier the freeze SIGSTOPs the TUI itself; zsh shows "suspended (signal)" and needs `fg`.
- `STAY_ON_WHILE_PLUGGED_IN` only stops the screen turning off; Android still dims it after the
  inactivity timeout. `ScreenHold` keeps `FLAG_KEEP_SCREEN_ON` whenever the deck is on power (adaptive
  brightness still works), and on battery only when "Keep screen on" is set.
- A self-update kills the process and Android never restarts a HOME activity on its own; `LockTaskReceiver`
  relaunches the deck on `MY_PACKAGE_REPLACED`. The first unattended update (0.1.55) sat on the stock launcher without it.
- List rows animate with `animateItem` + `liftOnReorder(rowRank(project, row))`. Rank by project slot,
  never by a running row index: a running index makes every row below a fold or a new session "move"
  and blink.
- Run the instrumented suite with the emulator's *sensor* in portrait: `adb -s emulator-5554 emu sensor get acceleration`
  must read `0:9.81:0` (`emu rotate` cycles it). The launcher can look portrait while the test activity,
  which follows the sensor, opens landscape, and `WifiScreenTest` then fails because its fourth
  network row is below the fold.
- Two machines showing the *same* percentages **and the same reset instants** for different accounts
  is a daemon bug, not a deck one: before daemon 0.1.93 the access token was read once per process
  while the identity was re-read every 10 min, so after an account switch it kept polling the old
  account (its token still returned 200, so no 401 ever forced a re-read). Fixed upstream; the deck
  renders whatever each daemon reports.
- The wide dock's rings page per **account**, never per machine: machines sharing an account share
  one quota, so paging them would deal the same numbers twice. One account renders no pager at all.
- Compose: `Modifier.clickable` merges descendant semantics, so pause buttons inside a clickable
  row are only addressable with `useUnmergedTree = true`.
- Android 10 returns an **empty** wifi scan list without location permission rather than throwing.
  `KioskManager.applyPolicies()` grants `ACCESS_FINE_LOCATION` and `CAMERA` as Device Owner.
- Doze exemption is a one-tap dialog on first launch; Device Owner cannot write it on API 29.
- `fakedaemon` runs inside an Android process too (`FakeDaemonOnDeviceTest`: pairing, REST and the
  stream over its TLS front). Its `snapshot` frame must send `sessions` as a bare array like the
  real daemon; it once sent the `/v1/sessions` body, which the deck parsed as an unknown event.
- Ktor's CIO server cannot serve HTTPS, so the fake terminates TLS in `TlsFront` (plain JDK
  sockets) and pipes to a loopback CIO connector; only that connector may answer `/v1/pair`.
- Robolectric has no AndroidKeyStore, so `encryptedPrefs` always takes the debug fallback in unit
  tests; `SecureStorageTest` flips `SecureStorage.plaintextFallbackAllowed` to see release behaviour.

## Docs

`docs/device-setup.md` (flashing and provisioning), `docs/teammate-onboarding.md` (adding a Mac),
`docs/smoke-test.md` (manual checklist before a release), `SECURITY.md` (what is and is not
protected), `THIRD_PARTY_NOTICES.md` + `licenses/` (fonts and libraries).
