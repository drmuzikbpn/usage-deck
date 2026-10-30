# claude-usage — local usage service for Claude Code sessions

**Date:** 2026-09-13
**Status:** approved design, pre-implementation
**License target:** MIT, public GitHub repo

## 1. Purpose

A small local daemon that Claude Code sessions (and humans) can query to learn:

1. **Rate-limit utilization** for the logged-in Claude Code account — the 5-hour and
   7-day windows (percent used, reset time) that `/usage` shows. Account-wide.
2. **Local token spend** aggregated from Claude Code's transcript files — per project,
   session, model and day. Per-machine.

Sessions consume it automatically through a `UserPromptSubmit` hook (nudge when a
window crosses a threshold) and on demand through an MCP server. The hook **never
blocks** a prompt; it only informs.

## 2. Decisions made during brainstorming

| Topic | Decision |
| --- | --- |
| Datasets | Rate-limit windows **and** local token spend |
| Consumption | Hook (automatic nudge) + MCP server (on-demand detail) + optional status line |
| Runtime | Always-on daemon (launchd / systemd user unit), HTTP on localhost |
| Platforms v1 | macOS + Linux; Windows deferred behind `credentials` / `service-manager` interfaces |
| Hook behaviour | Inform only. Warn ≥ 80 %, critical ≥ 95 %, thresholds configurable. Never exit 2 |
| Install | `claude-usage install`: interactive, confirms each item, daemon defaults to **on** |
| Configure | `claude-usage configure` toggles service / hook / MCP / statusline, thresholds, port |
| Language | TypeScript on Node ≥ 20, zero runtime deps for the daemon |
| Cost estimates | Out of v1 (pricing tables rot) |

## 3. Architecture

```
┌──────────────────────────── claude-usage daemon (node:http, 127.0.0.1:47291) ────────────────────────────┐
│  credentials/  →  limits/client  →  limits/poller  ──┐                                                     │
│  (keychain | file)   (OAuth usage endpoint)          ├─→  server/  (GET /health, /v1/limits, /v1/spend,   │
│  spend/watcher → spend/scanner → spend/store ────────┘             /v1/summary, /v1/config, POST /v1/refresh)│
│  (fs.watch + sweep)  (JSONL tail)  (dedup + aggregates + state.json)                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ 200 ms              ▲ 2 s                    ▲                      ▲
   hook (UserPromptSubmit)   mcp (stdio)         statusline              status / spend CLI, curl
```

One npm package, one CLI (`claude-usage`) with subcommands:
`serve`, `install`, `uninstall`, `configure`, `status`, `spend`, `hook`, `mcp`, `statusline`.

## 4. HTTP API

Bind and auth are defined in **§16** (Part II). Even loopback-only deployments enforce the Host allowlist and Origin rejection from §16.
All responses JSON. 5 s request timeout.

### `GET /health`
```json
{ "ok": true, "version": "0.1.0", "uptimeMs": 1234, "pid": 4242,
  "stats": { "filesTracked": 12, "eventsIndexed": 5400, "parseErrors": 0,
             "lastScanAt": "...", "spendReady": true } }
```

### `GET /v1/limits`
> **Superseded by §23.3** (normalize on upstream `limits[]`). Kept for history.

```json
{ "fetchedAt": "2026-09-13T14:00:00Z", "stale": false, "error": null,
  "windows": {
    "five_hour":     { "utilization": 42.1, "resetsAt": "2026-09-13T16:35:00Z" },
    "seven_day":     { "utilization": 61.0, "resetsAt": "2026-09-18T09:00:00Z" },
    "seven_day_opus": { "utilization": 12.0, "resetsAt": "..." }
  },
  "raw": { "...verbatim upstream payload..." } }
```
- Upstream schema is undocumented. `raw` is always served verbatim; `windows` contains
  only fields we have verified. Unknown/missing fields → `null`, never a thrown error.
- `stale: true` when serving a last-good value after a fetch failure; `error` then carries
  `{ code: "unauthorized" | "network" | "schema_drift" | "no_credentials", message, hint }`.

### `GET /v1/spend?since=<iso|7d|24h|today>&groupBy=project|session|model|day`
```json
{ "ready": true, "since": "...", "groupBy": "project",
  "totals": { "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0, "messages": 0 },
  "groups": [ { "key": "/Users/me/code/foo", "input": 0, "output": 0,
                "cacheCreate": 0, "cacheRead": 0, "messages": 0 } ] }
```
`ready: false` (with empty totals) until the initial scan completes. Default
`since=today`, `groupBy=project`. Multiple `groupBy` values are not supported in v1.

### `GET /v1/summary`
The hook's single call. Small payload:
```json
{ "limits": { "...as /v1/limits minus raw..." },
  "status": { "five_hour": "ok|warn|critical", "seven_day": "ok", "overall": "warn" },
  "thresholds": { "warn": 80, "critical": 95 },
  "today": { "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0, "messages": 0 } }
```

### `POST /v1/refresh`
Forces a limits refetch. Rate-limited to one per 10 s (`429` otherwise). Returns the
new `/v1/limits` body.

### `GET /v1/config`
Effective config: thresholds, port, poll interval, resolved paths, enabled integrations.

## 5. Data sources

### 5.1 Credentials (`src/credentials/`)
Interface: `getAccessToken(): Promise<string>`; throws `NoCredentialsError`.
- **macOS** `keychain.ts`: `security find-generic-password -s "Claude Code-credentials" -w`,
  parse JSON, read `claudeAiOauth.accessToken`. First access may show a Keychain prompt;
  `install` warns before triggering it.
- **Linux** `file.ts`: `~/.claude/.credentials.json`, same JSON shape.
- Selected by `process.platform` at startup. Windows → `UnsupportedPlatformError`.
- **We never refresh tokens.** Claude Code owns refresh. On `401` we re-read credentials
  once and retry; if still `401`, surface `unauthorized` with hint "run `claude` to re-login".

### 5.2 Rate limits (`src/limits/`)
- `client.ts`: `fetchLimits(token): Promise<LimitsPayload>` → `GET https://api.anthropic.com/api/oauth/usage`
  with `Authorization: Bearer <token>` and the OAuth beta header Claude Code sends.
  **The exact response shape is verified in the first implementation step** (read-only
  GET with the live token) and captured as a redacted fixture; normalization is written
  against that fixture.
- `poller.ts`: fetch every `pollIntervalMs` (default 60 000 — 300 000 since §23.33). On failure: exponential
  backoff (2× from 60 s, cap 10 min), keep serving last-good with `stale: true`.

### 5.3 Token spend (`src/spend/`)
> **Amended by §23.4–23.8** (recursive walk incl. subagent transcripts, line filters, project key, memory bounds, truncation).

- Source: `~/.claude/projects/<encoded-cwd>/*.jsonl`. Lines with `type === "assistant"` →
  `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`,
  `message.model`, `message.id`, `requestId`, `timestamp`, `sessionId`, `cwd`.
- **Dedup key** `message.id + ":" + requestId`. Streaming appends the same assistant
  message several times; counting each would double-count (the classic bug).
- `scanner.ts`: per file, resume from stored byte offset; if offset > file size (truncated /
  rotated) restart from 0 and drop that file's events. Malformed line → skip, `parseErrors++`.
- `watcher.ts`: `fs.watch(projectsDir, { recursive: true })`, 500 ms debounce (at most one flush per 5 s, §23.38) → scan; plus a
  5-minute safety sweep (recursive watch is unreliable on some Linux setups).
- `store.ts`: aggregates keyed by `(day, project, sessionId, model)`; dedup set; answers
  `/v1/spend`. Retention 90 days (aggregates and dedup entries pruned together).
  Snapshot to `state.json` every 30 s and on shutdown: `{ version, offsets: {file: bytes},
  aggregates, dedup }`. Snapshot version mismatch → full rescan.

## 6. Daemon lifecycle (`src/daemon.ts`)
- Startup order: load config → load `state.json` → start HTTP (so `/v1/limits` is available
  immediately) → start poller → initial spend scan (`ready: false` until done) → start watcher.
- Writes `~/.config/claude-usage/daemon.json` `{ pid, port, startedAt, version }` on start;
  clients read it to discover the port. Removed on clean shutdown; `status` detects a
  stale file (pid not alive).
- `SIGTERM`/`SIGINT` → flush snapshot, remove `daemon.json`, exit 0.
- Port in use → exit 1 with a clear message.
- Logs to stderr only (launchd/systemd capture). `--verbose` for debug lines.

## 7. Integrations

### 7.1 Hook — `claude-usage hook`
- Registered as a `UserPromptSubmit` hook in `~/.claude/settings.json`.
- Reads and ignores stdin. `GET /v1/summary`, **200 ms** timeout.
- Any failure → exit 0, no output. The hook must never slow or break a session.
- `overall === "ok"` → no output.
- `warn`: `⚠ Claude usage: 5h window 84% (resets 14:35), 7d 61%. Prefer lighter work, smaller models, avoid large file reads.`
- `critical`: `🛑 Claude usage: 5h window 96% — resets in 41m. Defer non-urgent work; keep outputs short.`
- Debounce: if the same `(window, status)` was printed within `hookDebounceMinutes`
  (default 10), stay silent. Any status **change** prints immediately. State kept in
  `~/.config/claude-usage/hook-state.json`.
- Always exit 0. Never exit 2.

### 7.2 MCP server — `claude-usage mcp`
- stdio transport via `@modelcontextprotocol/sdk` (the only runtime dependency, loaded
  lazily so the daemon never imports it).
- Tools: `get_limits`, `get_spend { since?, groupBy? }`, `get_summary`, `refresh_limits`.
- Thin HTTP proxies, 2 s timeout. Daemon down → tool error text
  `"claude-usage daemon not running — run `claude-usage status`"`.
- Registered in `~/.claude.json` → `mcpServers["claude-usage"] = { command: "claude-usage", args: ["mcp"] }`.

### 7.3 Status line — `claude-usage statusline` (optional, default off)
- Prints `5h 42% · 7d 61%`; ANSI colour above warn/critical. Daemon down → prints nothing.
- Install sets `statusLine.command` only when none exists; otherwise prints the snippet
  for the user to append to their own script.

### 7.4 Human CLI
- `claude-usage status` — daemon state, limits table, today's spend, integration toggles.
- `claude-usage spend --since 7d --by project|session|model|day` — table output.

## 8. Install / configure / uninstall

### `claude-usage install [--yes] [--no-service] [--no-hook] [--no-mcp] [--statusline]`
1. **Preflight:** Node ≥ 20, supported platform, credentials readable (warn about the
   Keychain prompt first). Fail early with actionable messages.
2. **Plan + confirm** each item (defaults: service **yes**, hook yes, MCP yes, statusline no).
   `--yes` accepts defaults.
3. **Apply:**
   - Service: macOS `~/Library/LaunchAgents/com.claude-usage.plist` (`KeepAlive`, `RunAtLoad`,
     `launchctl bootstrap gui/$UID`); Linux `~/.config/systemd/user/claude-usage.service`
     (`Restart=always`, `systemctl --user enable --now`).
   - Hook / MCP / statusline: **merge-only** JSON edits to `~/.claude/settings.json` and
     `~/.claude.json`: parse → add our entries → write. Unrelated keys untouched, key order
     preserved where JSON allows, `.bak` written first, idempotent on re-run. Malformed
     JSON → abort with the path; never overwrite.
4. **Verify:** `GET /health` (retry up to 5 s), print the status table.

### `claude-usage configure`
- No args → interactive menu: service / hook / MCP / statusline on–off, thresholds,
  port, poll interval, hook debounce.
- Scriptable: `configure service off`, `configure hook on`, `configure thresholds --warn 75 --critical 90`, …
- Turning a thing off removes exactly what install added (unit file unloaded + deleted;
  our hook/MCP entries removed; other entries untouched).
- Port change → rewrite unit file and restart service if enabled.

### `claude-usage uninstall [--purge]`
Reverses all install steps; keeps `~/.config/claude-usage/` unless `--purge`.

### Service manager interface (`src/service/`)
`install(unit) / uninstall() / start() / stop() / status()` with `launchd.ts` and
`systemd.ts` implementations; a `noop` implementation for `--no-service`.

## 9. Configuration file
`~/.config/claude-usage/config.json` (XDG; `$XDG_CONFIG_HOME` respected):
```json
{ "port": 47291, "pollIntervalMs": 300000,
  "thresholds": { "warn": 80, "critical": 95 },
  "hookDebounceMinutes": 10, "retentionDays": 90,
  "projectsDir": "~/.claude/projects",
  "integrations": { "service": true, "hook": true, "mcp": true, "statusline": false } }
```
Missing file → defaults. Unknown keys preserved. Invalid values → error naming the key.

## 10. Error handling principles
- The daemon never crashes on bad data: skip and count.
- Missing credentials → daemon still runs; `/v1/limits` returns `error.code = "no_credentials"`;
  spend unaffected.
- Every client (hook, MCP, statusline) treats every failure as "no information".
- Schema drift upstream → `raw` still served, normalized fields `null`, `stale: true`,
  `error.code = "schema_drift"`.

## 11. Testing strategy (vitest, TDD per module)
- `credentials`: fakes for keychain/file; parse fixtures incl. missing key.
- `limits/client`: fixture payloads (captured live once, redacted) for ok / 401 / schema
  drift / network error; retry-once-on-401 behaviour.
- `limits/poller`: fake timers — interval, backoff, last-good + stale.
- `spend/scanner`: fixture JSONL dir — dedup, offset resume, truncation restart,
  malformed lines, mixed models, non-assistant lines ignored.
- `spend/store`: each `groupBy`, `since` filters, retention pruning, snapshot round-trip,
  version-mismatch rescan.
- `server`: listen on port 0, `fetch` every route incl. 404/405, `ready:false` path,
  refresh rate limit.
- `hook`: fake daemon on port 0 → exact stdout for ok / warn / critical / debounced /
  status-change / unreachable / timeout; exit code always 0.
- `install`: settings merge against fixtures — untouched keys preserved, idempotent,
  malformed → abort, `.bak` written; service-manager and keychain exercised through fakes.
- Manual smoke checklist in `docs/smoke-test.md` for real launchd/systemd/Keychain.
- CI: GitHub Actions on `macos-latest` + `ubuntu-latest`: lint, typecheck, test.

## 12. Repository layout
```
bin/claude-usage           # node shim → dist/cli.js
src/cli.ts                 # subcommand dispatch
src/daemon.ts
src/config.ts
src/credentials/{index,keychain,file}.ts
src/limits/{client,poller,types}.ts
src/spend/{scanner,watcher,store,types}.ts
src/server/{index,routes}.ts
src/clients/http.ts        # shared thin client (timeouts, daemon.json discovery)
src/hook.ts  src/mcp.ts  src/statusline.ts
src/install/{index,settings-merge,plan}.ts
src/service/{index,launchd,systemd,noop}.ts
test/…  test/fixtures/…
docs/smoke-test.md  docs/api.md
CLAUDE.md  README.md  LICENSE  lefthook.yml  .github/workflows/ci.yml
```
Tooling: TypeScript strict, ESM, vitest, eslint, lefthook (lint + `tsc --noEmit` pre-commit),
`.gitignore` includes `*.tsbuildinfo`.

## 13. Out of scope for v1
Windows; cost estimates; cross-machine spend aggregation; authentication on the HTTP API;
token refresh; any write to Anthropic APIs.

## 14. Open item to resolve first in implementation
Verify the OAuth usage endpoint response shape with a live read-only GET; capture a
redacted fixture; adjust §4 `windows` normalization to the verified field names.

---

# Part II — remote dashboard scope (approved 2026-09-13)

Added after the Android kiosk dashboard ("Jules" session, repo `../android-project`) was
scoped. The dashboard consumes this daemon over Tailscale from a Nexus 5X, aggregates two
daemons (Adam + teammate) itself, and needs to see and pause live sessions. Sections 15–21
extend Part I; where they conflict, Part II wins. Implementation order: core daemon (Part I)
→ sessions/pause → events → network/auth → auto-update.

## 15. Identity & host metadata

`GET /health` gains:
```json
{ "name": "adams-mbp", "version": "0.1.417+3f9c2ab",
  "user": { "emailAddress": "…", "accountUuid": "…", "organizationUuid": "…", "displayName": "…" },
  "update": { "channel": "stable", "current": "0.1.417+3f9c2ab", "available": null,
              "state": "idle|checking|downloading|verifying|ready|deferred|disabled",
              "deferredReason": null } }
```
- `user` is read from `~/.claude.json → oauthAccount` (verified keys: `emailAddress`,
  `accountUuid`, `organizationUuid`, `displayName`, `organizationName`). Missing file/keys →
  `user: null`. Re-read every 10 min (the account can change on re-login).
- `name` defaults to `os.hostname()`, overridable in config.

## 16. Network binding & authentication

**Binding.** `config.bind` is a list, default `["127.0.0.1"]`; `install` offers to add
`"tailscale"`. Each entry is an IP literal or the keyword `tailscale`, resolved at startup to
the first IPv4 interface address inside `100.64.0.0/10` (falls back to `tailscale ip -4` if the
CLI exists). No Tailscale interface → log a warning, bind the rest. One `http.Server` per
address, same handler. Re-resolve on `SIGHUP`.

**Auth model.** Threat model: anything on the tailnet, plus any process/browser on the local
machine (DNS rebinding, `localhost` fetches from web pages).
- A 32-byte random **bearer token** is generated at install, stored in `config.json`
  (`auth.token`, file mode `0600`). `claude-usage configure rotate-token` regenerates it.
- **Loopback + safe method (GET/HEAD) → no token required.** Keeps hook, statusline and
  `curl localhost` zero-config. `/v1/events` from loopback is also exempt.
- **Everything else requires `Authorization: Bearer <token>`** — every non-loopback request
  and every mutating request (POST/DELETE) regardless of source. Missing/wrong → `401`
  `{ error: { code: "unauthorized" } }`, constant-time compare.
- **Host allowlist:** `Host` must be one of the bound addresses (with port), `localhost`, or
  the machine's Tailscale MagicDNS name (from `tailscale status --json`, if available);
  otherwise `421`. No CORS headers are ever sent (browsers can't read responses).
- Loopback is determined from the socket's remote address, never from headers.

**Pairing.** `claude-usage configure pairing` prints
`{ "v": 1, "name": "adams-mbp", "addr": "100.101.102.103", "port": 47291, "token": "…" }`
as JSON and as a terminal QR code (single small dependency for QR rendering, CLI-only —
the daemon never loads it). `--json` suppresses the QR.

## 17. Sessions

### 17.1 Discovery — via our own hooks, not process scraping
| Hook event | Action |
| --- | --- |
| `SessionStart` | `POST /v1/sessions/register` `{ sessionId, pid, cwd, transcriptPath, gitCommonDir, source }` — `pid` = the hook process's `ppid` (the `claude` process); `gitCommonDir` = `git rev-parse --git-common-dir` resolved to an absolute path, run once in `cwd` (null if not a repo). |
| `UserPromptSubmit` | heartbeat (`lastActivityAt`) + soft-pause gate (§18) + limits nudge (§7.1). |
| `PreToolUse` | soft-pause gate only (§18). |
| `SessionEnd` | `POST /v1/sessions/{id}/end`. |
Registration is idempotent (`claude --resume` re-registers the same `sessionId` with a new
pid). `install` adds all four hook entries; `configure hook off` removes them together.

### 17.2 Liveness & reconciliation
- Every 15 s the daemon `kill(pid, 0)`s each registered pid; dead → mark `alive: false`,
  drop after 5 min (so the dashboard sees the exit).
- Sessions the hooks never saw (daemon was down at their start) are back-filled from the spend
  scanner: a `sessionId` with a fresh assistant message but no registration appears with
  `pid: null`, `discovered: "transcript"`. Hard pause is refused (`409`) for those.
- `model`, `tokens` (input/output/cacheCreate/cacheRead/messages) and `startedAt` come from
  the spend store, keyed by `sessionId`.

### 17.3 `GET /v1/sessions`
```json
{ "rev": 812, "sessions": [ {
  "sessionId": "…", "pid": 4242, "alive": true, "discovered": "hook",
  "cwd": "/Users/adam/code/foo-wt2", "transcriptPath": "…",
  "project": { "gitCommonDir": "/Users/adam/code/foo/.git", "name": "foo" },
  "worktree": "foo-wt2",
  "model": "claude-opus-5", "startedAt": "…", "lastActivityAt": "…",
  "tokens": { "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0, "messages": 0 },
  "pause": null
} ] }
```
- `rev` is a monotonic counter bumped on any sessions/pause change; sent as `ETag: W/"812"`,
  `If-None-Match` → `304`.
- `project.name` = basename of the main worktree (parent of `gitCommonDir`); `worktree` =
  basename of `cwd` when it differs from the main worktree, else `null`. Sessions with
  `gitCommonDir: null` group under `project: { gitCommonDir: null, name: <basename(cwd)> }`.
- `pause` when paused: `{ "mode": "soft|hard", "ruleId": "…", "scope": "…", "since": "…",
  "frozenPids": [4242, 4251] }`.

## 18. Pause & resume

### 18.1 Rules, not flags
```json
{ "id": "r_01H…", "scope": "all" | "project:<gitCommonDir>" | "session:<sessionId>",
  "mode": "soft" | "hard", "reason": "…", "createdAt": "…", "createdBy": "dashboard|cli" }
```
- Rules are persisted in `state.json` and survive daemon restarts.
- A session's **effective** pause = most specific matching rule (session > project > all);
  `hard` beats `soft` at the same specificity. Rules apply to sessions that register **after**
  the rule was created (a new worktree session in a paused project comes up paused).
- Same `(scope, mode)` posted twice → `200` with the existing rule (idempotent).

### 18.2 Soft pause (stop at the next boundary)
- `UserPromptSubmit` and `PreToolUse` hooks call `GET /v1/sessions/{id}/gate` →
  `{ "paused": true, "mode": "soft", "ruleId": "…", "reason": "…" }`. While `paused`, the hook
  sleeps and re-polls every 1 s (loopback GET, no token). When cleared it exits 0 and the
  session continues. Daemon unreachable → not paused (fail open, never wedge a session).
- Hook entries are installed with `"timeout": 86400` (Claude Code's default 60 s would kill
  the sleeping hook and let the session continue).
- While soft-paused the hook writes `~/.config/claude-usage/paused/<sessionId>` so the
  statusline can show `⏸ paused from dashboard`; removed on resume.

### 18.3 Hard freeze (SIGSTOP)
> **Superseded in part by §23.16:** the session's own `claude` process is no longer
> `SIGSTOP`ed — only the tool subprocesses below it are.

- Resolve `pid` → the full descendant tree (`ps -axo pid=,ppid=` walk; Linux may use
  `/proc/*/stat`), `SIGSTOP` children first then the parent; record `frozenPids` on the session.
- Resume → `SIGCONT` parent first then children; ignore `ESRCH`.
- **Safety invariants**
  - Clean shutdown (`SIGTERM`), `uninstall`, and `configure service off` → `SIGCONT`
    every recorded `frozenPids` first.
  - Startup → for every persisted hard rule, re-resolve pids and re-freeze **only** if the
    session is still alive; any `frozenPids` recorded in state whose session no longer
    matches a rule are `SIGCONT`ed (orphan sweep).
  - `claude-usage resume --all` works **without a running daemon**: reads `state.json`,
    `SIGCONT`s everything recorded, clears the rules. This is the documented escape hatch.
  - Hard freeze is refused (`409`) for `discovered: "transcript"` sessions (no trusted pid) and
    for pids not owned by the daemon's uid.
- A hard request for a `session:<id>` whose pid is gone → rule not created, `410`.

### 18.4 Endpoints (all mutating → token required)
| Method & path | Body → response |
| --- | --- |
| `POST /v1/pause` | `{ scope, mode, reason? }` → `200 { rule, affected: [sessionId…] }`; `409` untrusted pid; `410` dead session |
| `POST /v1/resume` | `{ scope }` → `200 { removed: [ruleId…], resumed: [sessionId…] }` (empty arrays if nothing matched — idempotent) |
| `GET /v1/pause/rules` | `{ rev, rules: […] }` |
| `DELETE /v1/pause/rules/{id}` | `204`; `404` unknown |
| `POST /v1/sessions/{id}/pause` | `{ mode, reason? }` — sugar for `scope: "session:<id>"` |
| `POST /v1/sessions/{id}/resume` | sugar for `scope: "session:<id>"` |
| `GET /v1/sessions/{id}/gate` | `{ paused, mode, ruleId, reason }` — loopback, polled by hooks |
CLI mirrors: `claude-usage sessions`, `claude-usage pause <all|project:<path>|session:<id>> [--hard]`,
`claude-usage resume <scope>|--all`.

## 19. Events — `GET /v1/events` (SSE)
- `text/event-stream`, `id:` = current `rev`, `retry: 3000`.
- On connect (and on any reconnect, regardless of `Last-Event-ID` — simplest correct
  behaviour): one `snapshot` event `{ name, version, user, limits, summary, sessions, rules, update, rev }`
  (`name`/`version`/`user` as in `/health`, so a client can label the machine without a second call).
- Then: `limits` (each successful poll where anything changed), `spend` (`{ today, delta }`,
  coalesced to ≤ 1/s), `session` (`{ type: "start|end|update", session }`), `pause`
  (`{ rules, affected }`), `update` (`/health.update` object), `heartbeat` every 15 s.
- Back-pressure: if a client's socket buffer is full for > 30 s, close it (it reconnects and
  gets a snapshot). Max 16 concurrent SSE clients.
- No WebSocket in v1 (would require a dependency; SSE is one-directional and sufficient).
- Polling fallback documented for clients: `/v1/summary` + `/v1/sessions` (with
  `If-None-Match`) at ≥ 2 s intervals.

## 20. Auto-update
- **Versioning:** `MAJOR.MINOR.<commit-count>+<short-sha>` computed in CI from
  `git rev-list --count HEAD` on `main` — monotonic, commit-stamped, valid semver.
- **Release:** every green CI run on `main` tags `v<version>` and publishes a GitHub Release
  with `claude-usage-<version>.tgz` (the `npm pack` output) and `SHA256SUMS`. npm publish
  happens from the same job; the tarball on GitHub is what the updater consumes.
- **Layout:** `~/.local/share/claude-usage/versions/<version>/` + `current` symlink. The
  launchd/systemd unit runs `<XDG_DATA_HOME>/claude-usage/current/bin/claude-usage serve`.
  `install` copies the running package into this layout first, whether it came from npm or a
  tarball — after install, the install method no longer matters.
- **Loop:** every `autoUpdate.intervalMs` (default 10 min, jittered ±10 %) `GET
  https://api.github.com/repos/drmuzikbpn/usage-deck/releases/latest` (repo pinned in code, overridable
  in config for forks). Newer → download tarball + `SHA256SUMS` to a temp dir, verify sha256,
  extract into `versions/<v>/`, run `node bin/claude-usage --version` from it as a smoke test,
  atomically repoint `current`, then `process.exit(0)` → `KeepAlive`/`Restart=always` relaunches.
  Keeps the previous 2 versions; `claude-usage rollback` repoints `current` to the previous one.
- **Deferral:** never restart while any session has a hard freeze (`state: "deferred"`,
  `deferredReason: "hard_frozen_sessions"`); re-check every 30 s. Soft pauses don't defer.
- **Off switch:** `autoUpdate.enabled=false` (`configure autoupdate off`); when the daemon
  wasn't installed via `install` (no `current` symlink) the updater is disabled automatically.
- **Integrity:** sha256 from `SHA256SUMS` on the same release; download over TLS only; a
  failed verify deletes the download and reports `update.state: "error"`. Signature
  verification (minisign) is a follow-up, tracked in the README.

## 21. Config additions
```json
{ "name": "adams-mbp",
  "bind": ["127.0.0.1", "tailscale"],
  "auth": { "token": "…" },
  "autoUpdate": { "enabled": true, "intervalMs": 600000, "repo": "drmuzikbpn/usage-deck" },
  "events": { "maxClients": 16 } }
```
`config.json` is written with mode `0600` because it now holds the token.

## 22. Testing additions
- `sessions`: register/heartbeat/end fixtures; liveness marking; transcript back-fill; worktree
  grouping from `gitCommonDir` (fixtures with two worktrees of one repo); `rev`/ETag/304.
- `pause`: rule specificity resolution; later-registering sessions inherit rules; idempotent
  POSTs; 409/410 paths; gate polling in the hook (fake daemon, fake timers); hard freeze against
  a spawned child process tree (`sleep` processes) — asserts `T` state via `ps`, SIGCONT on
  resume, on shutdown, and via `resume --all` with no daemon; orphan sweep on startup.
- `auth`: loopback GET exempt, loopback POST requires token, non-loopback GET requires token,
  wrong token 401 in constant time, Host allowlist 421.
- `events`: snapshot on connect, event ordering, coalescing, heartbeat, slow-client eviction.
- `update`: fake release server (port 0) — version compare, sha mismatch → error and cleanup,
  smoke-test failure → no repoint, deferral while hard-frozen, rollback.
- CI can't run launchd/systemd/Tailscale; those stay in `docs/smoke-test.md`.

---

# Part III — Part I amendments from the 2026-09-13 audit

**Part III overrides Parts I and II wherever they disagree.** Sections 23.1–23.12 came out
of the pre-implementation audit; everything from 23.13 on came out of running the thing —
QA from the Android dashboard, and two Macs in daily use.

| Section | Subject |
| --- | --- |
| §23.1 | Name & trademark |
| §23.2 | Local trust boundary (supersedes §4 preamble, §13 "authentication") |
| §23.3 | Limits normalization (supersedes §4 `/v1/limits` and the `limits` part of `/v1/summary`) |
| §23.4 | Transcript discovery (amends §5.3 source) |
| §23.5 | Line filter & dedup key (amends §5.3) |
| §23.6 | Project key (amends §4 `groupBy=project`, §5.3) |
| §23.7 | Memory & time budget (amends §5.3 scanner/store, §6) |
| §23.8 | Truncation (amends §5.3) |
| §23.9 | launchd / systemd details (amends §6 logging, §8 service) |
| §23.10 | `~/.claude.json` is Claude Code's live state file (amends §7.2, §8 step 3) |
| §23.11 | Hook registration shape (amends §7.1, §8) |
| §23.12 | Additional tests (amends §11) |
| §23.13 | Dashboard contract clarifications (from the Android spec audit, 2026-09-13) |
| §23.14 | Session titles from `/rename` (2026-09-13) |
| §23.15 | Pause-rule semantics refined by QA (2026-09-13 evening) |
| §23.16 | Hard freeze spares the session's own process (2026-09-13 evening) |
| §23.17 | Release-tag namespace shared with the Android dashboard (2026-09-14) |
| §23.18 | The update restart cannot rely on the exit code alone (2026-09-14) |
| §23.19 | The last good limits survive a restart (2026-09-14) |
| §23.20 | An install over ssh yields a service launchd will not supervise (2026-09-14) |
| §23.21 | Keep looking for the tailnet address (2026-09-14) |
| §23.22 | A manual update gets the daemon's hard-freeze guard (2026-09-14) |
| §23.23 | Registration gets its own deadline, and a retry (2026-09-14) |
| §23.24 | A session we watched stop must not come back to life (2026-09-14) |
| §23.25 | The §23.20 check could never fire from an install (2026-09-14) |
| §23.26 | `install` lost a race with its own `bootout` (2026-09-14) |
| §23.27 | `install` exited 0 in the middle of its own verification (2026-09-15) |
| §23.28 | The bootout race, measured instead of guessed (2026-09-15) |
| §23.29 | A second `install` aborted on its own idempotency (2026-09-15) |
| §23.30 | The ssh-install diagnosis was wrong (2026-09-15) |
| §23.31 | An account switch kept serving the previous account's limits (2026-09-16) |
| §23.32 | An upstream 429 is its own error, and `Retry-After` is honoured (2026-09-25) |
| §23.33 | Staying under the usage endpoint's budget (2026-09-25) |
| §23.34 | An honest User-Agent on the usage call (2026-09-25) |
| §23.35 | Limits state transitions are logged at the default level (2026-09-26) |
| §23.36 | Headline limits from Claude Code's statusline input (2026-09-26) |
| §23.54 | Install wires the limits feed by default (2026-10-02) |
| §23.37 | `legacyWindows` follows observations; a lapse is pushed (2026-09-26) |
| §23.38 | Incremental scans skip unchanged transcripts; flushes have a floor (2026-09-26) |
| §23.39 | SSE back-pressure is a `false` write, not a non-empty buffer (2026-09-27) |
| §23.40 | Old readings, reset windows and per-row `stale` (2026-09-27) |
| §23.41 | The hook names the day of a far-off reset (2026-09-28) |
| §23.42 | Observations survive a restart (2026-09-28) |
| §23.43 | A closed stdout pipe is not a crash (2026-09-28) |
| §23.44 | The `lan` bind keyword, re-resolved automatically (2026-10-01) |
| §23.45 | HTTPS listener with a self-signed, pinned certificate (2026-10-01) |
| §23.46 | Host policy accepts the `.local` name (2026-10-01) |
| §23.47 | One-time pairing code: `POST /v1/pair/code`, `POST /v1/pair` (2026-10-01) |
| §23.48 | `/health.install` and the `claude-usage pair` page (2026-10-01) |
| §23.49 | Deferred (2026-10-01) |
| §23.50 | A self-restart needs a witness that outlives it (2026-10-01) |
| §23.51 | `claude-usage` on the PATH, and `pair` where you will see it (2026-10-02) |
| §23.52 | The pair page: deck theme, copy link, "Pairing successful" (2026-10-02) |
| §23.53 | `rotate-token` restarts the daemon (2026-10-02) |

15 findings survived a 3-vote adversarial review (56 unique candidates). Where Part I
conflicts with this section, this section wins.

## 23.1 Name & trademark
- `claude-usage` is **taken on npm** (unrelated package, v1.1.0). Publish **scoped**:
  `@drmuzikbpn/claude-usage`, `bin` stays `claude-usage`. The
  CLI name, MCP key, config dir `~/.config/claude-usage/`, launchd label
  `com.github.drmuzikbpn.claude-usage` and systemd unit `claude-usage.service` all keep `claude-usage`.
- README footer: "Works with Claude Code. Not affiliated with, endorsed by, or sponsored by
  Anthropic. Claude and Claude Code are trademarks of Anthropic."

## 23.2 Local trust boundary (supersedes §4 preamble, §13 "authentication")
- §16 applies to **all** deployments, including loopback-only: Host allowlist (`421`), any
  request carrying an `Origin` header → `403`, no CORS headers, token required for every
  mutating request. Impact being defended: local path/session-id disclosure and
  attacker-forced upstream fetches — no endpoint ever returns credentials.
- File modes: `config.json`, `state.json`, `daemon.json`, `hook-state.json` all `0600`; config
  dir `0700`.

## 23.3 Limits normalization (supersedes §4 `/v1/limits` and the `limits` part of `/v1/summary`)
```json
{ "fetchedAt": "…", "stale": false, "error": null,
  "limits": [
    { "id": "session",             "kind": "session",       "group": "session", "percent": 5,
      "severity": "normal", "resetsAt": "2026-09-13T18:00:00Z", "scope": null, "isActive": false },
    { "id": "weekly_all",          "kind": "weekly_all",    "group": "weekly",  "percent": 13, "…": "…" },
    { "id": "weekly_scoped:fable", "kind": "weekly_scoped", "group": "weekly",  "percent": 10,
      "scope": { "model": "Fable", "surface": null }, "…": "…" } ],
  "legacyWindows": { "five_hour": { "utilization": 5.0, "resetsAt": "…" }, "seven_day": { "…": "…" } },
  "extraUsage": { "isEnabled": false, "utilization": null, "spendLimitReached": true },
  "raw": { "…": "…" } }
```
- `limits[]` is normalized **1:1 from upstream `limits[]`** — the only authoritative model.
  `id` = `kind` + (`:` + lower-cased `scope.model.display_name` when present).
- `percent` is the upstream integer; thresholds are evaluated on `percent` only (the float
  `utilization` in the legacy windows may differ by rounding).
- `resetsAt` normalized through `Date` to ISO-8601 `Z`; **may be `null`** — every hook /
  statusline template must render without it ("resets: unknown").
- Status per limit = `critical` if `percent ≥ critical` **or** upstream `severity` is a
  critical-like value; `warn` if `percent ≥ warn` **or** `severity !== "normal"`; else `ok`.
  `/v1/summary.status = { byId: { "<id>": "ok|warn|critical" }, overall }`. Unknown
  `severity` strings are passed through, never thrown on.
- `legacyWindows` is best-effort passthrough of `five_hour`/`seven_day` only; `seven_day_opus`
  et al. are **not** promised. Unknown top-level keys are ignored; `raw` keeps everything.
- `/v1/spend` is renamed **`/v1/tokens`** to avoid colliding with upstream's `spend` (dollar)
  object, which we surface as `extraUsage`/`raw` only. MCP tool becomes `get_tokens`.
- Beta header is literally `anthropic-beta: oauth-2025-04-20` (see fixture README).
- On `401`: re-read credentials once, retry; still `401` → `error.code = "unauthorized"`,
  poll interval backs off to 10 min until a fetch succeeds (no hammering an expired token).

## 23.4 Transcript discovery (amends §5.3 source)
- Walk **every `*.jsonl` under `~/.claude/projects/` recursively at any depth**. Observed shapes:
  `<encoded-cwd>/<sessionId>.jsonl` (main thread) and
  `<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl` (subagent transcripts, `isSidechain: true`,
  `agentId` present — **~31 % of all tokens on the reference machine**; they are not copied into
  the parent transcript and must be counted). Non-transcript `.jsonl` files exist in the tree
  (e.g. `<project>/vercel-plugin/skill-injections.jsonl`) — lines that are not counted assistant
  lines are skipped silently, **not** counted as `parseErrors`.
- Subagent lines carry the parent's `sessionId` → tokens roll up to the session.

## 23.5 Line filter & dedup key (amends §5.3)
A line is counted iff `type === "assistant"` **and** `message.model !== "<synthetic>"` **and**
`isApiErrorMessage !== true` **and** `message.usage` is an object. Dedup key =
`message.id + ":" + (requestId ?? "")` — `requestId` is absent on some lines and the key must
never be built from `undefined`. Duplicates are per-content-block lines sharing one
`message.id`/`requestId` with identical usage; count once.

## 23.6 Project key (amends §4 `groupBy=project`, §5.3)
`project` = the `~/.claude/projects/<dir>` directory name the transcript lives under, used
verbatim as an opaque key (the encoding is lossy — `/` and `-` both become `-` — so it is
never decoded). Display label = `cwd` of the **first** counted line of the session's top-level
transcript; per-line `cwd` drifts when subagents run elsewhere and is **not** a key.
`/v1/tokens` groups carry `{ key, label }`. Part II's `gitCommonDir` grouping (§17) is a
separate, richer identity available only for hook-registered sessions.

## 23.7 Memory & time budget (amends §5.3 scanner/store, §6)
- Reference corpus: **492 MB, 355 files, largest transcript 130 MB, ~29 k dedup keys.**
- Scanner reads via `fs.open` + positional reads in **1 MB chunks** with a carry-over partial
  line; a file is never materialized whole; peak memory O(chunk). Yields to the event loop
  between chunks (`setImmediate`) so HTTP stays responsive; initial scan runs ≤ 4 files in
  flight; `/health.stats` reports `scan: { filesDone, filesTotal, bytesDone, bytesTotal }`.
- Snapshot only when dirty; dedup keys stored as a compact array of strings; state file is
  written atomically (temp + rename). Snapshot `version` mismatch → **background** rescan while
  the old aggregates keep serving (`stale: true` on `/v1/tokens` meanwhile), not a cold start.
- Watcher starts **before** the initial scan; events arriving mid-scan queue and are drained
  after it, so appends during the scan don't wait for the 5-min sweep.

## 23.8 Truncation (amends §5.3)
If a stored offset exceeds the file's current size, the file was truncated or replaced:
restart it from 0 **and schedule a full background rescan** — aggregates are pre-summed
counters not attributable to one file, so no per-file rollback is attempted.

## 23.9 launchd / systemd details (amends §6 logging, §8 service)
- launchd does **not** capture stderr by default. Plist sets `StandardOutPath` /
  `StandardErrorPath` to `~/Library/Logs/claude-usage/daemon.{out,err}.log` (dir created
  `0700`), `ProgramArguments` with the **absolute resolved node binary** (nvm/volta/fnm paths
  are not on launchd's PATH), `EnvironmentVariables.PATH` = the install-time PATH,
  `RunAtLoad`, `KeepAlive: { SuccessfulExit: false }` — so `process.exit(0)` from the
  auto-updater/`configure service off` is honoured. Logs are truncated at install when > 10 MB;
  no rotation otherwise (documented). `status` prints the last 20 stderr lines when the daemon
  is down.
- systemd user unit: absolute `ExecStart`, `Environment=PATH=…`, `Restart=on-failure`,
  `[Install] WantedBy=default.target`, `daemon-reload` after writing. Logs go to the journal
  (no file paths). The unit lives for the login session; `install --linger` runs
  `loginctl enable-linger` and reports (not fails) if unavailable. Uninstall never touches linger.

## 23.10 `~/.claude.json` is Claude Code's live state file (amends §7.2, §8 step 3)
- It is `0600` and rewritten by running Claude Code sessions. **Primary path:** delegate the
  write — `claude mcp add --scope user claude-usage -- <abs path>/claude-usage mcp`
  (and `claude mcp remove --scope user claude-usage` on uninstall).
- **Fallback** (no `claude` on PATH): re-read → merge → write a `0600` temp file in the same
  directory → `rename(2)`; **no `.bak`** for this file (a `.bak` would leak `0600` content at
  `0644`); warn the user to quit running sessions first. Entry includes `"type": "stdio"`.
- `~/.claude/settings.json` keeps the Part I protocol; its `.bak` is written **once**
  (`settings.json.claude-usage.bak`, never overwritten on re-run) and copies the source mode.

## 23.11 Hook registration shape (amends §7.1, §8)
`hooks.<Event>` is an array of matcher-groups. Install **appends** one group per event with no
`matcher` key: `{ "hooks": [ { "type": "command", "command": "<abs path>/claude-usage hook",
"timeout": <seconds> } ] }` — `timeout` is **seconds**; `5` for `SessionStart`/`SessionEnd`,
`86400` for `UserPromptSubmit`/`PreToolUse` (the soft-pause gate, §18.2). §7.1's 200 ms is the
hook's own internal HTTP deadline. Idempotency/uninstall key on the command string matching
our resolved binary path. Install fixture must include a `settings.json` that already has
several groups per event (Adam's has `PreToolUse`, `PostToolUse`, `SessionStart` populated and
a custom `statusLine` — §7.3's "print the snippet" path is the normal case, not the edge).
`statusLine` when we do set it: `{ "type": "command", "command": "<abs path>/claude-usage statusline" }`.

## 23.12 Additional tests (amends §11)
`spend/watcher` (debounce coalescing, sweep catches missed file, mid-scan queueing);
`daemon` (temp `XDG_CONFIG_HOME`, startup order, `daemon.json` lifecycle, stale pid, port in
use → exit 1, SIGCONT-on-shutdown); `config` (defaults, unknown-key round-trip, invalid value
names key, modes); `mcp` (each tool, daemon-down text, stdout reserved for JSON-RPC);
`statusline` (ok/warn/critical/paused/unreachable, `resetsAt: null`); **`uninstall`/`configure
off` round-trip**: fixture settings → install → uninstall → byte-identical to fixture except
our once-written `.bak`; `limits` normalizer against the fixture incl. `unknown_window_example`,
`resetsAt: null`, unknown `severity`.

## 23.13 Dashboard contract clarifications (from the Android spec audit, 2026-09-13)
- Session objects (`/v1/sessions`, SSE `session`) carry `lastTool: { name, at } | null`,
  populated by the `PreToolUse` hook: its gate call becomes
  `GET /v1/sessions/{id}/gate?tool=<tool_name>` and the daemon records `{ name, at: now }`.
- SSE `spend` `{ today, delta }` is **machine-wide**; per-project/per-session live burn is
  derived by clients from cumulative `session.update.tokens` and `/v1/tokens`.
- `rule.reason` is echoed **verbatim** (trimmed to 200 chars) in the rule, in `/v1/pause/rules`
  and in the `pause` SSE event, so a client can tag its own rules (e.g. `usage-deck:<installId>`).
- The error envelope **always** carries a non-empty `message` (and `hint` where one exists),
  including `401`/`403`/`421`: e.g. `{ error: { code: "unauthorized", message: "Bearer token
  missing or invalid", hint: "run `claude-usage configure pairing` on the host" } }`.

## 23.14 Session titles from `/rename` (2026-09-13)

Claude Code's `/rename` gives a session a human title, and the dashboard wants it — a row
reading "Launch daemon work" beats one reading `3f1c0a52-…`. `SessionView` therefore
carries `title: string | null`, `null` when the session was never renamed.

Two sources, in order, because neither alone is complete:

1. **The transcript.** `/rename` writes a `{"type":"custom-title","customTitle":…}` record
   into the session's JSONL. The spend scanner already reads every line of every transcript,
   so it reports these through a `TitleSink` as it goes — no second pass. Last one wins.
2. **The sidecar**, `<transcriptDir>/<sessionId>/custom-title.json`, read on demand when the
   store has no title for that session. This is what covers a rename that happened before
   the daemon existed, or one in a transcript we have not re-scanned.

A title is trimmed, and an empty string is `null` — "renamed to nothing" is not a title.

`refreshTitles()` runs on every token-store change and publishes a `session` `update` for
any session whose title actually changed, so a rename reaches an open dashboard without
waiting for another event. The cache exists to make that comparison: a session seen for the
first time is recorded silently rather than announced as a change.

## 23.15 Pause-rule semantics refined by QA (2026-09-13 evening)
- **One rule per scope.** Posting a rule for a scope that already has one in the *other*
  mode **supersedes** it (soft → hard escalation replaces, never stacks), so
  `GET /v1/pause/rules` never shows two rules for one target and no client has to delete
  the loser. Same `(scope, mode)` is still idempotent (§18.1).
- **Resume cascades downward.** `POST /v1/resume { scope }` lifts every rule *under* the
  target, not only the rule whose scope string matches: `all` lifts everything;
  `project:<key>` lifts that project's rule plus any `session:<id>` rule for a session in
  that project. Resume means "let this run again", so a narrower rule must never survive it.
- **Gate timing (§18.2).** The gate has its own deadline (`GATE_DEADLINE_MS`, 5 s), not the
  §7.1 nudge's 200 ms: gate polls measured 107–300 ms over a LAN address, so the nudge
  budget released paused sessions on latency alone. The gate's sleep timer is **ref'd** —
  an `unref()`ed timer let Node exit mid-sleep, returning from the hook after one poll and
  running the tool anyway. A single transient poll failure no longer releases a pause;
  `GATE_FAILURE_TOLERANCE` (3) consecutive failures do (fail open, never wedge a session).

## 23.16 Hard freeze spares the session's own process (2026-09-13 evening)

`SIGSTOP` on the interactive `claude` process stops the session's TUI. The shell reports it
as `suspended`, takes the foreground back, and after `SIGCONT` the session is a background
job that cannot read the terminal until the user types `fg`. Hard pause is meant to stop
Claude's *work*, not to take the user's terminal away, so:

- **`freezeTree(pid)` `SIGSTOP`s the descendants of `pid`, deepest first, and never `pid`
  itself.** `frozenPids` therefore never contains the session's own pid. Resume `SIGCONT`s
  them nearest-first so a parent shell resumes before the children it owns.
- **The gate does the rest.** Work already in flight is what the freeze stops; the next
  piece of work is stopped by the `PreToolUse` gate (§18.2), which holds for `hard` exactly
  as it does for `soft`. Together they are the pause.
- **Freezing an idle session is a no-op on the process table** and that is correct:
  `frozenPids: []`, nothing stopped because nothing was running, and the next tool call
  blocks at the gate. The CLI renders this as `hard(0)`.
- **A fresh pid is not chased.** A session that re-registers (`claude --resume`) under a
  standing hard rule has its new tree frozen on the next reconcile — which for a
  just-started session means freezing nothing — and is then held at its first gate.
- **A freeze longer than the session's tool timeout costs that tool call.** Claude Code's
  own tool runner keeps its clock running while the subprocess is stopped: the timeout
  fires, its termination signal is delivered to a `SIGSTOP`ed process group and stays
  pending, and on `SIGCONT` the tool gets one boundary in and then dies. Measured: a 3 min
  56 s freeze against Claude Code's 2-minute default Bash timeout killed the in-flight
  command; freezes under a minute left the same loop running. The session itself survives
  and sees a timeout error. This is inherent to stopping subprocesses rather than the TUI —
  the alternative (stopping the TUI) is what §23.16 exists to avoid — so it is documented,
  not fixed. **A long hard pause costs the frozen tool call.**

### Reconciler bookkeeping

Because an empty `frozenPids` is now a legitimate frozen state, "already frozen" can no
longer be `frozenPids.length > 0`. Two fields on the stored session carry it:

| Field | Meaning |
| --- | --- |
| `frozenPid` | The root pid the recorded freeze belongs to; `null` when nothing is frozen. `apply()` freezes when `frozenPid !== pid`, which also makes a re-registered session freeze its new tree. Not on the wire. |
| `freezes` | How many times this pause has frozen the session's tool tree. Survives a re-register; reset to `0` when the pause ends. Exposed on `SessionPause`. |

`SessionPause` gains `freezes: number` — `0` under a soft rule, `1` for a session frozen
once, `2+` once a re-register or a daemon restart sweep has frozen it again under the same
standing rule. That is what lets a dashboard tell "frozen again after re-register" from
"frozen once".

A hard → soft downgrade clears `frozenPid` (so a later re-escalation freezes again) but
keeps `freezes`; only ending the pause resets the counter.

## 23.17 Release-tag namespace shared with the Android dashboard (2026-09-14)

The Android dashboard lives in this repo on the orphan branch `usage-android` (formerly
`usage-deck`; its release tags stay `deck-`) and publishes its APK from the same GitHub
Releases both updaters read. The iOS/watch app lives on `usage-ios` and publishes to TestFlight
only — no GitHub Release. Two artifacts, one release feed, so the
tags are namespaced:

| Artifact | Tag | Assets | Flag |
| --- | --- | --- | --- |
| daemon | `v<semver>` | `claude-usage-<version>.tgz`, `SHA256SUMS` | normal release |
| dashboard APK | `deck-<version>` | `usage-deck.apk`, `usage-deck.apk.sha256` | pre-release — never "latest" |

- The daemon's updater reads `/releases/latest`, which already excludes pre-releases, so a
  correctly published APK release is invisible to it. The dashboard's checker considers only
  `deck-` tags.
- **Belt and braces:** `check()` also skips any tag matching `FOREIGN_TAG_PREFIXES`
  (`deck-`, and `ios-` as belt and braces for the iOS app, case-insensitive) and reports it as *no update available*, not as an error. An
  error would be worse than useless: `/releases/latest` returns exactly one release, so a
  mis-flagged APK would both fail the check and hide the next real daemon release behind a
  persistent "malformed release" state.

## 23.18 The update restart cannot rely on the exit code alone (2026-09-14)

§20 and the restart-policy note in `src/update/index.ts` assume the supervisor acts on a
non-zero exit. On the Mac Studio it did not, and the daemon updated itself to v0.1.72 and
never came back.

**Cause.** The job was bootstrapped over SSH. `launchctl print gui/501/<label>` showed
`pended nondemand spawn = speculative`, `runs = 0` with `runatload` set — an SSH session
cannot drive spawns in that GUI domain. `KeepAlive` never fired either: a `kill -9` on a
job that had been up well past `minimum runtime = 10` left it down indefinitely.
`launchctl kickstart -k` always worked, which is why the machine looked healthy after every
manual intervention.

**Fix.** `defaultRestart()` now *asks* the service manager for a restart
(`launchctl kickstart -k`, `systemctl --user restart`) and falls back to
`process.exit(UPDATE_RESTART_EXIT_CODE)` after `RESTART_GRACE_MS` (5 s) — or immediately
when there is no service manager, the request throws, or the manager is `noop`. Belt and
braces: the exit alone fails on a job whose `KeepAlive` never fires, and the request alone
fails when the daemon runs in the foreground. Unit files and the exit code are unchanged, so
a healthy machine behaves exactly as before.

## 23.19 The last good limits survive a restart (2026-09-14)

Found from the dashboard side during pause-leg QA: right after an auto-update restart,
`/v1/summary` served `limits: []` with `fetchedAt: null`, and the first poll came back
`HTTP 429`. The phone had nothing to show, despite correct numbers having been known a
second earlier — they only ever lived in the memory of the process that just exited.
Auto-update makes restarts routine, so this is now a regular hole rather than a rare one.

- `LimitsPoller` takes an optional `configDir` and persists each successful snapshot to
  `<configDir>/limits-cache.json` (`LIMITS_CACHE_VERSION` 1).
- On construction it restores that snapshot with `stale: true` and `error: null`, so a
  freshly started daemon answers with real percentages before its first poll lands.
- `raw` is **not** cached. The cache exists to answer with percentages, not to leave a copy
  of the account payload on disk.
- A cache that is absent, unparseable, of another version, or missing `fetchedAt` is ignored
  — `fetchedAt: null` is indistinguishable from "never fetched".
- Entries are validated field by field, not cast. This file is ours and 0600, but it is the
  one input that reaches `/v1/summary` — and a dashboard — without an upstream call to
  sanity-check it. A limit with no `id`/`kind`, a non-numeric or non-finite `percent`, or an
  empty list drops the **whole** cache rather than serving a half-believable one; a bad
  `legacyWindows` entry is dropped on its own.
- Omitting `configDir` disables the cache entirely, so one-shot CLI reads never touch it.
- The existing failure path is unchanged: a failed poll still serves the last good snapshot
  with `stale: true` and the error attached, and the interval still backs off.

## 23.20 An install over ssh yields a service launchd will not supervise (2026-09-14)

Same root cause as §23.18, stated as the install-time defect it really is.

Bootstrapping a LaunchAgent from a non-GUI session — `claude-usage install` run over ssh —
registers the job in `gui/<uid>` but leaves its spawns pended. Measured on two Macs running
the identical plist:

| | installed locally | installed over ssh |
| --- | --- | --- |
| `launchctl print` | `state = running`, `runs = 8` | `state = not running`, `runs = 0`, `pended nondemand spawn = speculative` |
| `RunAtLoad` | fires | does not fire |
| `KeepAlive` after `kill -9` | back within seconds | still down after 30 s |
| `kickstart` | works | works |

The last row is why this hides: `install` already ends with `kickstart -k`, so the daemon is
up and healthy the moment the install finishes, and every later manual fix restores it too.
Nothing reveals the fault until the process dies on its own.

We cannot fix it from inside an ssh session — putting the job in the right domain needs
`launchctl asuser`, which needs root, and an unattended install must not ask for that. So
`LaunchdService.diagnose()` detects the pended spawn and `install` prints it as a note:
the daemon runs, and updates restart it (§23.18), but **launchd will not bring it back after
a crash or a reboot** until the user re-runs `install` from a terminal on that machine's own
desktop.

`diagnose()` returns warnings rather than throwing, and returns nothing when the job is not
loaded at all — that is a different problem with its own reporting.

## 23.21 Keep looking for the tailnet address (2026-09-14)

`config.bind: ["127.0.0.1", "tailscale"]` resolves the tailnet address **once**, at startup.
On a machine where Tailscale starts after the daemon — or is down at boot, or drops — that
resolve fails and nothing ever tries again: both Macs logged
`could not bind 100.x.y.z — EADDRNOTAVAIL` and then served loopback and LAN only, with no
tailnet listener, indefinitely. `SIGHUP` fixes it, but only if a human is there to send one,
and the entire point of the tailnet address is reachability when nobody is at the machine.

- While a wanted tailnet address is missing, the daemon re-runs `reload()` every
  `TAILNET_RETRY_MS` (60 s, `tailnetRetryMs` in tests).
- Once it is bound the timer stops; `SIGHUP` handles later changes, so the steady-state cost
  is zero. A config that never asked for `tailscale` never polls at all.
- "Bound" means *the address the resolver actually returned* is in `boundHosts` — both halves
  matter, because the two failure modes are "no address found" and "address found, bind
  refused", and only the resolve callback sees the first.
- The retry timer is `unref`ed and cleared on stop, so it can never hold the process open.
- **Tailscale switched off on purpose is the common case, not an emergency.** `tailscale ip -4`
  keeps reporting the last-known address after the daemon is stopped, so the resolve succeeds
  and the bind fails, every time. Two consequences are handled explicitly: the retry backs off
  60 s → 10 min (`TAILNET_RETRY_MAX_MS`, reset once bound), and a bind failure is logged
  **once** per distinct message rather than once per attempt, so a deliberately-offline
  machine neither burns subprocesses nor fills its log.

## 23.22 A manual update gets the daemon's hard-freeze guard (2026-09-14)

The daemon's updater defers while any session is hard-frozen (§20), because the restart
thaws the tree on shutdown and hands that session one tool boundary before the new daemon's
sweep re-freezes it — measured from the dashboard side: a tick landed at the exact instant
the old daemon exited.

`claude-usage update` took the same restart but skipped the same check, so a manual update
leaked a tick under a standing hard rule. It now asks the running daemon which sessions are
hard-frozen and refuses, naming them, unless `--force` is given:

- A question, not a prohibition: `--force` proceeds, because an operator updating a machine
  on purpose may well accept the slip.
- `--check` never asks — it restarts nothing.
- A daemon we cannot reach reports none: there is then nothing running to disturb, and a
  dead daemon must never block a manual update.

## 23.23 Registration gets its own deadline, and a retry (2026-09-14)

Found in QA: two throwaway sessions started 70 s apart from the same command line, on the
same build. One registered within 4 s; the other never did, came up
`discovered: "transcript"` with `pid: null`, and so a session-scope hard pause on it was
refused `409` while a project-scope rule froze nothing (`freezes 0`). The entire session
control surface was silently absent for the life of that session.

Cause: `SessionStart` registration used `HOOK_DEADLINE_MS` (200 ms). That budget exists so
the §7.1 nudge never delays a **prompt** — but registration is not on the prompt path, it
runs once before the session is interactive, and it is the call everything else depends on.
Exactly the mistake §23.15 fixed for the gate, in a second place.

- `REGISTER_DEADLINE_MS` = 2 000 ms, used for the `SessionStart` register only. The nudge
  keeps its 200 ms.
- **Retry, but only on a real `404`:** a `UserPromptSubmit` heartbeat that comes back `404`
  means the daemon answered and does not know this session — most often a register that
  missed. The hook re-registers, then gates. `register` is idempotent, so a re-register with
  an unchanged pid is a no-op.
- **Not on a missing daemon.** A daemon that is down fails the heartbeat too, and retrying
  there would run the one-shot git probe on *every prompt* for as long as it stayed down —
  paying real prompt latency to reach something that is not there, which is the exact cost
  §7.1's 200 ms budget exists to prevent. `DaemonUnreachable` therefore carries `status`: the
  HTTP status when the daemon answered, `undefined` when there was nothing to answer. Every
  other caller keeps treating both the same.
- The hook still prints nothing and still exits 0 whatever happens. No hook behaviour is
  conditional on the daemon existing.

## 23.24 A session we watched stop must not come back to life (2026-09-14)

Reported from the phone: a session killed at 08:33 still read "1 live" at 08:40. Not a
display bug — the daemon really did say `alive: true`.

Two timers with a gap between them. A registered session whose pid dies is marked dead and
kept for `DEAD_RETENTION_MS` (5 min) so the dashboard sees the exit, then dropped. Once it
is gone from `sessions.json`, the transcript back-fill picks it up again as a
`discovered: "transcript"` session and calls it alive if its transcript was written inside
`TRANSCRIPT_ALIVE_MS` (10 min) — which, five minutes after the kill, it was. So the session
reappeared as live for the remaining five minutes of that window.

A recently-written transcript is evidence of recent activity, never of a running process.
The registry now keeps **tombstones**: `sessionId → when we last knew it was not running`,
set when a dead session is dropped and when `SessionEnd` arrives, and consulted by the
back-fill.

- The back-fill's `alive` becomes `age < TRANSCRIPT_ALIVE_MS && !buried(id)`. The session is
  still listed, with its tokens — it is reported honestly as not alive, not hidden.
- Tombstones are persisted in `sessions.json` (`ended`), so a daemon restart inside the
  window does not resurrect what the previous process had already buried.
- They expire after `TRANSCRIPT_ALIVE_MS`, past which they decide nothing, and are pruned on
  every save.
- `register` lifts a tombstone immediately: a session that registers again is demonstrably
  back, whatever we believed a moment ago.

### §23.25 The §23.20 check could never fire from an install (2026-09-14)

§23.20 shipped a `LaunchdService.diagnose()` that warns when `launchctl print` contains
`pended nondemand spawn`. It was verified against a synthetic fixture and never against the
path that calls it, and on that path it cannot fire.

`install()` ends with `kickstart -k`, so the job is always **running** by the time
`apply.ts` asks for warnings — and `pended nondemand spawn` is only printed while the job is
**not running**. The warning was unreachable from the only code that calls it, on every
machine, in every case it was meant to catch.

Measured on the two Macs, from one ssh session on the Studio:

| | Mac Studio (installed over ssh) | MacBook (installed from its desktop) |
| --- | --- | --- |
| `kill -9`, then wait | still down after 60 s, `runs` frozen at 7 | back unattended in 5 s, `runs` 15 → 16 |
| `pended nondemand spawn`, running | absent | absent |
| `pended nondemand spawn`, 20 s after the kill | `= semaphore` | n/a |

While both daemons are up their `launchctl print` output is byte-identical apart from the
node path. `runs`, `properties = runatload` and `last terminating signal` were all checked
and none separate a supervised job from an unsupervised one. `immediate reason` looked
promising — `semaphore` on the healthy Mac against `non-ipc demand` on the Studio — but it
only reports how the *current* instance was started: a `kickstart` on the healthy MacBook
flipped it to `non-ipc demand`, and that machine still self-healed from a `kill -9`. There
is no static field that distinguishes them.

So `diagnose()` now reads the **cause** rather than a symptom: `launchctl managername`,
which is `Aqua` in the GUI login session and `Background` or `StandardIO` over ssh. That is
knowable at install time regardless of job state, and it is what actually determines whether
launchd will supervise what we just bootstrapped.

- The `pended nondemand spawn` branch is kept — when the job happens to be down it is the
  fault caught in the act — and returns first.
- Otherwise a non-`Aqua` manager name warns, naming the session in the message.
- A manager name that cannot be read is not a finding. The diagnostic still never throws.

Verified end to end on both machines against the built `dist`: `Aqua` → no warnings on the
healthy MacBook; `Background` → the warning, on a Studio daemon that was running, answering
health checks, and printing clean.

**Grep the whole phrase.** `pended` is a substring of `started suspended = 0`, which every
healthy job prints twice, so a loose `grep -c pended` returns 2 on a perfectly good machine —
a false "still broken" in the direction that gets someone to re-install something that was
fine. Caught by the Studio-side session during this work, before it reached the code.

**Still open, and not fixable from here.** The Studio's service remains unsupervised: the
repair needs an `install` from that machine's own desktop, which is a GUI session no ssh
login can reach without root. What changed is that the installer now says so.

### §23.26 `install` lost a race with its own `bootout` (2026-09-14)

The first desktop `install` on the Mac Studio — the one §23.25 exists to make people run —
failed and left the machine **worse than it started**: daemon down, LaunchAgent not
registered at all.

```
ServiceError: launchctl kickstart -k gui/501/com.github.drmuzikbpn.claude-usage failed (exit 37)
```

Exit 37 is `EALREADY`. `launchctl bootout` returns before launchd has finished tearing the
job down, and anything landing in that window gets it. The sequence was: `bootout` succeeded
→ `bootstrap` hit the tail of it and failed into the *tolerate* branch, silently →
`kickstart -k` failed the same way and, not being tolerated, threw → `runInstall` aborted
before the hooks, the MCP registration and the §23.25 diagnostic. Nothing was loaded
afterwards: `launchctl print` reported the service as not found.

The tolerate-on-bootstrap rule came from the right instinct — "aborting after the bootout is
worse than a redundant load" (§23.9) — but tolerating is the wrong response to a *race*.
A race should be waited out.

- `bootstrap` is retried up to `BOOTSTRAP_ATTEMPTS` (5) times, `BOOTSTRAP_RETRY_WAIT_MS`
  (400 ms) apart, but **only** on `EALREADY`. Any other failure is tolerated exactly as
  before, and the retries give up rather than looping.
- `kickstart -k` now accepts `EALREADY` as success. In a GUI session `RunAtLoad` genuinely
  fires, so the explicit kickstart can arrive while launchd is already starting the job —
  which means this failure mode gets *more* likely on precisely the machines where the
  install is finally being done correctly. Every other kickstart failure still throws.

Ordering note for anyone reading `install()`: the explicit `kickstart` exists because
`RunAtLoad` does **not** fire from a non-GUI session (§23.20). It is not redundant; it is the
thing that makes an ssh install produce a running daemon at all. It just must not treat "the
job is already coming up" as a failure.

**The same mistake, a third time, in the same function.** With the race fixed, the Studio's
next install succeeded — and printed no warning, though `diagnose()` returned one correctly
when called by hand a moment later. `diagnose()` read `launchctl print` first and returned
`[]` on a non-zero exit; the installer calls it immediately after `bootstrap` + `kickstart`,
and `print` can still be failing in that settling window. So the check computed the right
answer and threw it away, on the one machine it was written for.

The session type does not depend on the job being loaded, so it is now asked **first** and
`print` is consulted only afterwards, for the pended line. Guarded by a test that fails
against the old ordering.

**What this cost, and the general shape of it.** Both §23.25 and this were introduced by
work whose stated purpose was to make remote installs safer, and both made the remote-install
path worse in a way that only showed on a real machine. The unit tests passed throughout:
`fakeExec` returns exit 0 for everything, so no test had ever exercised a launchctl that
answers `EALREADY`. A fake that always succeeds cannot catch a race.

### §23.27 `install` exited 0 in the middle of its own verification (2026-09-15)

With §23.26 fixed, three consecutive installs on the Mac Studio succeeded — and each one's
output stopped dead after `mcp: registered via direct merge`. No status table. No notes. No
§23.25 warning, though `diagnose()` returned it correctly when called by hand seconds later.
Exit code 0 every time.

`defaultSleep` unref'd its timer:

```ts
const t = setTimeout(resolve, ms);
if (typeof t.unref === 'function') t.unref();
```

`verifyHealth` polls `/health` every 250 ms for 5 s. When the daemon has not finished
starting, the probe fails fast — a refused connection leaves no lingering handle — so that
retry timer is the **only** thing on the event loop, and an unref'd timer does not hold the
process open. Node ran out of work and exited 0, mid-`await`, before

- the verification result (so a daemon that never came up was reported as a clean install),
- the status table,
- and every collected note, the "launchd will not supervise this service" warning among them.

It reproduces only when the daemon is slow enough to need a second probe, which is why no
local install ever showed it and three remote ones in a row did.

The timer is no longer unref'd. Holding a reference for a few hundred milliseconds is the
whole cost. `defaultSleep` is used by nothing else.

**Coverage.** `verifyHealth` and `defaultSleep` had no tests at all — the step whose entire
job is to notice that an install did not work was the least-tested code in the installer.
`test/install/verify-health.test.ts` now covers the probe/sleep sequence, the give-up budget,
and the ref-held invariant; that last one fails against the old implementation.

**Why three bugs in one evening all hid the same way.** §23.25, §23.26 and this one were each
introduced by work meant to make remote installs safer, and each made the remote path worse
while every test stayed green. `fakeExec` returns exit 0 for every command, and `io.sleep` is
injected in every test that reaches it, so the suite has never seen a launchctl that says
"not yet" nor a real timer. Three different bugs, one blind spot: the tests model the happy
path of a subsystem whose entire purpose is the unhappy one.

### §23.28 The bootout race, measured instead of guessed (2026-09-15)

§23.26 fixed the bootout race by retrying a bootstrap that returned `EALREADY` (37). That
errno came from the `kickstart` line in the user's traceback, and I assumed the bootstrap in
the same window would report the same thing. It does not. With §23.27 fixed so the installer
could finally be *heard*, the next ssh install reported the truth:

```
service     launchd — stopped
daemon      not answering
```

Booting out a **running** job and bootstrapping immediately, measured directly:

```
bootout    rc=0
bootstrap  → "Bootstrap failed: 5: Input/output error"      (EIO)
kickstart  rc=37                                            (EALREADY)
3 s later  → not loaded
```

The errno differs by verb. §23.26's retry never fired, and §23.26's own `kickstart` tolerance
then carried the failure through to a clean-looking exit. Two tolerances in a row turned a
booted-out service into a reported success.

Also worth recording because it defeats the obvious check: **`launchctl print` keeps
succeeding through the whole window.** The dying job is still listed, so "is it loaded?"
answers yes right up until it answers no. It is only useful once the retries are finished.

- The bootstrap retry no longer keys on an errno. Any failure is retried,
  `BOOTSTRAP_ATTEMPTS` (8) times, `BOOTSTRAP_RETRY_WAIT_MS` (500 ms) apart. Guessing which
  error means "not yet" is what failed twice; the cost of retrying a genuine error is a
  four-second install, and the cost of not retrying is a machine with no LaunchAgent.
- `install` then **verifies the end state**: `launchctl print` must succeed after the
  retries, or it throws. Every step before it tolerates something, so the exit codes cannot
  be trusted to describe the result — only the result can.

Verified on the Studio over ssh: three consecutive installs against an already-running job,
each ending `service launchd — running` / `daemon healthy on port 47291` with a fresh pid,
and each printing the §23.25 non-GUI warning.

**The pattern across §23.25–§23.28.** Four bugs, one habit: I inferred a mechanism from a
single observation and shipped the inference. `pended nondemand spawn` was assumed to be
readable at install time; the `print` ordering was assumed to be what swallowed the warning;
`EALREADY` was assumed to be the bootstrap's errno. Each was a plausible reading of real
evidence, and each was wrong in a way a two-minute measurement on the actual machine would
have caught. The measurements in this section are all things that could have been run before
the corresponding fix, not after.

### §23.29 A second `install` aborted on its own idempotency (2026-09-15)

The Mac Studio's next desktop install died at the MCP step:

```
Error: `claude mcp add --scope user claude-usage -- .../claude-usage mcp` failed (exit 1):
MCP server claude-usage already exists in user config
```

`install` is idempotent by design and re-running it is the documented repair for §23.25, so
"already exists" is the end state it is asking for, not a failure. `removeMcpServer` says
exactly that in a comment — "uninstall must stay idempotent, so that is not an error" — and
`addMcpServer` did not. The registered command is `current/bin/claude-usage`, a symlink
stable across versions, so an existing entry is also the correct entry.

Two fixes, and the second matters more than the first:

1. `tryClaudeCli` treats an "already exists" failure as success.
2. **The MCP step can no longer abort the install.** It is the least important thing `install`
   does and the only one depending on another tool's CLI, and it runs *after* the service is
   in place but *before* the status table and the notes. So the machine was left fully
   configured while saying nothing — and the note it swallowed was the §23.25 "launchd will
   not supervise this service" warning, which was the entire reason for walking over to the
   machine. A failure there is now a note, like every other partial outcome.

**The recurring shape, now five for five.** §23.9 established it: *aborting after the bootout
leaves the daemon down*. §23.26, §23.27, §23.28 and this are all the same rule broken in a
different place — a late step failing loudly, or exiting silently, and destroying the report
of the steps that already succeeded. An installer's output is not a courtesy; on a machine
the user cannot easily inspect it is the only channel there is. Anything after the service
step must degrade to a note.

### §23.30 The ssh-install diagnosis was wrong (2026-09-15)

§23.20 and §23.25 assert that a service launchd will not supervise is caused by installing
from a non-GUI session, and that re-running `install` from the machine's own desktop repairs
it. **Both claims are false.** They shipped in the installer's warning text, in `README.md`
and in `docs/smoke-test.md`, and they sent a user to the machine three times to run a command
that could not have worked.

The disproof: `install` was run on the affected Mac from its own desktop, as the console
user, in an `Aqua` session, completing cleanly and emitting no warning. `kill -9` then left
the daemon down for a full 60 s watch with `runs` frozen. launchd's own log says why:

```
pending spawn, domain in on-demand-only mode: com.github.drmuzikbpn.claude-usage
```

That is a property of the `gui/<uid>` **domain**. The installing session was never the
variable. The original evidence — an ssh-installed machine that was pended — was real, but
"installed over ssh" and "pended" were two attributes of one machine, and I read a cause into
the coincidence.

Ruled out since, each with a measurement rather than an argument:

| Candidate | Killed by |
| --- | --- |
| launchd disabled database | `launchctl print-disabled gui/<uid>`: absent on both machines |
| Non-GUI install session | Both `Aqua`; affected machine installed from its own desktop |
| Not the console user | `/dev/console` owned by the logged-in user on both |
| Screen locked | No lock key present on either |
| Plist or domain differences | Both prints 77 lines, identical but for the node path |
| Installed before login | True on both; the healthy Mac's console login predates its install |
| `immediate reason` | Reports how the *current* instance started; a `kickstart` flips a healthy Mac to `non-ipc demand` and it still self-heals |
| Domain `on-demand count` | Unchanged across bootout, bootstrap and kickstart of this job |

**Consequence for the code.** `diagnose()` no longer reads `launchctl managername`. That
detector was wrong in both directions: a false positive for an ssh install on a healthy
domain, and a false negative for the case that actually bit. What remains is the
`pended nondemand spawn` phrase, which is definitive but only printed while the job is not
running — so the check stays quiet during an install rather than guessing, and the warning
describes the symptom without prescribing a remedy that was measured not to work.

A check that cannot fire is worse than one that can. A check that fires with the wrong remedy
is worse than both.

**Open.** The cause of the domain state, and therefore the repair. The untried candidate is a
reboot, which rebuilds the domain; that is a measurement, not a theory, and this section will
say which it turned out to be.

**The method failure, stated plainly.** §23.25 through §23.29 were five real defects found and
fixed in one evening, every one of them uncovered by running the thing on a real machine. This
section is the sixth finding and it invalidates the premise the first two were written under.
The common cause is not haste — it is that I repeatedly inferred a mechanism from a single
correlation and shipped the inference with a confident remedy attached. `/usr/bin/log show`
was available from the first minute and answered the question outright. Ask the system what it
is doing before telling a user what to do about it.

### §23.31 An account switch kept serving the previous account's limits (2026-09-16)

Reported from the deck: after the Mac Studio was switched to a different Claude account,
its daemon reported the **new** email address alongside the **previous** account's
percentages — same weekly 95%, same 5 h 24%, and the same reset instants to the minute as
the other machine still on the old account. Identical reset boundaries across two accounts
is what made it read as a cache rather than a coincidence.

It was not the `limits-cache.json` of §23.19 — that file is read once in the constructor
and overwritten by the first successful poll. The daemon was fetching live numbers the
whole time. It was fetching them **as the previous account**.

**Cause: two reads of "who am I" with different lifetimes.**

| Read | Store | Lifetime |
| ---- | ----- | -------- |
| identity (`oauthAccount`) | `~/.claude.json` | re-read every 10 min (`USER_REFRESH_MS`) |
| token | Keychain / credentials file | **read once per process** |

`createTokenReader` cached the access token for the life of the daemon, re-reading only
when asked for a `fresh` one — and the only caller that ever asked was the once-on-401
retry path. That was sound under the assumption it encoded: *a token that is no longer the
right one will 401*. An account switch breaks exactly that assumption. The previous
account's token is not revoked; it stays valid, every poll returns 200, and no 401 ever
fires. So identity moved on its 10-minute timer and the token never moved at all.

**Fix.** The token cache gets a TTL — `TOKEN_REFRESH_MS`, deliberately the same 600 000 ms
as `USER_REFRESH_MS`. The two constants answer the same question from different stores and
must not be allowed to disagree; that disagreement *is* this bug. The TTL is a correctness
property here, not an optimisation.

`POST /v1/refresh` now reads the credential store with `{ fresh: true }` rather than
reusing the cached token, so there is a manual escape hatch that does not require a daemon
restart. A refresh that lands on top of an in-flight scheduled poll still joins that poll —
one interval late, not wrong.

**Bound on the symptom:** up to 10 minutes of mismatched identity-and-limits after a
switch, self-healing, or immediate via `POST /v1/refresh` (there is no `refresh`
subcommand on the CLI — the endpoint is the only manual trigger).

**Test-first, per Part III:** all three tests were watched to fail against the unfixed
code — the TTL boundary, a token swapped underneath the reader with no 401 (the reported
bug, reproduced), and `refresh()` reading fresh rather than reusing the cache.

### §23.32 An upstream 429 is its own error, and `Retry-After` is honoured (2026-09-25)

Found live: from 10:51Z every poll of `GET /api/oauth/usage` answered `HTTP 429` for more
than eleven hours. A manual probe showed the response carries `retry-after: 3023` (seconds)
and a `rate_limit_error` body. The daemon mapped it to `error.code: "network"` — telling
callers to suspect their connection — and retried on its own backoff, capped at 10 min, so
it kept calling back well inside the window it had just been told to stay out of. Every
auto-update restart (and a manual `kickstart -k`) reset the backoff and polled immediately.

**Fix.**
- `fetchLimits` maps 429 to `LimitsError('rate_limited')` and parses `Retry-After` in both
  RFC 9110 forms (delay-seconds, HTTP-date) into `retryAfterMs`; absent, garbage or
  negative values leave it undefined. `HttpResponseLike.headers` is optional so test doubles
  need not model it.
- `LimitsErrorInfo` gains `retryAt` (ISO 8601). The poller serves `{ code: "rate_limited",
  message: "Anthropic is rate-limiting the usage endpoint (HTTP 429); next attempt after
  <retryAt>", hint, retryAt }` alongside the last good numbers.
- No scheduled poll and no `refresh()` calls upstream before `retryAt`. `Retry-After` is
  capped at `MAX_RETRY_AFTER_MS` (6 h): a value in days is likelier a parse or clock fault
  than an instruction.
- The window is persisted as `rateLimitedUntil` in `limits-cache.json`, read independently of
  the snapshot so it survives even a 429 before any successful fetch. A restarted poller
  inside the window schedules rather than polls, and reports the error from its first request.
- The MCP headline reads `rate-limited by Anthropic (HTTP 429) until <UTC minute> · numbers
  from <UTC minute>`.

### §23.33 Staying under the usage endpoint's budget (2026-09-25)

The budget is unpublished, so the daemon is built to need less of it and to learn from a 429:

- **Slower default, with a floor.** `pollIntervalMs` defaults to 300 000. Configs written
  with the old 60 000 default are raised to `MIN_POLL_INTERVAL_MS` (120 000) with a log line,
  not rejected — rejecting would stop an installed daemon from starting.
- **Adaptive slow-down.** Each 429 doubles the effective interval, up to
  `MAX_ADAPTIVE_INTERVAL_MS` (30 min); `RELAX_AFTER_SUCCESSES` (12) consecutive good polls
  halve it again, never below the configured interval. In memory only; the persisted
  `rateLimitedUntil` covers restarts.
- **No poll on restart when the cache is fresh.** A cached snapshot younger than the interval
  delays the first poll until it is due.
- **Refresh counts scheduled polls.** `POST /v1/refresh` is served from cache (the local
  `429 rate_limited` envelope, which the MCP tool turns into the current limits) within
  `REFRESH_MIN_INTERVAL_MS` (now 60 s, was 10 s) of *any* upstream call, not just the
  previous refresh.

**Test-first, per Part III:** `test/limits-rate-limit.test.ts`. The §23.32 tests were watched
to fail against the unfixed code; each §23.33 behaviour was checked by mutation (restart
delay, adaptive doubling, attempt tracking, in-window refresh) and every mutant failed a test.

### §23.34 An honest User-Agent on the usage call (2026-09-25)

After §23.32/§23.33 shipped, the 429 renewed for another hour at the first call after
`retryAt`, while Claude Code's own `/usage` — same endpoint, same Keychain token — succeeded
mid-block. The likeliest reading is a limit keyed on client identity rather than the account.
The daemon was sending Node's default `User-Agent`.

`fetchLimits` now sends `User-Agent: claude-usage/<version>` (`USER_AGENT`, from
`getVersion()`), so upstream sees this client as what it is. Deliberately **not** Claude
Code's identifier: borrowing it to share Claude Code's allowance would be disguising a
third-party client to get around a rate limit. Retry-After handling is unchanged.

### §23.35 Limits state transitions are logged at the default level (2026-09-26)

When the §23.32 block cleared, the log could not say which call first succeeded: poll
outcomes were logged only at verbose level, and the cache keeps only the latest good fetch.

`LimitsPoller` takes a `notice` sink, which the daemon wires to its default log. It writes one
line per state change, and nothing in steady state:

- `limits: ok`
- `limits: rate_limited by Anthropic (HTTP 429) — next attempt after <retryAt>` (or
  `no Retry-After given`); a new `retryAt` counts as a change, so every re-armed window is
  on record
- `limits: fetch failing (<code>) — <message>`; a repeat of the same code is not logged again
- a window restored from `limits-cache.json` at startup is logged with
  ` (window from a previous process)`.

Polling behaviour is unchanged.

### §23.36 Headline limits from Claude Code's statusline input (2026-09-26)

§23.33's budget turned out far smaller than one call per 30 min: after the block cleared at
~07:32Z, four calls in ~82 min (the last two 30 min apart) earned another hour's 429. Polling
this endpoint cannot keep numbers live. Claude Code, though, reads
`anthropic-ratelimit-unified-5h/7d-*` from every model response and hands its statusline
command `rate_limits: { five_hour: {used_percentage, resets_at}, seven_day: {…} }` — live
numbers at no upstream cost.

- **Ingest.** `POST /v1/limits/observed`, bearer-gated like every mutating route (no loopback
  exemption). Body: the `rate_limits` object verbatim. `LimitsPoller.observe` validates it
  field by field and all-or-nothing, so garbage never overwrites a good reading. It stamps
  `observedAt` with the daemon's clock. Observations are in memory only. (§23.42 carries
  the fresh ones across a restart.)
- **Client.** `claude-usage observe` reads statusline JSON on stdin, POSTs `rate_limits` with
  the config's token (400 ms timeout), prints nothing, and always exits 0. It skips a payload
  byte-identical to the last one it sent within `OBSERVE_DEDUPE_MS` (60 s), recording a send
  only after the daemon accepted it. `claude-usage statusline` does the same, concurrently
  with its render. A user's own statusline adds one documented line; nothing here edits it.
- **Precedence.** `five_hour` → `session`, `seven_day` → `weekly_all`. For those ids,
  whichever of the observation and the last upstream fetch is newer wins (ties to the
  observation). `weekly_scoped:*` and `extraUsage` come only from upstream. (`legacyWindows`
  did too until §23.37 made it mirror the observation.)
  Every served row carries `source` (`upstream` | `statusline`) and `asOf`. Observed rows get
  `severity: null`, because upstream severity describes an older reading.
- **Staleness.** An observation is used for `OBSERVATION_TTL_MS` (15 min) and never at or past
  its own `resets_at`. Claude Code keeps serving the last header values while its requests
  are refused, so the reset is the only honest expiry. Snapshot `stale` is `false` whenever
  an observation is applied; otherwise it keeps its upstream meaning. (§23.40 replaced this
  with per-row `stale` and a headline-based snapshot `stale`.) The upstream `error`
  (e.g. `rate_limited` + `retryAt`) is still reported.
- **Upstream polling.** While any observation is fresh, the poll interval is at least
  `OBSERVED_UPSTREAM_INTERVAL_MS` (1 h), and only for what observations lack. Otherwise the
  §23.33 adaptive schedule applies. This is evaluated when each poll is scheduled.
  Retry-After, the refresh floor and the persisted window are unchanged.
- **MCP.** The headline adds `live from Claude Code as of <UTC minute>`. While upstream is
  429ing it dates the rest as `Anthropic numbers from <fetchedAt>`.

**Test-first, per Part III:** `test/limits-observed.test.ts`. Mutation-checked: skipping a bad
window instead of rejecting, ignoring `resets_at`, dropping newer-wins, not clearing `stale`,
and dropping the dedupe each fail their named test.

### §23.37 `legacyWindows` follows observations; a lapse is pushed (2026-09-26)

The first live observation exposed two gaps in §23.36.

- **`legacyWindows` lagged.** It stayed upstream-only, so one body said `session` 41%
  (`statusline`) beside `five_hour.utilization` 3 (upstream, two hours old). That number has
  no provenance, so anyone reading it gets a wrong answer. `legacyWindows.five_hour` /
  `.seven_day` are now replaced by the observation whenever the matching `limits[]` row is.
  They use the same freshness and newer-wins rules and carry the unrounded
  `used_percentage`. When the observation lapses they fall back to upstream.
- **A lapse was silent to push clients.** A pull read (`GET /v1/limits`, `get_limits`)
  re-evaluates freshness on every call. SSE `limits` events, though, fired only on a poll or
  an observation. After the last render, a push client could keep a "live" figure for up to
  `OBSERVED_UPSTREAM_INTERVAL_MS` (1 h). The poller now arms a wake-up for the earliest lapse
  (`observedAt + OBSERVATION_TTL_MS`, or the window's own `resets_at` if sooner). The wake-up
  runs the usual change check, so the event carries the upstream rows with their own `asOf`
  and `stale` back at its upstream value. The wake-up is armed only while the poller runs,
  and `stop()` clears it.

**Test-first, per Part III:** `test/limits-observed.test.ts`. Mutation-checked: not
mirroring, mirroring the rounded percent, no wake-up, and a wake-up left behind by `stop()`
each fail a named test.

### §23.38 Incremental scans skip unchanged transcripts; flushes have a floor (2026-09-26)

The 0.1.98 daemon ran at 100–450% CPU. In `sample`, V8 major-GC marking and `open`/`stat`
dominated. There were 6,179 transcripts (4.4 GB) under `~/.claude/projects`, and ~10 live
sessions were appending to them.

- **Cause.** Each watcher flush ran `scanAll`, and `scanAll` opened, `fstat`ed and closed
  *every* transcript. `scanFile` allocated a fresh 1 MB buffer for each one, even when its
  size still equalled its stored offset. Measured on the real tree, an incremental pass with
  nothing new cost ~1.6 s of CPU (~6 GB of garbage buffers). The 500 ms debounce triggered
  a pass on nearly every burst of writes.
- **Skip unchanged files.** The walk has already `stat`ed each file. If `size === offset`,
  `scanAll` records the offset and reports progress without opening the file. `size < offset`
  (truncation, §23.8) still goes through `scanFile`, so it is still reported as `restarted`.
  `ScanAllResult.filesRead` counts the files actually opened.
- **Right-size the buffer.** `scanFile` allocates `min(CHUNK_SIZE, size - offset)`.
- **Flush floor.** `TranscriptWatcher` starts at most one flush per
  `DEFAULT_MIN_FLUSH_INTERVAL_MS` (5 s). A debounce expiry inside the floor is held, never
  dropped: one flush runs when the floor lapses and covers everything since. `stop()` clears
  the held timer. Token figures can lag a write by up to ~5.5 s.
- **Measured** on the same tree: an incremental pass went from ~1.6 s CPU to ~0.17 s, which
  is now mostly the directory walk. With the floor, the worst case is ~0.17 s every 5 s.

**Test-first, per Part III:** `test/spend/scanner.test.ts` and `test/spend/watcher.test.ts`.
Mutation-checked: no skip, skipping truncated files too, no floor, and dropping instead of
holding each fail a named test.

### §23.39 SSE back-pressure is a `false` write, not a non-empty buffer (2026-09-27)

Every `/v1/events` client, including a fast `curl`, was destroyed 30–36 s after connecting.
Clients reconnect after `retry: 3000`, which hid it. It surfaced while watching for §23.37's
lapse event.

- **Cause.** `write()` marked a client backed up when `res.write()` returned `false` *or*
  `res.writableLength > 0`. On a live socket `writableLength` is non-zero straight after
  every successful write (it is 0 again a tick later). Node emits `'drain'` only after a
  `false` write, so `backedUpSince` was set on the first event and never cleared. The sweep
  then evicted the client once `SLOW_CLIENT_MS` had passed.
- **Fix.** Only a `false` return from `res.write()` starts `backedUpSince`. A `true` write or
  `'drain'` clears it. A genuinely stalled client still stops getting `true` from its
  writes and is still evicted after 30 s, as the existing test checks.

**Test-first, per Part III:** `test/server/events.test.ts`, "keeps a client that is reading
along". Mutation-checked: restoring the `writableLength` condition fails it.

### §23.40 Old readings, reset windows and per-row `stale` (2026-09-27)

Three defects seen in the wild once §23.36 was live:

- **Idle sessions overwrote live readings.** `session` flipped between 3% and 10% within
  seconds. It was one account, not two: every open session posts its statusline, and an idle
  session re-renders with the numbers from its last model response, possibly hours old.
  Arrival order decided the winner. **Fix:** `observe()` compares readings by their data, per
  limit id, while the held window is still open. A reading from an earlier window is
  ignored, and so is a lower one for the same window. Usage only climbs inside a window.
  Windows count as the same when their `resets_at` values are within
  `SAME_WINDOW_TOLERANCE_MS` (30 min). An equal reading is taken and refreshes `asOf`. The
  rule holds even after the held observation's 15 min TTL runs out, so a lone idle session
  cannot bring an old number back.
- **A reset window fell back to a dead upstream number.** At 05:00:04Z the session
  observation expired at its `resets_at`, and `session` fell back to the 23:40 upstream row,
  26%, from the window that had just ended. **Fix:** an upstream row whose `resetsAt` has
  passed is served with `percent: null`, `severity: null` and `stale: true`. A
  `legacyWindows` entry whose `resetsAt` has passed gets `utilization: null`.
- **`stale` hid it.** Snapshot `stale` was `false` whenever *any* observation applied, and
  `weekly_all`'s was still live. **Fix:** every row carries `stale`. Statusline rows are
  `false`. Upstream rows are `true` after a failed poll or once their window has reset.
  Snapshot `stale` is `true` when any headline row (`session`, `weekly_all`) is stale, and
  keeps its upstream meaning when neither is present. A stale `weekly_scoped:*` row does not
  set it; clients read that row's own flag.

**Test-first, per Part III:** `test/limits-observed.test.ts`. Mutation-checked: accepting a
lower same-window reading, accepting an earlier window, not nulling reset rows, not nulling
reset `legacyWindows`, and the old snapshot `stale` rule each fail a named test.

### §23.41 The hook names the day of a far-off reset (2026-09-28)

The warn nudge read `7d window 85% (resets 02:00)` for a weekly reset three days away, which
reads as "tonight". `formatResetsAt` now takes the clock and renders `resets Thu 02:00` when
the reset is 24 h or more away. Sooner resets keep `resets 14:35`.

**Test-first, per Part III:** `test/hook.test.ts`. Mutation-checked: dropping the weekday
branch fails it.

### §23.42 Observations survive a restart (2026-09-28)

The auto-update to 0.1.103 restarted the daemon at 00:15:46Z. Observations were in memory
only, so for about two minutes `/v1/limits` served the restored 21:10Z upstream cache:
session 1% and weekly 81%, both correctly `stale`. The live numbers were 21% and 86%. A
dashboard sees that as a sudden drop on every auto-update.

- **Persist.** `stop()` writes the fresh observations to `limits-cache.json` (0600, via
  `writeJsonFile`) under `observed`, in `observe()`'s own body shape plus `id` and
  `observedAt`. The daemon's SIGTERM path already calls `stop()`. The key is omitted when
  nothing is fresh.
- **Restore.** The constructor reads them back through the same field-by-field validator.
  §23.36's TTL and `resets_at` expiry still apply, measured from the original `observedAt`.
  §23.40's old-reading rule therefore also holds across a restart.
- **Polling.** `start()` applies §23.36's hourly upstream interval when restored
  observations are fresh, so a restart no longer spends an upstream call on numbers it
  already has. It also schedules §23.37's lapse wake-up for them.

**Test-first, per Part III:** `test/limits-observed.test.ts`. Mutation-checked: not
restoring, not writing on `stop()`, ignoring the interval rule in `start()`, and not
scheduling the wake-up each fail a named test.

### §23.43 A closed stdout pipe is not a crash (2026-09-28)

`claude-usage status | head -1` printed an unhandled `EPIPE` stack trace, because `head`
closed the pipe while the CLI was still writing. `main()` now installs
`exitQuietlyOnEpipe(process.stdout)`, which exits 0 on `EPIPE` and rethrows any other stdout
error. This also covers `mcp` whose client has gone and a hook whose reader closed early, which must exit 0 regardless.

**Test-first, per Part III:** `test/cli.test.ts`, "stdout closed early".

### §23.44 The `lan` bind keyword, re-resolved automatically (2026-10-01)

The iPhone/watch app must work on the same Wi-Fi without Tailscale. `config.bind` gains a second
keyword, `lan`, next to `tailscale`.

- **Resolution.** `lan` is the first non-internal RFC 1918 IPv4 address (`10/8`, `172.16/12`,
  `192.168/16`) in `os.networkInterfaces()` order, on an interface whose name does not match
  `^(bridge|br-|virbr|vmnet|vboxnet|docker|utun|tun|tap|wg|awdl|llw|lo)` — those are VM and
  container bridges, VPN tunnels (incl. WireGuard) and Apple's peer-to-peer links, never the
  network a phone is on. No subprocess. Nothing found ⇒ a warning
  and a skipped entry, never an error (§16's rule for `tailscale`).
- **Automatic rebind.** §23.21's retry is generalised from `tailscale` to every keyword entry:
  while any wanted keyword address is missing or unbound, `reload()` re-runs on the backoff
  timer. On top of that, while `lan` is configured, a 30 s timer (`LAN_WATCH_MS`) re-reads
  `os.networkInterfaces()` — cheap, no subprocess — and calls `reload()` when the `lan` address
  moved (Wi-Fi change, DHCP renewal, laptop moved between networks). `SIGHUP` still works.
  Both timers are `unref`ed and cleared on stop.
- **Install.** `install --lan` adds `lan` to `config.bind`. Interactive install asks
  `LAN access for the iPhone app?` with **default yes**; `--yes` alone does **not** enable it
  (a scripted install must not widen reachability unasked). `configure lan on|off` toggles it
  later and restarts the service when one is installed, because `bind` is read at startup.
- **Plain HTTP stays** on the LAN address as on every bound address (Android deck emulator
  compatibility); everything off-loopback still needs the bearer (§16).

**Test-first, per Part III:** `test/net/lan.test.ts` (resolution rules), `test/net/bind.test.ts`
(keyword), `test/net/daemon-network.test.ts` (rebind on move, retry while missing).

### §23.45 HTTPS listener with a self-signed, pinned certificate (2026-10-01)

A phone on Wi-Fi is on a network the user does not control; the bearer must not cross it in the
clear. The daemon adds TLS without any dependency.

- **Key and certificate.** `src/net/tls.ts` generates an ECDSA P-256 key once
  (`crypto.generateKeyPairSync`) and keeps it: `tls-key.pem` and `tls-cert.pem`, both 0600 in
  the config directory. The X.509 v3 certificate is built by a small stdlib DER writer
  (`src/net/x509.ts`) and signed with `crypto.sign('sha256', …)`: self-signed, `CN=claude-usage
  <name>`, 825-day validity, `basicConstraints CA:FALSE`, `keyUsage digitalSignature`,
  `extKeyUsage serverAuth`, `subjectAltName` = `localhost`, `127.0.0.1`, and the `.local` name
  when known (Apple's TLS server-certificate rules, so the cert is acceptable even to code that
  evaluates it normally). A certificate within 30 days of expiry, unreadable, or not matching
  the key is **re-issued with the same key**, so the pin survives.
- **Pin.** The fingerprint is the lowercase hex SHA-256 of the SubjectPublicKeyInfo DER.
  Clients pin it; hostname and CA are irrelevant to them. Rotating it means deleting the two
  files and restarting (paired apps must re-pair). `configure rotate-cert` is deferred.
- **Listeners.** TLS is a per-listener flag. Every bound address keeps plain HTTP on `port`;
  every **non-loopback** bound address (`lan`, `tailscale`, literals) also gets an
  `https.createServer` on `tls.port` (default `port + 1`; `0` when `port` is `0`) running the
  same request handler. `tls.loopback: true` (tests/CI only) adds HTTPS on loopback too. A TLS
  bind failure is logged and skipped like a secondary HTTP bind; it never stops the daemon.
  `unbind`, `SIGHUP` and the Host policy apply to TLS listeners exactly as to HTTP ones.
  `daemon.json` records `tlsPort` (or `null`).
- **Config.** `tls: { port: number | null, loopback: boolean }`, both optional.

**Test-first, per Part III:** `test/net/x509.test.ts` (round-trip through
`crypto.X509Certificate`, fingerprint, `openssl` agreement when present),
`test/net/tls.test.ts` (0600 files, key kept, re-issue), `test/server/tls-listen.test.ts`.
`test/fixtures/tls/cert.der` + `fingerprint.txt` is a throwaway cert produced by this writer and
shared with the iOS app's pinning tests; its key is not committed.

### §23.46 Host policy accepts the `.local` name (2026-10-01)

Bonjour advertising was cut in review: no `dns-sd`/`avahi` child process. Instead the pairing
link carries the machine's `.local` name as an address candidate, so the Host allowlist must
accept it.

- While `lan` is configured, the daemon resolves `<LocalHostName>.local` — `scutil --get
  LocalHostName` on macOS (2 s timeout), else the first label of `os.hostname()` — and adds it
  to the allowlist next to the MagicDNS name. Re-resolved by `reload()`.
- The LAN IP needs nothing new: it is a bound address. Ports in the policy include `tls.port`.
- The `.local` name is visible to anything on the LAN through mDNS anyway (macOS answers for
  it); it is not a secret, and the bearer still gates everything.

**Test-first, per Part III:** `test/net/lan.test.ts`, `test/net/daemon-network.test.ts`.

### §23.47 One-time pairing code (2026-10-01)

A QR code that carries the bearer is a password on a screen — screenshots, screen shares,
shoulder surfing. The v2 pairing link carries a **one-time code** instead, redeemed over TLS.

- `POST /v1/pair/code` — bearer **and** loopback required (non-loopback ⇒ 403 `forbidden`).
  Mints a 128-bit code (`randomBytes(16)`, base64url, 22 chars), held only in daemon memory,
  expiring after 5 min. Minting replaces any unused code. Answers `{ code, expiresAt, link,
  name, addrs, port, fp }`, where `link` is
  `usagedeck://pair?v=2&name=…&addrs=…&port=<tls.port>&fp=<64 hex>&code=…` and `addrs` lists
  the TLS-bound addresses in order: LAN IPv4, `<LocalHostName>.local`, tailnet IPv4, other
  literals, loopback last. No TLS listener at all ⇒ 409 `conflict`, hint
  `claude-usage configure lan on`.
- `POST /v1/pair` `{ code }` — **no bearer: the one documented exception** to "every mutating
  endpoint requires the bearer". TLS listeners only (plain HTTP ⇒ 403 `forbidden`, hint
  `pair over https`). Valid ⇒ 200 `{ token, name, fp }` and the code is burned. Unknown,
  expired or used ⇒ 401 `unauthorized` (`pairing code is invalid or expired`, hint
  ``run `claude-usage pair` again``). More than 5 failures in a minute from one remote address
  ⇒ 429 `rate_limited` for the rest of that minute, even for a correct code. Comparison is
  constant-time over SHA-256 digests. The code and token are never logged.
- Why the exception is safe: the code is single-use, short-lived, 128-bit, minted only by
  someone already holding the bearer on the machine itself, and only redeemable over a channel
  the client has pinned from the same QR.
- `configure pairing` is unchanged (v1 JSON with the bearer, for the Android deck).

**Test-first, per Part III:** `test/server/pairing.test.ts`.

### §23.48 `/health.install` and the `claude-usage pair` page (2026-10-01)

- **`/health.install`** — so the app's setup check is definitive rather than inferred:
  `{ hooks: boolean, statusline: "ours" | "includes-ours" | "other" | "none",
  mcp: boolean | null, listeners: [{ addr, port, tls }] }`. `hooks` is true when every §17.1
  event has our group in `~/.claude/settings.json`; `statusline` is `ours` when
  `statusLine.command` is our command, `includes-ours` when it mentions `claude-usage` or names
  a small script file that does, `other`, or `none`; `mcp` is whether `~/.claude.json` has
  `mcpServers["claude-usage"]` (`null` when unreadable). File reads are cached for 60 s;
  `listeners` is live. Never throws; never contains a path. REST `/health` only — the SSE
  `snapshot` event (§19) builds its own payload and does not carry it; clients read it from
  `/health`.
- **`claude-usage pair`** — CLI-only, lazily imported, never in the daemon's import graph.
  Mints a code through loopback `POST /v1/pair/code` with the bearer from `config.json`,
  renders the link as an SVG QR with the vendored QRCode matrix code (`vendor/qrcode/`, from
  `qrcode-terminal` 0.12.0, licence headers kept), and serves one HTML page from
  `127.0.0.1` only, at a random 128-bit path, **once**: the first GET gets the page, everything
  else (any other path, a second GET, a non-loopback peer) gets 404. Every response is
  `Cache-Control: no-store`. The page shows the QR, short steps, the TestFlight link when
  `TESTFLIGHT_URL` is set, the GitHub link, and "treat this like a password; if it was shown on
  a call, run `claude-usage pair` again" (which mints a new code and voids the old one). The
  page URL is a capability, so it never goes into argv (visible through `ps`) or the terminal:
  `open` / `xdg-open` is given a 0600 redirect file in a fresh 0700 temp directory, and the
  fallback prints that file's path. The page server closes, and the redirect file is deleted,
  on Enter, Ctrl-C, or after 5 min. The code itself is never written to disk or printed.
- `install` ends by offering it (`Open the pairing page now?`, interactive default yes; `--yes`
  does not) when the daemon is healthy and has a non-loopback bind.

**Test-first, per Part III:** `test/server/install-state.test.ts`, `test/install/pair.test.ts`.

### §23.49 Deferred (2026-10-01)

Recorded so they are not mistaken for oversights: a push relay (APNs) for real-time alerts and
complications; daemon-side `escalateAfter` (soft → hard after N s without a client awake);
`configure rotate-cert`; remote access without a VPN. (The Android deck accepting the v2
pairing link over pinned HTTPS landed on `usage-android` on 2026-10-02.)

### §23.50 A self-restart needs a witness that outlives it (2026-10-01)

The Studio auto-updated 0.1.106 → 0.1.107, logged `SIGTERM received, shutting down`, and stayed
down: `launchctl print` showed `last exit code = -9` and no process until a manual
`launchctl kickstart`. The restart (§23.18) is a `launchctl kickstart -k` issued *from inside the
job it restarts*, so whatever goes wrong mid-restart has nobody left to notice. A clean SIGTERM
exit is code 0, which `KeepAlive: { SuccessfulExit: false }` deliberately leaves down (§20).

- Before asking for the restart, the updater arms a **restart watchdog**
  (`LaunchdService.armRestartWatchdog`): a detached `/bin/sh` in its own session that polls
  `launchctl print <target>` every 2 s for up to 90 s and, the first time no `pid` is shown,
  runs `launchctl kickstart <target>` — without `-k`, so a daemon that came back on its own is
  never touched. Spawn failures are swallowed; the request and the exit-75 fallback still stand.
- systemd needs none: `Restart=on-failure` plus `systemctl restart` run by the manager, not the
  unit.
- The fix runs in the *old* process, so it protects updates out of the release that ships it.
- Verified live: SIGTERM'd job (exit 0, stays down) with the watchdog armed came back within one
  poll; without it, it stayed down.

### §23.51 `claude-usage` on the PATH, and `pair` where you will see it (2026-10-02)

After a normal install `claude-usage pair` failed with "command not found": the binary lives
at `<data home>/claude-usage/current/bin/claude-usage` and nothing put it on the PATH.

- `install` links `$XDG_BIN_HOME/claude-usage` (default `~/.local/bin/claude-usage`) to
  `currentBin()` — the `current` symlink, so updates and rollbacks need no relink. It never
  clobbers: a file or foreign link already there is left alone and reported with the full
  path to use instead. When the directory is not on `PATH`, install prints the `export PATH=`
  line to add.
- `uninstall` removes the link only when it is ours.
- `install` ends, and `status` ends, with how to pair a phone: `claude-usage pair` when a
  non-loopback address is bound, else `claude-usage configure lan on, then claude-usage pair`
  (`src/install/pair-hint.ts`, kept tiny because `status` imports it eagerly).

**Test-first, per Part III:** `test/install/path-link.test.ts`, `test/install/install.test.ts`,
`test/install/uninstall.test.ts`, `test/cli.test.ts`.

### §23.52 The pair page: deck theme, copy link, "Pairing successful" (2026-10-02)

- **Theme.** The page uses the app's palette (`SharedUI/Theme.swift` on `usage-ios`): ground
  `#0E1013`, translucent surface cards, the green/indigo aurora, Barlow Condensed headings and
  IBM Plex text when installed. Dark only. Nothing is loaded from anywhere.
- **Copy link.** Under the QR, "or copy the pairing link" and a **Copy link** button with a
  copy icon. The link lives only in the button's `data-link` attribute, never in page text;
  the iPhone app's Pair screen accepts a pasted link.
- **Script.** One static inline script (copy, expiry countdown, state polling), allowed by
  its SHA-256 in the CSP: `script-src 'sha256-…'; connect-src 'self'` and otherwise
  `default-src 'none'`.
- **Pairing detected.** `GET /v1/pair/code` (loopback only) reports the latest code's state —
  `none | pending | redeemed | expired`, never the code. `claude-usage pair` polls it every
  second; the page polls its own server's `<path>/status` (loopback, repeatable, `no-store`)
  every second. On `redeemed` the page **removes** the QR and the link from the DOM and shows
  "Pairing successful ✓ — It is now safe to close this tab"; the command prints `paired ✓`,
  keeps the page server up 3 s so the page sees it, and exits 0 without waiting for Enter. On
  `expired` the page shows "This code has expired" and the command exits 1. When the page
  server goes away (three failed polls) the page removes the QR and says pairing closed.
  Status errors (a daemon older than this) are ignored and Enter still ends the command.

**Test-first, per Part III:** `test/server/pairing.test.ts`, `test/install/pair.test.ts`.

### §23.53 `rotate-token` restarts the daemon (2026-10-02)

The daemon reads `auth.token` once at startup and keeps it in memory, so
`configure rotate-token` used to write a new token while the running daemon went on accepting
the old one until its next restart — a rotation that did nothing. It now restarts the service
(when one is installed), like `port` and `lan`. Every paired device must then re-pair with
`claude-usage pair`.

**Test-first, per Part III:** `test/install/configure.test.ts`.

### §23.54 Install wires the limits feed by default (2026-10-02)

Overrides §7.3 and §8 step 2 ("statusline no"). Since §23.36 the headline limits come from
Claude Code's statusline input, so a fresh install with the status line off had hooks, sessions
and token counts but no 5-hour or 7-day numbers: the phone and watch showed empty rings.

- **Install looks first.** Before the plan is printed, install reads what `statusLine` holds
  (the §23.48 states) and the plan's "live limits" item says what will happen for that case.
- **None → the silent feed.** `statusLine = { type: "command", command: "<bin> observe" }`.
  `observe` prints nothing and exits 0, so Claude Code's UI does not change. Default yes;
  `--yes` accepts it.
- **Ours, or the user's own that already forwards (`includes-ours`) → nothing is written.**
- **The user's own, not forwarding (`other`) → never edited** (merge-only, as ever). Install
  prints the one `observe` line to add to their script, and the final table reads
  `limits  needs one line in your own status line (see note)`. `configure statusline on` prints
  the same line (it used to print the `statusline` command, which is not what a script needs).
- **`--statusline`** still means the visible `5h 42% · 7d 61%` line; asking for it replaces our
  feed. The feed never replaces a visible line. **`--no-statusline`** leaves `statusLine` alone.
- **Privacy, stated in the plan before anything is written:** the feed reads only the
  `rate_limits` percentages from the statusline payload and POSTs them to the daemon on
  loopback. No prompt text, paths or model output are read, stored or sent anywhere.
- **Existing installs are not edited by an update.** Re-running `claude-usage install` wires
  the feed; the app's setup check ("Status line") points there.
- The final table's `statusline` row is now `limits`: `live, from Claude Code` | `needs one
  line…` | `off`. `uninstall` and `configure statusline off` remove the feed like the line
  (both are our command).

**Test-first, per Part III:** `test/install/plan.test.ts`, `test/install/install.test.ts`,
`test/install/settings-merge.test.ts`.

### §23.55 Every request needs the bearer, from loopback too (2026-10-13)

Overrides §16's loopback `GET`/`HEAD` exemption and §17.1's three loopback hook `POST`s
(`LOOPBACK_HOOK_POSTS`). Loopback is not an identity: any local process, and any web page the
user has open, can connect to `127.0.0.1`, and with the exemption a page could read every
session's paths, register sessions, record tools through the gate and hold event-stream
slots.

- **The rule.** Every request needs `Authorization: Bearer <token>`, whatever its source.
  Exactly two exceptions: `POST /v1/pair` (§23.47, unchanged — TLS only, one-time code,
  rate-limited) and `GET`/`HEAD /health` with **no** `Authorization` header, which answers
  `{ "ok": true }` and nothing else (no name, version, identity, stats, update or install
  state). A `/health` request carrying a token that is wrong is `401`, so a paired app keeps
  learning that its token was rotated.
- **Local clients authenticate.** `DaemonClient` reads `auth.token` from `<configDir>/config.json`
  (0600) on every request unless given one, but never volunteers it to a bare `baseUrl`. The
  hook, status line, `observe`, MCP server and CLI all go through it. A hook that cannot read
  the token gets `401` and, as with no daemon, prints nothing and exits 0.
- **A bare `serve` mints a token** when `config.json` has none and saves it 0600, since a
  daemon with no token would answer nothing.
- **Fetch metadata.** A request carrying `Sec-Fetch-Site` other than `none` is `403`, token or
  not (gate order: Host 421 → `Origin` 403 → `Sec-Fetch-Site` 403 → bearer 401).
- **`createdBy`** can no longer be inferred from the header's absence; it is `cli` when the
  body says so (the CLI does) and `dashboard` otherwise.
- **`500` responses** say `internal error`; the detail goes to the daemon's log.
- **Apps:** nothing they send changes — they always sent the bearer. A client that probed an
  unauthenticated `/health` for identity now gets `{ "ok": true }` only.

**Test-first:** `test/server-middleware.test.ts`, `test/server.test.ts`,
`test/server/events.test.ts` (a page cannot occupy SSE slots), `test/clients-http.test.ts`,
`test/hook.test.ts`, `test/daemon.test.ts`, `test/sessions/routes.test.ts`.

### §23.56 What a token holder can make the session endpoints do (2026-10-13)

The token is also what a lost phone carries. Extends §17 and §18.3.

- **Session ids** must be UUID-shaped (`SESSION_ID_RE`) in `register` and in every
  `/v1/sessions/{id}/…` path (`400` otherwise); the hook and status line treat any other
  `session_id` as no session; the registry re-checks id and transcript path before building the
  `custom-title.json` path.
- **Bounded input.** Paths absolute, ≤ 4096 chars, no control characters; `transcriptPath` ends
  `.jsonl` and is only kept inside `config.projectsDir`; `source` a short word; tool names
  ≤ 128; scopes ≤ 4112. At most 256 registered sessions — dead ones, then the quietest pid-less
  one, are evicted for a new id; when every slot is a live trusted session, `503`. A pid-less
  session not heard from for two hours is reaped.
- **Process identity.** A registered pid is kept only for a Claude Code process of the same
  uid: `argv[0]`'s basename is exactly `claude`, or `argv[0]` is a file under
  `…/claude/versions/`, or the command line runs `…/@anthropic-ai/claude-code/…cli.js`
  (`isClaudeCodeCommand`). When the reported pid (the hook's parent) does not qualify, its
  nearest qualifying ancestor up to four levels is taken; otherwise the session is registered
  with `pid: null`. The pid's start time (`/proc/<pid>/stat` field 22 on Linux,
  `ps -o lstart=` elsewhere) is stored as `pidStart`, and `sessions.json` records the boot id
  (`/proc/sys/kernel/random/boot_id`, `kern.boottime`). Every freeze, thaw, hard-pause check
  and liveness verdict re-checks the start time; persisted pids from another boot are
  discarded unsignalled; a pid recorded without a start time (an older file) is adopted only
  if it passes the Claude Code rule, else forgotten.
- **Freeze safety.** `freezeTree` never signals the daemon's pid or its ancestors, records
  `frozenPids` with start times (`frozenStarts`) to disk **before** the first `SIGSTOP`, and
  `thaw` skips a recycled, foreign or protected pid. `ps`, `sysctl` run by absolute path.
- **Crash path.** `uncaughtException`/`unhandledRejection` SIGCONT everything recorded (memory,
  then `sessions.json`), remove `daemon.json` and exit 1; a daemon that fails during startup
  thaws what its startup sweep froze.
- **Gate.** `GET /v1/sessions/{id}/gate` only reads; `POST` with `{ "tool": … }` records the
  tool. The hook's first poll is a `POST`.

**Test-first:** `test/sessions/hardening.test.ts`, `test/sessions/registry.test.ts`,
`test/pause/freeze.test.ts`.

### §23.57 HTTPS only off the machine; v1 pairing removed; bind safety (2026-10-13)

Overrides §16 (bind), §23.44 and §23.45 ("plain HTTP stays on every address").

- **Plain HTTP is served on loopback only.** Every non-loopback address gets an HTTPS listener
  or nothing; `127.0.0.1` is always bound for the local clients.
- **`configure pairing` is removed** (the v1 QR carried the bearer). It prints a pointer to
  `claude-usage pair` and exits 1. Nothing writes a `pairing.json`.
- **No wildcard, no public address.** A `bind` literal that is `0.0.0.0`, `::` or publicly
  routable is a `ConfigError` naming the entry unless `allowPublicBind: true` (a new top-level
  key, default `false`, set by hand only); a keyword resolving to one is skipped with a warning.
  Loopback, RFC 1918, `fc00::/7`, link-local and `100.64.0.0/10` are allowed.
- **The `tailscale` keyword** accepts an in-range address only from an interface named
  `tailscale*` or as printed by `tailscale ip -4`; the CLI's output is range-checked; the CLI is
  found at known absolute paths (`TAILSCALE_PATHS`) and never through `PATH`. The MagicDNS name
  must be a plain DNS name.

**Test-first:** `test/net/bind.test.ts`, `test/net/tailscale.test.ts`,
`test/net/daemon-network.test.ts`, `test/install/configure.test.ts`.

### §23.58 Rotation reaches a foreground daemon; connection ceilings (2026-10-13)

Extends §23.53. `configure rotate-token` with no service signals the daemon in `daemon.json`
with `SIGHUP`; a reload re-reads `auth.token` first and drops every event stream. The command
then requires the daemon to answer the new token within 3 s, and otherwise says the old token
still works and exits 1. Each listener caps connections at 256 total and 64 per remote address.

**Test-first:** `test/install/configure.test.ts`, `test/server.test.ts`.

### §23.59 Signed releases (2026-10-13)

Overrides §20 "Integrity".

- Every release carries `SHA256SUMS.sig`: base64 of an Ed25519 signature over the exact bytes of
  `SHA256SUMS`. The updater downloads it first, verifies it with `node:crypto` against
  `TRUSTED_RELEASE_KEYS` (`src/update/trusted-keys.ts`; base64 SPKI; a list for rotation)
  before parsing a checksum or extracting anything, and fails closed with `signature_missing`,
  `signature_invalid` or `no_trusted_keys`, deleting the download. The list ships with one
  `RELEASE_PUBLIC_KEY_PLACEHOLDER` entry that can verify nothing.
- `release.yml`: `build` (read-only token, no secrets: `npm ci`, gates, `npm audit --omit=dev`,
  `npm shrinkwrap`, `npm pack`, checksum) and `publish` (`needs: build`, main only,
  `environment: release`, `contents: write`, no third-party code: refuse the placeholder, sign
  with the `RELEASE_SIGNING_KEY` secret, verify, tag, `gh release create`). Every action pinned
  to a commit SHA. No npm publishing; `package.json` is `private`.
- Version directories install dependencies with `npm ci --omit=dev --ignore-scripts` from the
  tarball's `npm-shrinkwrap.json` (a checkout's `package-lock.json`), and refuse without one.

**Test-first:** `test/update/verify.test.ts`, `test/update/updater.test.ts`,
`test/update/release-signing.test.ts`, `test/install/deps.test.ts`.

### §23.60 Gaps found reading the CLI and updater (2026-10-13)

`claude-usage config` printed the token (now redacted); the hook built `paused/<session_id>`
from stdin unchecked (a `../config.json` id deleted the config — now UUID-only); update
extraction lists the archive first and refuses absolute, `..`, dot-segment and non-`package/`
members and symlinks, with `--no-same-owner` and an absolute `tar`; `apply()` refuses a
non-version string. **Test-first:** `test/cli.test.ts`, `test/hook.test.ts`,
`test/update/apply.test.ts`.

### §23.61 A local listener proves itself before it gets the token (2026-10-13)

`daemon.json` survives a crash and the port is fixed, so another local user could bind it first
and be sent the bearer. A client that found the port through `daemon.json` now first sends
`GET /health` with `x-claude-usage-challenge: <64 hex>`; the daemon answers, on loopback only,
`proof = HMAC-SHA256(token, "claude-usage-listener-proof-v1:" + challenge)`, and the token is
sent only after a correct proof (once per client). A `daemon.json` whose pid is dead or not ours
is stale and nothing is sent; a starting daemon removes a stale one before binding.
**Test-first:** `test/clients-http.test.ts`, `test/server.test.ts`, `test/daemon.test.ts`.

### §23.62 Hardening from the second read-through (2026-10-13)

System programs by absolute path (`security`, `launchctl`, `systemctl`, `journalctl`,
`loginctl`; the restart watchdog runs under `PATH=/usr/bin:/bin:/usr/sbin:/sbin`); the unit's
`PATH` keeps only absolute entries; systemd `ExecStart`/`Environment=` values are quoted per
systemd.syntax(7) and a line break is refused; hook/statusline/observe commands shell-quote an
unusual `binPath`; atomic writes use a random temp name opened `O_EXCL`; JSON parse errors in
`config.json` and `settings.json` report a position, never text; the upstream usage body is
capped at 256 KiB. **Test-first:** `test/service/*.test.ts`, `test/install/settings-merge.test.ts`,
`test/config.test.ts`, `test/limits-client.test.ts`.

### §23.63 An abandoned pairing code is revoked (2026-10-13)

Extends §23.47/§23.52. `DELETE /v1/pair/code` (bearer + loopback) voids the live code;
`claude-usage pair` calls it whenever it ends without the phone pairing. The per-source failure
table holds at most 1024 sources (a new source beyond that is `rate_limited`) and is swept at
most every 5 s. **Test-first:** `test/server/pairing.test.ts`, `test/install/pair.test.ts`.

### §23.64 A plan upgrade drops usage mid-window (2026-10-25)

Amends §23.40. After an upgrade from Max 5 to Max 20, Claude Code's `/usage` read the week
at 1% while the daemon served 99%. §23.40's rule "usage only climbs inside a window" refused
every lower `seven_day` reading, because the window's `resets_at` did not change. The held
observation then went quiet, and `weekly_all` fell back to the stale 99% upstream row.
Upstream was rate-limited, so nothing could correct it before the weekly reset.

- **The client tags the body.** `claude-usage observe` adds the statusline's `session_id`
  to the `POST /v1/limits/observed` body, but only when it is a UUID. An older daemon
  ignores the extra key.
- **Readings are aged by their own session.** A session's number changes only when it got a
  new model response. The daemon keeps each session's last reading per limit id, in memory,
  for at most 256 sessions and 24 h. A reading that differs from its own session's previous
  reading in the same window gets `movedAt = now`. An unchanged one keeps its previous
  `movedAt`. A session's first reading, or its first in a new window, has no `movedAt`.
- **Newest move wins.** In the held window, a reading whose `movedAt` is at or after the
  held one's replaces it, in either direction. A move below the held reading marks the
  window `dropped`. Readings without a newer move keep §23.40's rule, but cannot raise a
  `dropped` window, so an idle session's pre-upgrade 99% cannot return. Earlier windows are
  still refused, and later ones still win.
- **Persisted.** `movedAt` and `dropped` are written with the §23.42 observations and
  restored with them.

**Test-first, per Part III:** `test/limits-observed.test.ts`. Mutation-checked: always
treating a reading as moved, ignoring `dropped`, requiring a strictly newer move, never
accepting a move, and not persisting or restoring `dropped` each fail a named test.

### §23.65 …or starts a week that resets earlier (2026-10-25)

Amends §23.64. Live data after the Max 20 upgrade showed the upgrade did not keep the old
week: the statusline's `seven_day` now resets 2026-10-27T03:00Z, earlier than the held
2026-10-29T06:00Z. §23.40 refuses an earlier window outright, so §23.64's same-window
exception never applied. A daemon restart cleared it only because the held observation had
expired and was not persisted.

- **A move is any change.** A session's reading moves when its `used_percentage` *or* its
  `resets_at` differs from its own previous reading.
- **The newest move wins, whatever the window.** A moved reading at or after the held
  `movedAt` replaces it even when its window resets earlier. A move that §23.40 would have
  refused — an earlier window, or lower in the same window — sets `dropped`. While `dropped`,
  unmoved readings are refused, including an idle session's later-resetting old week. Once
  the held window resets, any reading is taken again, as before.

**Test-first, per Part III:** `test/limits-observed.test.ts`. Fails against §23.64's code.
Mutation-checked: limiting `dropped` to same-window moves, and ignoring a `resets_at`-only
change, each fail a named test.

### §23.66 A menu-bar item for the daemon (2026-10-30)

**Why:** on 2026-10-17 a clean SIGTERM left the daemon down, and nobody noticed. launchd's
`KeepAlive` restarts only on a non-zero exit, and the Android app sat on WAITING FOR MACHINE
(issue #60).

- **A SwiftBar plugin, not an app.** `claude-usage menubar` prints SwiftBar/xbar plugin
  output. `menubar --install [--dir <d>]` writes `claude-usage.1m.sh` (mode 0755, atomic
  rename) into SwiftBar's plugin folder, read with `/usr/bin/defaults read com.ameba.SwiftBar
  PluginDirectory`, and records its path in `<configDir>/menubar-plugin`. The script runs node
  and `current/bin/claude-usage` by absolute path, since SwiftBar plugins get no login PATH.
  With arguments, the script passes them straight to the CLI; that is how menu actions run.
- **What it shows.** The title shows the `session` and `weekly_all` percentages, coloured by
  the overall status. `⚠︎` means a row is `stale` or the newest `asOf` is over 15 minutes old.
  A daemon with no live pid in `daemon.json` shows as stopped. One that has a pid but does not
  answer within 2 s shows "Not answering". `menubar` always exits 0 and never prints the token.
- **Start/Stop.** `claude-usage service start|stop|status` wraps the existing `ServiceManager`
  (launchd `bootstrap` + `kickstart`, or `bootout`; systemd `start`/`stop`). It refuses with a
  pointer to `install` when no service is installed.
- **Removal.** `menubar --uninstall` and `uninstall` delete the recorded file, but only when it
  still carries the `# claude-usage menubar plugin` marker.

**Tests:** `test/menubar.test.ts`, plus the uninstall case in `test/install/uninstall.test.ts`.
