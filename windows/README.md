<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 Even Seal Productions -->

# usagebar — Usage Deck for Windows

Your Claude account's 5-hour and 7-day limits on Windows: a tray icon, a Claude Code status line,
and an MCP server so a session can check its own budget.

*Works with Claude Code. Not affiliated with, endorsed by, or sponsored by Anthropic.*

This is a separate, self-contained C# / .NET 9 program, not a port of the Node daemon: it keeps the
daemon's rules (only `GET /api/oauth/usage`, never refresh tokens, the §23.33 polling floor and 429
backoff, the §23.36 status-line feed, merge-only `settings.json`) but none of its code paths.
**Scope for now:** limits only — no token-spend scan, no sessions, pause or freeze, no phone
pairing or LAN listener, no self-update.

## How it works

```
Claude Code ──statusline stdin (rate_limits)──► usagebar.exe statusline ─┐
                                                                          ▼
Anthropic /api/oauth/usage ◄── poll (tray, ≥2 min, 429 backoff) ──► %LOCALAPPDATA%\usagebar\state.json
                                                                          │
                            usagebar-tray.exe (icon, popup, toasts) ◄─────┤
                            usagebar.exe mcp  (get_limits, …)       ◄─────┘
```

- **One shared cache file.** The tray polls Anthropic and writes `state.json`; everything else reads it.
  If the tray isn't running, MCP still answers with the last numbers, marked stale.
- **Live numbers for free.** Claude Code passes its own `rate_limits` to the status-line command on
  each render; usagebar folds those in, and polls Anthropic only hourly while that feed is fresh.
- **Gentle on Anthropic.** The usage endpoint rate-limits hard (a 60 s poll earned upstream a
  50-minute ban). Default 5 min, never under 2, doubling on each 429 up to 30 min, Retry-After honoured.
- **Read-only.** Reads `~/.claude/.credentials.json`; never refreshes tokens; calls one endpoint.

## Build and install

Needs the .NET 9 SDK (`winget install Microsoft.DotNet.SDK.9`) and Claude Code signed in.

```powershell
.\build.ps1                       # tests + publish to .\publish
.\publish\usagebar.exe install    # asks before each step
```

`install` copies to `%LOCALAPPDATA%\Programs\usagebar` (a `current` junction points at the active
version), starts the tray at sign-in (HKCU Run), runs `claude mcp add --scope user usagebar`, and
adds a `statusLine` to `~/.claude/settings.json` — only if you don't have one already.

Windows 11 hides new tray icons under `^`: drag it onto the taskbar, or enable it in
Settings → Personalization → Taskbar → Other system tray icons.

## Use

| | |
|---|---|
| Tray icon | the tighter window's %, green/amber/red; a bar under the number = 7-day window |
| Left-click | bars, reset countdowns, freshness, Refresh, Notifications, Quit |
| Toasts | at 80 % and 95 % (once per window) and when a window you'd pushed resets |
| `usagebar status` | the same in a terminal (`--json` for the raw view) |
| `usagebar refresh` | ask Anthropic now (served from cache within 60 s of the last call) |
| MCP | `get_limits`, `get_summary`, `refresh_limits` |

Config: `%LOCALAPPDATA%\usagebar\config.json` — `warn`, `critical`, `notifications`, `pollIntervalSeconds`.
Logs: `%LOCALAPPDATA%\usagebar\logs`. Remove: `usagebar uninstall [--purge]`.
