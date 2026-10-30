# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are `MAJOR.MINOR.<commit-count>+<sha>` (see `docs/api.md`).

## [Unreleased]

### Fixed (menu bar)
- One slow read no longer shows a red `Not answering`: the menu tries twice first (issue #97).

### Added (menu bar)
- `menubar --install` offers to start SwiftBar or xbar at login, so the menu bar item comes back
  after a restart. `--login-item` and `--no-login-item` answer without asking (§23.66).

### Fixed (limits)
- A new week no longer leaves an old scoped limit on show. If the usage endpoint is failing and
  the status line shows a different weekly window, rows only the endpoint can update (such as
  Fable) read as unknown until it answers again (§23.67).

### Security
- **Every request needs the bearer token, from this machine too.** The loopback `GET` and
  hook `POST` exemptions are gone; the hook, status line, MCP server and CLI read the token
  from `config.json`. Without a token `GET /health` answers `{"ok":true}` only. A request a
  web page started (`Origin`, or `Sec-Fetch-Site` other than `none`) is refused (§23.55).
- Local clients make the listener prove it holds the token (an HMAC challenge on
  `/health`) before sending it, and ignore a stale `daemon.json` (§23.61).
- Session registration is bounded: UUID ids only, checked paths and strings, at most 256
  sessions, pids accepted only for Claude Code processes of the same user and re-verified
  by start time and boot id before any signal; freezes are recorded before the first
  `SIGSTOP`, never touch the daemon or its parents, and a crash thaws everything (§23.56).
- **HTTPS only off the machine**: plain HTTP is served on loopback alone; wildcard and public
  `bind` addresses are refused unless `allowPublicBind: true`; the `tailscale` keyword is
  range- and interface-checked (§23.57).
- **`configure pairing` is removed** — its QR code carried the bearer. Use `claude-usage pair`.
  An abandoned pairing code is revoked (`DELETE /v1/pair/code`) (§23.57, §23.63).
- **Signed releases**: the updater requires `SHA256SUMS.sig`, an Ed25519 signature checked
  against keys compiled into the daemon, before it trusts a checksum; dependencies install
  with `npm ci` from the shrinkwrap inside the signed tarball; the archive is checked for
  unsafe members (§23.59, §23.60).
- The release workflow builds with a read-only token and signs in a separate `release-daemon`
  environment job, restricted to `main`; every action is pinned to a commit SHA; nothing is published to npm and
  the package is `private`.
- `configure rotate-token` also reaches a daemon run in the foreground, and says so plainly if
  it did not take (§23.58).
- `claude-usage config` no longer prints the token; JSON errors no longer quote the file;
  system programs run by absolute path; unit files and hook commands are quoted (§23.60,
  §23.62).
- A commit-time `scripts/public-check.sh` (also run on pull requests) blocks credentials and
  private data.

### Fixed
- After a plan upgrade, `weekly_all` stayed at the old plan's percentage until the weekly
  reset: the daemon refused any lower reading inside a window. `observe` now sends the
  session id, and a session whose own reading changed is believed in either direction,
  including a new week that resets earlier than the old one (§23.64, §23.65).
- An auto-update could leave the daemon stopped on macOS: the restart is a `launchctl
  kickstart -k` issued from inside the job being restarted. A detached watchdog now relaunches
  the job if no process is running within 90 s (§23.50). If a Mac is down after updating to
  0.1.107, run `launchctl kickstart gui/$(id -u)/com.github.drmuzikbpn.claude-usage`.

### Added
- **macOS menu-bar item.** `claude-usage menubar --install` adds a [SwiftBar](https://swiftbar.app)
  plugin that shows the 5-hour and 7-day percentages, with a 🟢/🟠/🔴 status dot,
  flags a stale reading, and shows the daemon as stopped, with Start/Stop in its menu.
  `claude-usage service start|stop|status` drives the launchd/systemd service directly.
  `uninstall` removes the plugin (§23.66).
- **iPhone app over Wi-Fi, no Tailscale needed.** A new `lan` bind keyword selects this
  machine's private Wi-Fi/Ethernet address and follows it across network changes. Turn it
  on with `install --lan` (an interactive install asks, default yes) or
  `configure lan on|off` (§23.44).
- HTTPS on `port + 1` for every non-loopback address. The certificate is self-signed and
  pinned, and is built with no dependencies. Its key is generated once and kept, so apps
  stay paired across restarts and certificate renewals (§23.45). Since §23.57 off-machine addresses are HTTPS only.
- The machine's `.local` name is accepted as a `Host` (§23.46).
- One-time pairing codes. `POST /v1/pair/code` mints one; it needs the bearer and must come
  from loopback. `POST /v1/pair` trades a code for the bearer over HTTPS only: each code
  works once, expires after 5 minutes, and a sender is cut off after 5 failures in a
  minute (§23.47).
- `claude-usage pair` opens a one-time browser page showing the pairing QR code. The page
  is served once, from loopback only, and the QR never carries the bearer. `install` offers
  to open it at the end (§23.48).
- `/health.install` reports whether the hooks, status line and MCP server are set up, and
  lists the live listeners (§23.48). It is on REST `/health` only, not in the SSE snapshot.

### Changed
- **Upgrade note:** a daemon whose `bind` already includes `tailscale`, `lan` or any
  non-loopback IP gains an HTTPS listener on `port + 1` (**47292** by default) on those
  addresses, and generates a TLS key (`tls-key.pem`, `tls-cert.pem`, `0600`) in the config
  directory on its first start after the upgrade. Plain HTTP on 47291 is now served on loopback only (§23.57). Set
  `tls.port` if 47292 is taken; it must differ from `port`.
- Live headline limits without spending the usage endpoint's budget: `claude-usage observe`
  (and `claude-usage statusline`, automatically) forwards the `rate_limits` Claude Code passes
  its statusline to the new `POST /v1/limits/observed`. `session` / `weekly_all` are served
  from whichever reading is newer, and every row now carries `source` and `asOf`. While
  observations are fresh the daemon polls Anthropic at most hourly (§23.36).
- `legacyWindows.five_hour` / `.seven_day` now mirror a fresh statusline observation instead
  of lagging `limits[]`. When an observation lapses (15 min without a statusline render, or
  its window resets), SSE clients get a `limits` event right away. Before, that event waited
  up to an hour for the next poll (§23.37).

### Fixed
- `configure port` restarted the service before saving the new port; it now saves first.
- `ios-` release tags are ignored by the updater, like `deck-` (§23.17).
- `claude-usage pair` no longer passes the one-time page URL to `open` / `xdg-open` (where
  other local users could read it from `ps`) or prints it; it opens a private redirect file.
- `claude-usage status | head` (or any reader that stops early) no longer prints an `EPIPE`
  stack trace; the CLI exits 0 quietly (§23.43).
- A daemon restart, such as each auto-update, no longer briefly serves hours-old limit
  numbers until a session next renders its statusline. Fresh statusline readings are saved
  on shutdown and restored on start, and the restart no longer calls Anthropic for them (§23.42).
- The hook's usage warning names the day when a reset is a day or more away
  (`resets Thu 02:00`). A weekly reset three days out used to read as `resets 02:00` (§23.41).
- Session % no longer flips between two values when several Claude Code sessions are open.
  An idle session's statusline re-sends its last, older numbers, and those used to replace
  the live reading. A lower reading for the same window, or one from an earlier window, is
  now ignored (§23.40).
- After a limit window resets, `/v1/limits` no longer falls back to Anthropic's reading from
  the window that just ended. That row now reads `percent: null` with `stale: true` until a
  new reading arrives (§23.40).
- Every limit row now carries its own `stale`. Snapshot `stale` is `true` when `session` or
  `weekly_all` is stale. Before, it read `false` as soon as any one row was live (§23.40).
- `GET /v1/events` no longer drops every client ~30 s after it connects. A buffer that was
  still flushing after a successful write was mistaken for a stalled client. Streams now
  stay open, and clients no longer miss events during the 3 s reconnect (§23.39).
- The daemon no longer burns 1–4 cores on a machine with many transcripts. Incremental
  scans skip unchanged files instead of opening each one and allocating a 1 MB buffer for
  it, and the transcript watcher starts at most one scan every 5 s. On 6,179 transcripts
  (4.4 GB), a pass went from ~1.6 s to ~0.17 s of CPU (§23.38).
- The daemon log now records each limits state change (`limits: ok`, `limits: rate_limited …
  next attempt after <retryAt>`, `limits: fetch failing (<code>) …`) at the default level, so
  when a block started and cleared can be read from the log (§23.35).
- The usage request now identifies itself with `User-Agent: claude-usage/<version>` instead
  of Node's default, so Anthropic can see and budget this client (§23.34).
- An upstream `HTTP 429` from the usage endpoint is now reported as `error.code:
  "rate_limited"` with `retryAt` and a hint, instead of a generic `network` error, and the
  MCP headline says `rate-limited by Anthropic (HTTP 429) until … · numbers from …`. The
  daemon honours `Retry-After` (capped at 6 h) for scheduled polls and `POST /v1/refresh`,
  and persists the window so an auto-update restart does not poll inside it. Previously it
  ignored a 50-minute `Retry-After` and retried every ≤ 10 min for eleven hours.
- The daemon polls the usage endpoint far less, to stay under its unpublished budget:
  the default `pollIntervalMs` is 300 000 (was 60 000) with a 120 000 floor applied to
  existing configs; each 429 doubles the interval (to 30 min max), easing back after 12
  good polls; a restart whose cached numbers are younger than the interval waits instead of
  polling at once; and `POST /v1/refresh` is served from cache within 60 s of any upstream
  call (was: 10 s between refreshes, ignoring scheduled polls).
- An account switch no longer leaves the daemon serving the previous account's limits. The
  OAuth access token was cached for the life of the process and re-read only on a 401 —
  but a switched-away token stays valid, so no 401 ever fired and the daemon reported the
  new identity beside the old account's percentages indefinitely. The token cache now has a
  TTL (`TOKEN_REFRESH_MS`, 10 min, deliberately equal to the identity re-read interval), and
  `POST /v1/refresh` re-reads the credential store instead of reusing the cached token.
- Version directories now get their production `node_modules` so the `mcp` subcommand works from the installed copy and from release tarballs.

### Added
- Transcript back-fill in `/v1/sessions`: sessions with activity in the last 10 min read `alive: true`; sessions idle for more than 24 h are omitted.
- Daemon (`claude-usage serve`): rate-limit windows from the Claude Code OAuth usage endpoint, normalized to `limits[]`; local token spend indexed from `~/.claude/projects/**/*.jsonl` including subagent transcripts, deduplicated, snapshotted to disk.
- HTTP API on loopback (+ optional Tailscale bind): `/health`, `/v1/limits`, `/v1/summary`, `/v1/tokens`, `/v1/refresh`, `/v1/config`, `/v1/sessions` (+ register/heartbeat/end/gate), `/v1/pause`, `/v1/resume`, `/v1/pause/rules`, `/v1/events` (SSE). Bearer token required (since §23.55, for every request); Host allowlist; `Origin` rejected.
- Sessions registry fed by Claude Code hooks (SessionStart / UserPromptSubmit / PreToolUse / SessionEnd), worktree-aware project grouping, `lastTool`.
- Pause rules (`all` / `project:<git-common-dir>` / `session:<id>`): soft pause via hook gate, hard freeze via SIGSTOP/SIGCONT with orphan sweep and the offline `claude-usage resume --all` escape hatch.
- `UserPromptSubmit` nudge at 80 % / 95 % (inform-only, never blocks), statusline with pause marker, MCP server (`get_limits`, `get_summary`, `get_tokens`, `get_sessions`, `refresh_limits`).
- `install` / `configure` / `uninstall`: launchd + systemd user units, merge-only `~/.claude/settings.json` edits with a once-written `.bak`, MCP registration via `claude mcp add`, and pairing for the remote dashboard.
- Auto-update from GitHub Releases (sha256-verified, versions layout with `current` symlink, deferral while sessions are hard-frozen, `rollback`); release workflow tags and publishes every green push to `main`.
