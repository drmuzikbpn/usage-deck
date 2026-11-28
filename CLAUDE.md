# claude-usage (repo: usage-deck)

Local daemon + hooks + MCP server giving Claude Code sessions account rate-limit % and local
token spend; remote dashboards consume it over the LAN (HTTPS, pinned) or Tailscale — the Android
dashboard lives on orphan branch `usage-android` of this repo; the iOS/watch app lives on
`usage-ios`. A separate limits-only Windows program (C# / .NET 9, tray + status line + MCP) lives
in `windows/` on `main`; it is not in the daemon tarball, CI's `windows` job builds and tests it,
and changes only under `windows/` cut no release. **Spec is authoritative:** `docs/superpowers/specs/2026-09-13-claude-usage-design.md`
— Part II and Part III override Part I where they conflict. Plan: `docs/superpowers/plans/`.

## Commands
- `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` (dist/, ESM, Node ≥ 20)
- lefthook pre-commit runs lint + typecheck.
- **`main` is protected: changes land through a pull request** (ruleset "daemon: main via pull
  request"; required checks `test (ubuntu-latest)` + `test (macos-latest)`). Never push to
  `main` directly, even though admin rights would bypass it. Branch, `gh pr create`, then
  `gh pr checks --watch && gh pr merge --squash`. Each merge to `main` builds, signs and publishes a release on its own (the `release-daemon`
  environment is restricted to `main`; no manual approval).

## Invariants (violations are silent)
- Never print, log or serialize credential values (`accessToken`, `refreshToken`, bearer token).
  Fixtures under `test/fixtures/` must contain no credentials and no real prompt text.
- Never refresh Anthropic OAuth tokens; never call any Anthropic endpoint other than
  `GET /api/oauth/usage`.
- Hooks always exit 0 and never block; daemon unreachable ⇒ hook prints nothing.
- Every request requires the bearer token, from loopback too (§23.55). Only exceptions:
  `POST /v1/pair` (§23.47 — TLS only, one-time code, rate-limited) and a token-less
  `GET /health`, which returns `{ "ok": true }` and nothing else. `Sec-Fetch-Site` ≠ `none` is
  403. Local clients send the token only to a listener that passed the §23.61 HMAC proof.
  Never log or print pairing codes or the token (`config` output and `/v1/config` redact it).
- Plain HTTP on loopback only; every non-loopback listener is HTTPS (§23.57). Never bind a
  wildcard or public address without `allowPublicBind: true`.
- Session ids are UUIDs before they reach a path or URL; a pid is kept only for a same-uid
  Claude Code process and re-verified by start time + boot id before any signal; never signal
  the daemon or its ancestors; record frozen pids before `SIGSTOP` (§23.56).
- Updates must verify `SHA256SUMS.sig` against `src/update/trusted-keys.ts` before any checksum
  or extraction; deps install with `npm ci` from the shipped lockfile (§23.59). Never publish
  to npm (`private: true`).
- System programs (`ps`, `tar`, `security`, `launchctl`, `systemctl`, `tailscale`, …) by
  absolute path; JSON parse errors report a position, never text (§23.62).
- Hard-frozen pids must be SIGCONTed on shutdown/uninstall; `claude-usage resume --all`
  must work with the daemon dead.
- Edits to `~/.claude/settings.json` are merge-only; `~/.claude.json` is written via
  `claude mcp add` (fallback: atomic 0600 rename, no .bak).
- Daemon runtime deps: none (stdlib only). `@modelcontextprotocol/sdk` (the only production
  dependency) is loaded lazily by `mcp` only.
- Tests are TDD; `test/**/*.test.ts`; use temp dirs via `XDG_CONFIG_HOME`, never the real
  `~/.claude`. Test keys are generated in the test.
- Every source file starts with the SPDX MIT + `Copyright (c) 2026 Even Seal Productions`
  header (`test/license-headers.test.ts`). `scripts/public-check.sh` runs pre-commit; never
  `--no-verify` past it.
