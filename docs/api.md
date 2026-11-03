# HTTP API

The daemon speaks JSON over `node:http` on `config.port` (default `47291`), on every
address in `config.bind` (default `127.0.0.1` only). One `http.Server` per address, all
sharing one handler.

- Every response is `application/json; charset=utf-8` with `cache-control: no-store`.
  `GET /v1/events` is `text/event-stream` instead.
- No CORS headers are ever sent, on any response.
- Request timeout: 5 s (`/v1/events` is exempt — it is a long-lived stream).
- Request bodies must be JSON objects, ≤ 64 KiB.

## Contents

- [The request gate](#the-request-gate)
- [Error envelope](#error-envelope)
- [`GET /health`](#get-health)
- [`GET /v1/limits`](#get-v1limits)
- [`GET /v1/summary`](#get-v1summary)
- [`POST /v1/refresh`](#post-v1refresh)
- [`GET /v1/tokens`](#get-v1tokens)
- [`GET /v1/config`](#get-v1config)
- [`GET /v1/sessions`](#get-v1sessions)
- [Session lifecycle endpoints](#session-lifecycle-endpoints)
- [Pause and resume](#pause-and-resume)
- [Pairing — `POST /v1/pair/code`, `GET /v1/pair/code`, `POST /v1/pair`](#pairing)
- [`GET /v1/events` (SSE)](#get-v1events-sse)
- [`limits[]` normalization](#limits-normalization)
- [`since` and `groupBy`](#since-and-groupby)
- [Known deviations from the spec](#known-deviations-from-the-spec)

## The request gate

**Listeners (§23.45, §23.57).** Plain HTTP on `port` (47291) on loopback only —
`127.0.0.1` always, plus any other loopback address in `bind`. Every non-loopback bound
address gets HTTPS on `tls.port` (default `port + 1`, 47292) and no plain-HTTP listener,
running the same handler and gate, with a self-signed ECDSA P-256 certificate. Clients pin
`fp`, the lowercase hex SHA-256 of the certificate's SubjectPublicKeyInfo DER:

```bash
openssl s_client -connect 192.168.1.20:47292 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | shasum -a 256
```

Every request passes through the same gate, in this order
(`src/server/middleware.ts`):

1. **Loopback detection** — from the socket's remote address (`127.0.0.0/8`, `::1`,
   IPv4-mapped forms). Never from a header.
2. **Host allowlist** — the `Host` header's hostname must be `localhost`, `127.0.0.1`,
   `::1`, an address the daemon is bound to, the machine's MagicDNS name, or its
   `<LocalHostName>.local` name while `bind` has `lan`. If it carries
   a port, that port must be one we listen on. Otherwise **`421 misdirected_request`**.
   (`0.0.0.0` / `::` are never accepted as a `Host` value even when bound.)
3. **Origin** — any request carrying an `Origin` header at all is **`403 forbidden`**.
   **Fetch metadata** — a `Sec-Fetch-Site` header with any value but `none` is
   **`403 forbidden`**, token or not (§23.55).
4. **Auth (§23.55)** — every request, from loopback too, needs
   `Authorization: Bearer <config.auth.token>`, compared in constant time over sha256
   digests. Missing or wrong → **`401 unauthorized`**. An empty configured token never
   matches anything. Two exceptions:
   - `GET`/`HEAD /health` with **no** `Authorization` header → `200 { "ok": true }` and
     nothing else (a wrong token is still `401`);
   - `POST /v1/pair` from anywhere → no token; the route itself demands HTTPS and a
     one-time code ([Pairing](#pairing)).

Local clients (hook, status line, `observe`, MCP server, CLI) read the token from
`config.json`. Before sending it to the port named in `daemon.json` they send
`GET /health` with `x-claude-usage-challenge: <64 lowercase hex>`; on loopback the daemon
adds `"proof": HMAC-SHA256(token, "claude-usage-listener-proof-v1:" + challenge)` (hex) to
the body, and the client sends the token only if that matches (§23.61).

| Situation | Result |
| --- | --- |
| `GET /health` from `127.0.0.1`, no token | 200, `{ "ok": true }` only |
| `GET /health` with a valid token | 200, the full body below |
| `GET /health` with a wrong token | 401 |
| `GET /v1/summary` from `127.0.0.1`, no token | 401 |
| `GET /health` from the tailnet, no token | 200, `{ "ok": true }` only |
| Any request with `Sec-Fetch-Site: cross-site` | 403 |
| `POST /v1/pause` from `127.0.0.1`, no token | 401 |
| Any request with `Origin:` | 403 |
| `Host: evil.test` | 421 |
| `POST /v1/pair` over HTTPS, no token, valid code | 200 |
| `POST /v1/pair` over plain HTTP | 403 |

## Error envelope

Every non-2xx response is:

```json
{ "error": { "code": "unauthorized", "message": "…", "hint": "…" } }
```

`message` is always present and non-empty; `hint` is present when there is something
actionable. Codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`,
`method_not_allowed`, `misdirected_request`, `conflict`, `gone`, `rate_limited`,
`unavailable`, `internal_error`.

Real examples (`test/fixtures/sessions/errors.json`):

```json
{ "error": { "code": "unauthorized",
             "message": "a valid Authorization: Bearer token is required",
             "hint": "every request needs the token, from this machine too — it is in config.json (0600), and `claude-usage` reads it for you" } }
```

```json
{ "error": { "code": "conflict",
             "message": "session c70bd853-… was discovered from its transcript and has no trusted pid",
             "hint": "hard freeze needs a session registered by the SessionStart hook — use mode \"soft\"" } }
```

A `405` also sets the `allow` header:

```
$ curl -s -i localhost:47291/v1/refresh
HTTP/1.1 405 Method Not Allowed
allow: POST
{"error":{"code":"method_not_allowed","message":"GET is not allowed on /v1/refresh","hint":"allowed: POST"}}
```

A request that exceeds the 5 s timeout gets `500 internal_error` with
`"request timed out"` and the socket is destroyed.

---

## `GET /health`

Auth: token for this body; without any `Authorization` header the answer is just
`{ "ok": true }` (plus `proof` when challenged, above). `HEAD` allowed.

```json
{
  "ok": true,
  "name": "adams-mbp",
  "version": "0.1.0",
  "uptimeMs": 631,
  "pid": 48213,
  "user": {
    "emailAddress": "adam@example.test",
    "accountUuid": "c0ffee00-1111-4222-8333-444455556666",
    "organizationUuid": "d1a9b0c2-7777-4888-8999-aaaabbbbcccc",
    "displayName": "Adam Example",
    "organizationName": "Example Productions"
  },
  "update": { "channel": "stable", "current": "0.1.0", "available": null,
              "state": "disabled", "deferredReason": null },
  "stats": { "filesTracked": 4, "eventsIndexed": 4, "parseErrors": 1,
             "lastScanAt": "2026-09-13T19:29:06.194Z", "spendReady": true,
             "scan": { "filesDone": 4, "filesTotal": 4, "bytesDone": 6099, "bytesTotal": 6099 } },
  "install": {
    "hooks": true,
    "statusline": "includes-ours",
    "mcp": true,
    "listeners": [
      { "addr": "127.0.0.1",    "port": 47291, "tls": false },
      { "addr": "192.168.1.20", "port": 47291, "tls": false },
      { "addr": "192.168.1.20", "port": 47292, "tls": true }
    ]
  }
}
```

- `user` is read from `~/.claude.json → oauthAccount` and cached for 10 minutes; a missing
  file, a missing `oauthAccount`, or an object where every verified key is absent all yield
  `null`. No tokens or credentials are ever in this object.
- `stats.eventsIndexed` is the number of dedup keys held; `stats.scan` is present while a
  token store is attached.
- `install` (§23.48) says what the iPhone app's setup check needs to know. `hooks`: every
  hook event has our group in `~/.claude/settings.json`. `statusline`: `ours` means
  `statusLine.command` is our command; `includes-ours` means it mentions `claude-usage`
  inline or in a small script file; otherwise `other` or `none`. `mcp`: whether
  `~/.claude.json` has `mcpServers["claude-usage"]`, or `null` when that file cannot be read.
  `listeners` is live and lists every listener the daemon asked for. File reads are cached
  for 60 s. The block never throws and never contains a path. It is on REST `/health`
  only; the SSE `snapshot` event does not carry it. Its presence means the daemon supports
  v2 pairing.
- `update.state` is one of `idle | checking | downloading | verifying | ready | deferred |
  disabled`. Today it is always `disabled` (see deviations).

## `GET /v1/limits`

Auth: token required (§23.55).

The daemon's cached copy of `GET https://api.anthropic.com/api/oauth/usage`
(`anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-usage/<version>`), polled every `pollIntervalMs` (never faster than
120 s; each upstream 429 doubles the interval, up to 30 min, easing back after 12 good polls —
§23.33).

```json
{
  "fetchedAt": "2026-09-13T19:01:38.189Z",
  "stale": false,
  "error": null,
  "limits": [
    { "id": "session", "kind": "session", "group": "session", "percent": 69,
      "severity": "normal", "resetsAt": "2026-09-13T23:00:00.346Z",
      "scope": null, "isActive": true },
    { "id": "weekly_all", "kind": "weekly_all", "group": "weekly", "percent": 34,
      "severity": "normal", "resetsAt": "2026-09-16T13:00:00.346Z",
      "scope": null, "isActive": false },
    { "id": "weekly_scoped:fable", "kind": "weekly_scoped", "group": "weekly", "percent": 20,
      "severity": "normal", "resetsAt": "2026-09-16T13:00:00.347Z",
      "scope": { "model": "Fable", "surface": null }, "isActive": false }
  ],
  "legacyWindows": {
    "five_hour": { "utilization": 69, "resetsAt": "2026-09-13T23:00:00.346Z" },
    "seven_day": { "utilization": 34, "resetsAt": "2026-09-16T13:00:00.346Z" }
  },
  "extraUsage": { "isEnabled": false, "utilization": null, "spendLimitReached": true },
  "raw": { "…verbatim upstream payload…": true }
}
```

Every row also carries `source` — `"upstream"` (the usage endpoint) or `"statusline"` (Claude
Code's statusline input, §23.36) — and `asOf`, the ISO time of that reading. Rows from the
statusline have `severity: null`. `fetchedAt` stays the last upstream fetch (`null` if there has
never been one).

Every row also carries its own `stale` (§23.40). Statusline rows are `false`. An upstream row
is `true` after a failed fetch, or once its window's `resetsAt` has passed. In the second case
its `percent` and `severity` are `null`, because the number described a window that has ended.
Snapshot `stale` is `true` when a headline row (`session` or `weekly_all`) is stale. With
neither present, it keeps the meaning below.

Before the first successful poll: `{ "fetchedAt": null, "stale": false, "error": null,
"limits": [], "legacyWindows": {}, "extraUsage": null, "raw": null }`.

`stale: true` means this is the last good value after a failed fetch, and `error` then
carries one of:

| `error.code` | When |
| --- | --- |
| `no_credentials` | the Keychain item / credentials file is unreadable |
| `unauthorized` | upstream answered 401/403 after one credentials re-read and retry; hint `run \`claude\` to re-login`; the poll interval parks at 10 min until a fetch succeeds |
| `network` | transport failure or a non-2xx that is not 401/403/429 |
| `rate_limited` | upstream answered 429. `retryAt` (ISO 8601) is present when upstream sent a usable `Retry-After`, and no poll or refresh calls upstream before it; the window persists across restarts. `hint` says nothing needs fixing locally (§23.32) |
| `schema_drift` | the body was not JSON, not an object, or had no `limits` array |

`raw` is always served verbatim when there is one — `raw` keeps everything the normalizer
ignores.

## `GET /v1/summary`

Auth: token required (§23.55). This is the hook's and the status line's single call.

```json
{
  "limits": { "…": "/v1/limits minus `raw`" },
  "status": { "byId": { "session": "ok", "weekly_all": "ok", "weekly_scoped:fable": "ok" },
              "overall": "ok" },
  "thresholds": { "warn": 80, "critical": 95 },
  "today": { "ready": true, "input": 7702, "output": 534038,
             "cacheCreate": 10067248, "cacheRead": 192527936, "messages": 1908 }
}
```

- `status` per limit: `critical` if `percent >= thresholds.critical` **or** upstream
  `severity` is one of `critical, severe, exceeded, exhausted, blocked, locked,
  limit_reached, over_limit` (case-insensitive); `warn` if `percent >= thresholds.warn`
  **or** `severity !== "normal"`; else `ok`. `overall` is the worst of them; with no limits
  at all it is `ok`.
- `today` is machine-wide, since **UTC** midnight. `ready: false` (with zeroes) until the
  initial transcript scan completes.

## `POST /v1/refresh`

Auth: **token required** (it is a mutating method, even from loopback).

Forces a limits refetch and returns the new `/v1/limits` body. Unlike a scheduled poll,
this **re-reads the credential store** rather than reusing the cached access token, which
makes it the manual escape hatch after a Claude Code account switch (§23.31) — otherwise
the daemon serves the previous account's numbers until the token TTL lapses. A refresh that
arrives while a scheduled poll is already in flight joins that poll and does not re-read.
Anthropic rate-limits the usage endpoint, so a refresh within 60 s of the last upstream call
— by a refresh **or** a scheduled poll — is refused (§23.33):

```json
{ "error": { "code": "rate_limited",
             "message": "limits were fetched from Anthropic under a minute ago — refresh is limited to once a minute",
             "hint": "use GET /v1/limits for the current numbers" } }
```

→ `429`. The MCP `refresh_limits` tool catches that and returns the current limits with a
note instead of an error. Inside an upstream 429 window (`error.code: "rate_limited"` with a
future `retryAt`) a refresh returns `200` with the current snapshot and does not call upstream.

## `POST /v1/limits/observed`

Auth: **token required** (mutating, even from loopback). §23.36.

The body is the `rate_limits` object from Claude Code's statusline JSON, verbatim; `claude-usage
observe` sends it:

```json
{ "five_hour": { "used_percentage": 10.4, "resets_at": 1790000000 },
  "seven_day": { "used_percentage": 52, "resets_at": "2026-10-01T06:00:00.000Z" } }
```

`five_hour` feeds limit `session`, `seven_day` feeds `weekly_all`; other keys are ignored.
`used_percentage` must be a finite 0–100 (rounded to an integer); `resets_at` is epoch seconds,
an ISO string, or absent. Validation is all-or-nothing: one unusable window rejects the body
with `400 bad_request` and the previous reading stands. `200 {"accepted": true}` otherwise.

An observation is used for 15 min (`OBSERVATION_TTL_MS`) and never past its own `resets_at`.
For `session` / `weekly_all`, `/v1/limits` serves whichever of the observation and the last
upstream fetch is newer. While the held window is open, a reading from an earlier window, or
a lower one for the same window, is ignored but still answered `accepted: true`. It is an
idle session re-sending old numbers (§23.40). While one is fresh, the upstream poll drops to at most hourly.
When an observation lapses, SSE clients get a `limits` event at that moment carrying the
upstream rows and their `stale` (§23.37); they do not wait for the next poll.

## `GET /v1/tokens`

Auth: token required (§23.55). Query: `?since=<iso|today|all|7d|24h|30m>&groupBy=project|session|model|day`.

```json
{
  "ready": true,
  "stale": false,
  "since": "1970-01-01T00:00:00.000Z",
  "groupBy": "project",
  "totals": { "input": 116, "output": 228, "cacheCreate": 340, "cacheRead": 452, "messages": 4 },
  "groups": [
    { "key": "-home-dev-beta",  "label": "/home/dev/beta",  "input": 100, "output": 200,
      "cacheCreate": 300, "cacheRead": 400, "messages": 1 },
    { "key": "-home-dev-alpha", "label": "/home/dev/alpha", "input": 16, "output": 28,
      "cacheCreate": 40, "cacheRead": 52, "messages": 3 }
  ]
}
```

(Real response from a daemon pointed at `test/fixtures/spend/projects` — see
`test/fixtures/spend/README.md` for the transcript shapes those numbers come from.)

- `ready: false` with empty totals and groups until the initial scan finishes, and also
  when no token store is attached at all.
- `stale: true` means a background rescan is running and the aggregates are behind the
  files on disk.
- For `groupBy=project`, `key` is the `~/.claude/projects/<dir>` directory name used
  verbatim as an opaque key — the encoding is lossy (`/` and `-` both become `-`) so it is
  never decoded. `label` is the `cwd` of the first counted line of the session's top-level
  transcript, falling back to `key`.
- Counting rules: a transcript line counts iff `type === "assistant"` **and**
  `message.model !== "<synthetic>"` **and** `isApiErrorMessage !== true` **and**
  `message.usage` is an object. Dedup key is `message.id + ":" + (requestId ?? "")`.
  Subagent transcripts (`<sessionId>/subagents/agent-*.jsonl`) carry the parent's
  `sessionId` and roll up to it. Non-transcript `.jsonl` files in the tree are skipped
  silently and are not counted as `parseErrors`.

Bad query → `400`:

```json
{ "error": { "code": "bad_request", "message": "invalid \"groupBy\" parameter",
             "hint": "groupBy must be one of project, session, model, day" } }
```

```json
{ "error": { "code": "bad_request", "message": "invalid \"since\" parameter",
             "hint": "since must be an ISO-8601 instant, today, all, or a relative value such as 7d or 24h" } }
```

Passing `groupBy` more than once is a `400` — multiple groupings are not supported.

## `GET /v1/config`

Auth: token required (§23.55). The effective config with `auth.token` replaced by
`"<redacted>"` (or left `""` when none is set). Unknown keys you added to `config.json`
appear here too.

```json
{ "name": "demo-host", "port": 47291, "bind": ["127.0.0.1"],
  "auth": { "token": "<redacted>" }, "pollIntervalMs": 300000,
  "thresholds": { "warn": 80, "critical": 95 },
  "hookDebounceMinutes": 10, "retentionDays": 90,
  "projectsDir": "/Users/you/.claude/projects",
  "integrations": { "service": true, "hook": true, "mcp": true, "statusline": false },
  "autoUpdate": { "enabled": true, "intervalMs": 600000,
                  "repo": "drmuzikbpn/usage-deck" },
  "events": { "maxClients": 16 } }
```

## `GET /v1/sessions`

Auth: token required (§23.55). `HEAD` allowed. Sets `ETag: W/"<rev>"`; a matching
`If-None-Match` gets **`304`** with the same `etag` and no body.

```json
{
  "rev": 812,
  "sessions": [
    {
      "sessionId": "3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
      "pid": 4242,
      "alive": true,
      "discovered": "hook",
      "cwd": "/Users/adam/code/foo-wt2",
      "transcriptPath": "/Users/adam/.claude/projects/-Users-adam-code-foo-wt2/3f1c0a52-….jsonl",
      "project": { "gitCommonDir": "/Users/adam/code/foo/.git", "name": "foo" },
      "worktree": "foo-wt2",
      "model": "claude-opus-5",
      "startedAt": "2026-09-13T11:04:18.000Z",
      "lastActivityAt": "2026-09-13T14:02:51.000Z",
      "tokens": { "input": 18422, "output": 5310, "cacheCreate": 240118,
                  "cacheRead": 1904772, "messages": 143 },
      "pause": { "mode": "hard", "ruleId": "r_k3m7qz4ub2ah6ptc",
                 "scope": "session:3f1c0a52-…", "since": "2026-09-13T14:03:10.000Z",
                 "frozenPids": [4251, 4252], "freezes": 1 },
      "lastTool": { "name": "Bash", "at": "2026-09-13T14:02:50.000Z" }
    }
  ]
}
```

Full three-session example including a `discovered: "transcript"` one:
[`test/fixtures/sessions/sessions.json`](../test/fixtures/sessions/sessions.json).

- `rev` is a monotonic counter bumped on any session or pause change.
- `project.name` is the basename of the main worktree (the parent of `gitCommonDir`);
  `worktree` is the basename of `cwd` when it differs, else `null`. With
  `gitCommonDir: null` the project is `{ gitCommonDir: null, name: basename(cwd) }`.
- `discovered: "hook"` means a `SessionStart` hook registered it; `"transcript"` means it
  was back-filled from the spend store and has `pid: null`.
- Liveness: every 15 s the daemon `kill(pid, 0)`s each registered pid. Dead → `alive:
  false`; dropped from the list 5 minutes later.
- `model`, `tokens` and `startedAt` come from the spend store, keyed by `sessionId`.
- `lastTool` is recorded by the `PreToolUse` hook's gate call.
- `pause.frozenPids` lists the **tool subprocesses** currently `SIGSTOP`ed. The session's own
  `claude` process is never among them — a hard pause stops Claude's work, not the user's
  terminal, and the next tool call is stopped by the gate instead. An empty list under
  `mode: "hard"` means the session had nothing running when the pause landed; it is held at
  the gate.
- A `discovered: "transcript"` session reports `alive: false` once the daemon has seen it
  stop, even while its transcript is recent — a recently-written transcript is evidence of
  recent activity, never of a running process (§23.24).
- `pause.freezes` counts how many times this pause has frozen the session's tool tree: `0`
  under a soft rule, `1` for a session frozen once, and `2+` once a re-registered session
  (`claude --resume`, new pid) or a daemon restart sweep has frozen it again under the same
  standing rule. It resets when the pause ends.

## Session lifecycle endpoints

These are what `claude-usage hook` calls. Like everything else they need the token
(§23.55); the hook reads it from `config.json`. Every `{id}` must be a UUID (`400`
otherwise, §23.56).

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /v1/sessions/register` | `{ sessionId, pid, cwd, transcriptPath, gitCommonDir, source }` | `200 { session, rev }` |
| `POST /v1/sessions/{id}/heartbeat` | `{}` | `200 { ok: true, rev, paused, mode, ruleId, reason }`; `404` for an unknown session |
| `POST /v1/sessions/{id}/end` | `{}` | `200 { ok: true, ended: <bool>, rev }` — idempotent |
| `GET /v1/sessions/{id}/gate` | — | `200 { paused, mode, ruleId, reason }` — read-only |
| `POST /v1/sessions/{id}/gate` | `{ tool }` | the same, and records `lastTool` (§23.56) |

- `register` requires a UUID `sessionId`; absolute paths ≤ 4096 chars; a `.jsonl`
  `transcriptPath` (kept only inside `projectsDir`); a short `source`; an integer `pid`
  (`400` naming the field otherwise). The pid is kept only for a Claude Code process of the
  same user, or its nearest such ancestor, and is otherwise `null`. At most 256 sessions;
  when every slot is a live session, `503 unavailable`. It is idempotent —
  `claude --resume` re-registers the same id with a new pid. Registering applies any rule
  created before the session existed.
- The hook's first gate poll is a `POST` carrying the tool; re-polls are `GET`s.
- `end` SIGCONTs the session's recorded `frozenPids` first, so a stopped process can never
  outlive the session that owned it.

## Pause and resume

All mutating endpoints require the bearer token. Scopes are `all`,
`project:<gitCommonDir>` and `session:<sessionId>`; a trailing `/` on a project path is
stripped.

| Method & path | Body → response |
| --- | --- |
| `POST /v1/pause` | `{ scope, mode, reason? }` → `200 { rule, affected: [sessionId…] }` |
| `POST /v1/resume` | `{ scope }` → `200 { removed: [ruleId…], resumed: [sessionId…] }` |
| `GET /v1/pause/rules` | → `200 { rev, rules: [...] }` |
| `DELETE /v1/pause/rules/{id}` | → `204`, or `404 not_found` |
| `POST /v1/sessions/{id}/pause` | `{ mode, reason? }` — sugar for `scope: "session:<id>"` |
| `POST /v1/sessions/{id}/resume` | — sugar for `scope: "session:<id>"` |

Rule shape ([`test/fixtures/sessions/pause-rules.json`](../test/fixtures/sessions/pause-rules.json)):

```json
{ "id": "r_k3m7qz4ub2ah6ptc",
  "scope": "session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
  "mode": "hard",
  "reason": "usage-android:9f21c4ab",
  "createdAt": "2026-09-13T14:03:10.000Z",
  "createdBy": "dashboard" }
```

`POST /v1/pause` →
[`test/fixtures/sessions/pause-response.json`](../test/fixtures/sessions/pause-response.json);
`POST /v1/resume` →
[`test/fixtures/sessions/resume-response.json`](../test/fixtures/sessions/resume-response.json).

Semantics:

- **Rules, not flags.** A session's effective pause is the most specific matching rule
  (session > project > all); `hard` beats `soft` at equal specificity. Rules persist in
  `<configDir>/pause.json` across restarts and apply to sessions that register *later* — a
  new worktree session in a paused project comes up paused.
- Posting the same `(scope, mode)` twice returns the existing rule (idempotent).
- `reason` is echoed verbatim, trimmed to 200 characters, everywhere the rule appears —
  so a client can tag its own rules (`usage-android:<installId>`).
- `resume` is idempotent: empty arrays when nothing matched.
- Mode validation: anything but `"soft"` / `"hard"` → `400`; a malformed scope → `400`.

Hard-freeze refusals, before any rule is created:

| Status | Code | When |
| --- | --- | --- |
| `409` | `conflict` | the session is `discovered: "transcript"` (no trusted pid) |
| `409` | `conflict` | the target pid is not owned by the daemon's uid |
| `410` | `gone` | the session is unknown, has exited, or its pid is gone |

`400` bodies are rejected the same way everywhere: a body that is not a JSON object (or
over 64 KiB) → `{ "error": { "code": "bad_request", "message": "body must be a JSON
object" } }`.

## Pairing

The v2 pairing flow (§23.47) gives a phone the bearer without the bearer ever appearing in
a QR code.

### `POST /v1/pair/code`

Auth: bearer **and** loopback (`403 forbidden` from anywhere else). `claude-usage pair` is
the caller. It mints a 128-bit, single-use code that expires in 5 minutes and voids any
unused one.

```json
{
  "code": "Q2xhdWRlVXNhZ2VQYWlyMQ",
  "expiresAt": "2026-10-01T18:05:00.000Z",
  "link": "usagedeck://pair?v=2&name=studio&addrs=192.168.1.20%2Cstudio.local%2C100.101.102.103&port=47292&fp=eeeb5db7…1a27&code=Q2xhdWRlVXNhZ2VQYWlyMQ",
  "name": "studio",
  "addrs": ["192.168.1.20", "studio.local", "100.101.102.103"],
  "port": 47292,
  "fp": "eeeb5db71defbf5a8dcd133e886b617f68a2cdfb8853e0b46ac1da446bdc1a27"
}
```

`addrs` lists only addresses that have an HTTPS listener, best first: LAN IPv4, the
`.local` name (only when the LAN address is listed), the tailnet IPv4, other literals, and
loopback last. The link's query parameters always come in this order: `v=2`, then `name`
and `addrs` (both percent-encoded), `port` (the TLS port), `fp` (64 hex), `code` (22
base64url chars). It never contains the bearer. No HTTPS listener at all ⇒
`409 conflict`, hint ``enable LAN access with `claude-usage configure lan on` ``.

### `GET /v1/pair/code`

Auth: bearer **and** loopback (`403 forbidden` from anywhere else). What became of the most recently minted code, so `claude-usage pair` can tell its
page the phone is in (§23.52). Never the code itself.

```json
{ "state": "redeemed", "expiresAt": "2026-10-01T18:05:00.000Z" }
```

`state` is `none` (nothing minted since the daemon started), `pending`, `redeemed` (stays so
after the expiry passes) or `expired`. A new mint starts over at `pending`.

### `POST /v1/pair`

Auth: **none**, the one documented exception (`docs/security.md` §1b). HTTPS listeners
only: plain HTTP gets `403 forbidden` with hint `pair over https`, and the code survives.

```
POST /v1/pair    { "code": "Q2xhdWRlVXNhZ2VQYWlyMQ" }
200              { "token": "<bearer>", "name": "studio", "fp": "eeeb…1a27" }
```

The code is burned on success. If the code is unknown, expired or already used, the
response is `401 unauthorized` with message `pairing code is invalid or expired` and hint
``run `claude-usage pair` again``. After 5 failures in a minute from one remote address,
the rest of that minute gets `429 rate_limited`, even for a valid code.

### `DELETE /v1/pair/code`

Auth: bearer **and** loopback. Voids the live code at once: `200 { "revoked": <bool> }`.
`claude-usage pair` calls it whenever it ends without a phone pairing (§23.63).

The old `configure pairing` command, whose v1 JSON carried the bearer, has been removed
(§23.57).

## `GET /v1/events` (SSE)

Auth: token required (§23.55; and only `GET`/`HEAD`; anything else is `405` with
`allow: GET, HEAD`). `HEAD` returns `200` with the stream headers and no body.

Response headers:

```
content-type: text/event-stream; charset=utf-8
cache-control: no-store
x-accel-buffering: no
```

Wire format — `retry:` first, then one `\n\n`-terminated frame per event, `id:` being the
event bus revision at send time:

```
retry: 3000

id: 3
event: snapshot
data: {"name":"adams-mbp","version":"0.1.0","user":{…},"limits":{…},"summary":{…},"sessions":[…],"rules":[…],"update":{…},"rev":3}

id: 4
event: pause
data: {"rules":[],"affected":["3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11"]}

id: 5
event: session
data: {"type":"update","session":{"sessionId":"3f6c1a2e-…","pid":48213,"alive":true,…}}

id: 6
event: spend
data: {"today":{"ready":true,"input":7704,"output":534151,"cacheCreate":10071412,"cacheRead":192771920,"messages":1909},"delta":{"input":7704,"output":534151,"cacheCreate":10071412,"cacheRead":192771920,"messages":1909}}

id: 7
event: spend
data: {"today":{"ready":true,"input":7708,"output":535706,"cacheCreate":10077392,"cacheRead":193378631,"messages":1911},"delta":{"input":4,"output":1555,"cacheCreate":5980,"cacheRead":606711,"messages":2}}

id: 11
event: heartbeat
data: {"rev":11,"at":"2026-09-13T19:01:56.885Z"}
```

That excerpt is the checked-in fixture
[`test/fixtures/events/stream.sse`](../test/fixtures/events/stream.sse), captured from a
real daemon; the `snapshot` frame's payload is also stored pretty-printed as
[`test/fixtures/events/snapshot.json`](../test/fixtures/events/snapshot.json).

| Event | Payload |
| --- | --- |
| `snapshot` | `{ name, version, user, limits, summary, sessions, rules, update, rev }` — `limits` is `/v1/limits` minus `raw`, `summary` is the `/v1/summary` body, so a client can label the machine without a second call |
| `limits` | `/v1/limits` minus `raw`, on each poll whose numbers actually changed |
| `spend` | `{ today, delta }`, machine-wide, coalesced to ≤ 1 per second (a coalesced `delta` is the sum of what was merged away; `today` is the newest reading) |
| `session` | `{ type: "start" \| "end" \| "update", session }` |
| `pause` | `{ rules, affected }` |
| `update` | the `/health.update` object |
| `heartbeat` | `{ rev, at }`, every 15 s |

- Every connect — including reconnects — starts with a fresh `snapshot`. `Last-Event-ID`
  is deliberately ignored.
- Back-pressure: a client whose socket has been unwritable for more than 30 s is
  destroyed. It reconnects and gets a new snapshot.
- At most `events.maxClients` (default 16) concurrent streams; beyond that, `503`:
  `{ "error": { "code": "unavailable", "message": "at most 16 concurrent event streams are
  served", "hint": "close an open stream, or raise events.maxClients in config.json" } }`.
- No WebSocket. Polling fallback for clients that cannot do SSE: `/v1/summary` plus
  `/v1/sessions` with `If-None-Match`, at ≥ 2 s intervals.

## `limits[]` normalization

`limits[]` is mapped 1:1 from the upstream `limits[]` array — the only authoritative model
in that payload. Unknown top-level keys (including unreleased windows) are ignored;
`raw` keeps them.

| Field | Rule |
| --- | --- |
| `id` | `kind`, plus `":" + scope.model.display_name.toLowerCase()` when a scoped model is present — e.g. `session`, `weekly_all`, `weekly_scoped:fable` |
| `kind` | upstream `kind`; an entry without a string `kind` is dropped entirely |
| `group` | upstream `group`, or `null` |
| `percent` | upstream integer, rounded; `null` when absent. **Thresholds are evaluated on `percent` only** — the float `utilization` in `legacyWindows` can differ by rounding |
| `severity` | upstream string passed through untouched, `null` when absent; unknown values never throw |
| `resetsAt` | upstream `resets_at` normalized through `Date` to ISO-8601 `Z`. **May be `null`** — every renderer must cope ("resets: unknown") |
| `scope` | `{ model, surface }`, each `display_name` or the raw string, each nullable; `null` when there is no scope object |
| `isActive` | `upstream.is_active === true` |

`legacyWindows` is a best-effort passthrough of `five_hour` and `seven_day` **only**
(`{ utilization, resetsAt }` each). While a statusline observation is serving `session` /
`weekly_all`, the matching `five_hour` / `seven_day` carries that observation's unrounded
figure instead, so it never lags `limits[]` (§23.37). An entry whose `resetsAt` has passed
has `utilization: null` (§23.40). Check provenance on the `limits[]` row. `seven_day_opus` and friends are not promised.
`noSessionLimit` is `true` when there is a `weekly_all` row but no `session` row: Anthropic
reports a week and no 5-hour window, so the plan has none. Clients should say so ("5h: no
limit on this plan") instead of showing a gap. It is `false` otherwise, including before
anything is known, and absent from a daemon older than §23.68.
`extraUsage` is `{ isEnabled, utilization, spendLimitReached }` from upstream
`extra_usage`, or `null`. Upstream's dollar-denominated `spend` object is surfaced only
through `extraUsage` and `raw` — which is why our token endpoint is `/v1/tokens`, not
`/v1/spend`.

## `since` and `groupBy`

`since` accepts:

| Value | Meaning |
| --- | --- |
| omitted / `today` | **UTC** midnight of the current day |
| `all` | `1970-01-01T00:00:00.000Z` |
| `<N>m` / `<N>h` / `<N>d` | now minus N minutes / hours / days |
| anything `Date.parse` accepts | that instant, re-emitted as ISO-8601 `Z` |

Anything else → `400`. The resolved instant is echoed back as `since` in the response.

Aggregates are keyed by **UTC day**, so `since` is effectively day-grained: a mid-day
`since` includes the whole UTC day it falls in. `/v1/summary.today` uses the same UTC
midnight, so the two agree.

`groupBy` is one of `project` (default), `session`, `model`, `day`. Exactly one value.

---

## Known deviations from the spec

Read against `docs/superpowers/specs/2026-09-13-claude-usage-design.md` (Part II/III
override Part I). Where the code and the spec differ, the code is what this document
describes; these are the differences worth knowing.

1. **(Resolved by §23.55.)** The three hook `POST`s used to be token-exempt from loopback;
   they now need the token like every other request.
2. **Two different `rev` counters.** `/v1/sessions.rev`, the `ETag`, and
   `/v1/pause/rules.rev` come from the session registry. The SSE `id:` field, the
   `snapshot.rev` and the `heartbeat.rev` come from the event bus, which counts *all*
   publishes. The spec reads as if there is one counter. Clients must not compare an SSE
   `id:` with a sessions `rev`.
3. **`createdBy` is inferred, not taken from the body.** `src/sessions/routes.ts` sets
   `createdBy: "dashboard"` when the request carried an `Authorization` header and
   `"cli"` when it did not. Since the CLI authenticates with the bearer token, a
   `claude-usage pause` is recorded as `createdBy: "dashboard"` — the `createdBy` the CLI
   puts in the body is ignored.
4. **`affected` counts registered sessions only.** `POST /v1/pause` returns the sessions
   the reconciliation pass walked, which is the persisted registry. Transcript-back-filled
   sessions are not in it, even though `GET /v1/sessions` will show them with a resolved
   `pause` object.
5. **`hookDebounceMinutes` is not read by the hook.** `src/hook.ts` uses its own
   `DEFAULT_DEBOUNCE_MINUTES = 10` and never loads `config.json`. The key is validated and
   stored; changing it currently has no effect.
6. **`retentionDays` is not passed to the spend store.** `src/daemon.ts` builds the store
   with `projectsDir` and `stateDir` only, so the store's own default of 90 days applies.
   Same situation: valid key, no effect.
7. **`/v1/config` returns the whole redacted config**, not §4's "thresholds, port, poll
   interval, resolved paths, enabled integrations". There is no `resolvedPaths` field.
8. **`update` is hard-coded to `disabled`.** `src/server/snapshot.ts#updateBody` returns
   `{ channel: "stable", current: <version>, available: null, state: "disabled",
   deferredReason: null }`. §20's auto-update, `claude-usage update` / `rollback` and the
   release pipeline are landing in the next merge; the `update` SSE event exists on the bus
   but nothing publishes it yet.
9. **Version string is the `package.json` version** (`0.1.0`), not §20's
   `MAJOR.MINOR.<commit-count>+<short-sha>`. That format arrives with the release job.
10. **`since` accepts more than the spec lists.** §4 documents `iso|7d|24h|today`; the
    parser also takes `all` and `<N>m`.
11. **`/v1/tokens` carries fields §4 did not list** — `stale`, and `label` on each group.
    Both come from the implementation plan's shared contract rather than the spec text.
12. **`5xx` on a slow request.** §4 specifies a 5 s request timeout but no status; the
    implementation answers `500 internal_error` with `"request timed out"` and destroys
    the socket.
13. **Preflight treats old Node as a warning, not a failure.** §8 step 1 says fail early
    on Node < 20; `src/install/preflight.ts` warns and continues (an unsupported platform
    is still a hard failure). Unreadable credentials are also a warning, by design.
14. **systemd uses `Restart=on-failure`** (§23.9) rather than §8's `Restart=always`, and
    adds `RestartSec=5`, `After=network.target`, `Type=simple`. Part III wins, as specified.
15. **The CLI subcommand is `tokens`, not `spend`.** §7.4's `claude-usage spend --since 7d
    --by project` is `claude-usage tokens --since 7d --by project`, following §23.3's
    rename of the endpoint. There is also an undocumented `claude-usage config` subcommand
    (prints the effective config as JSON) that `help` does not list, and `version` / `-V`
    as aliases of `--version`.
16. **MCP exposes five tools, not four.** §7.2 lists `get_limits`, `get_spend`,
    `get_summary`, `refresh_limits`; the code ships `get_limits`, `get_summary`,
    `get_tokens` (§23.3's rename), `get_sessions` (added by the implementation plan) and
    `refresh_limits`. `get_limits` and `refresh_limits` strip `raw` before returning.
