# Contributing to claude-usage

Thanks for looking. This branch (`main`) is the local daemon, hooks, CLI and MCP server. The
Android dashboard that consumes it lives on the `usage-android` branch of the same repository,
and the iPhone and watch app on `usage-ios`; each has its own contributing notes.

**The spec is authoritative**, not the code:
`docs/superpowers/specs/2026-09-13-claude-usage-design.md`. Part II and Part III override Part I
where they conflict, and Part III is a running log of faults found on real machines — read the
section covering anything you are about to change.

## Ground rules

- **Pull requests only.** `main` does not accept direct pushes. Fork, branch from `main`, open a
  PR against `main`.
- **CI must be green.** `test (ubuntu-latest)` and `test (macos-latest)` are required. Every merge
  to `main` builds a release, which re-runs these checks and then publishes on its own.
- **Tests are TDD, and a new test must fail first.** Write it, watch it fail against the unfixed
  code, then fix. Several bugs in Part III were introduced by tests that passed against a fake
  which never returned an error — a test that has never failed has not been tested.
- **Use temp dirs.** `XDG_CONFIG_HOME` via the helpers in `test/install/helpers.ts`. A test must
  never touch the real `~/.claude`.
- **No secrets, ever.** Fixtures under `test/fixtures/` contain no credentials and no real prompt
  text. Examples use `example.test` addresses and the RFC 5737 documentation IPs
  (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`). Test keys are generated inside the tests.
- **Every source file carries the licence header** — `SPDX-License-Identifier: MIT` and
  `Copyright (c) 2026 Even Seal Productions`, in the file's comment syntax, after any shebang.
  `test/license-headers.test.ts` fails without it. `vendor/` and fixtures keep their own.

## Invariants

These are the ones whose violation is silent. `CLAUDE.md` holds the full list.

- Never print, log or serialize a credential value — `accessToken`, `refreshToken`, or a bearer
  token.
- Never refresh Anthropic OAuth tokens, and never call any Anthropic endpoint other than
  `GET /api/oauth/usage`.
- Hooks always exit 0 and never block. A daemon that is unreachable means the hook prints nothing.
- Every request requires the bearer token, from loopback too. The only exceptions are
  `POST /v1/pair` and a liveness-only `GET /health`. Plain HTTP is served on loopback only.
- Hard-frozen pids must be `SIGCONT`ed on shutdown and uninstall, and `claude-usage resume --all`
  must work with the daemon dead.
- Edits to `~/.claude/settings.json` are merge-only.
- The daemon has no runtime dependencies — stdlib only. `@modelcontextprotocol/sdk` is loaded
  lazily by the `mcp` subcommand, and is the only production dependency.
- Anything after the service step in `install` degrades to a note. A late step must never abort
  and destroy the report of the steps that already succeeded (§23.9, §23.29).

## Setting up

```bash
npm ci
npm test                 # vitest
npm run typecheck
npm run lint
npm run build            # dist/, ESM, Node >= 20
```

The installed daemon runs on Node 20 or later; working on it (vitest 5, eslint 10) needs
Node 22.12 or later.

`npm ci` installs the lefthook pre-commit hook for you via `prepare`; it runs lint, typecheck,
`scripts/public-check.sh` and `ggshield secret scan` on every commit. If your npm is set to skip install scripts (it
prints an `allow-scripts` warning), run `npx lefthook install` yourself.

The secret scan is required: a commit fails on a machine without GitGuardian's `ggshield`. Set it
up once with `brew install ggshield` (or `pipx install ggshield`) and `ggshield auth login`, which
needs a free GitGuardian account. Clear a confirmed false positive with
`ggshield secret ignore --last-found`; never commit with `--no-verify`.

## What may not be committed

This is a public repository, so `scripts/public-check.sh` reads the staged diff before every
commit and refuses it when an added line contains:

| Rule | What trips it |
| --- | --- |
| `credential` | a private-key header, a vendor token prefix (`sk-ant-`, `ghp_`, `github_pat_`, …), or a bearer-looking string of 40+ characters outside tests and lockfiles. `gitleaks protect --staged` runs as well when gitleaks is installed |
| `email` | any address other than `*@example.test`, `*@example.com`, `noreply@anthropic.com`, GitHub's no-reply addresses and `support@evensealproductions.com` |
| `home-path` | `/Users/<name>/` or `/home/<name>/` — use `alice`, `you` or `runner` |
| `ipv4` | an address outside loopback and the RFC 5737 documentation ranges |
| `cgnat` | anything inside `100.64.0.0/10`, the range Tailscale assigns from |
| `tailnet` | a `*.ts.net` machine name other than `example.ts.net` |
| `blocklist` | a literal from your own `.public-check.local` |
| `identity` | an author or committer e-mail other than `support@evensealproductions.com` |

Run it by hand with `bash scripts/public-check.sh`, or against any diff with
`bash scripts/public-check.sh --diff some.patch`.

- **Private words.** Put names, hostnames or anything else you never want published into an
  untracked `.public-check.local` at the repository root, one literal per line (`#` comments
  and blank lines are ignored). It is git-ignored, matched case-insensitively, and the script
  reports the entry's line number rather than the word. A linked worktree falls back to the
  main worktree's file.
- **Deliberate exceptions.** A line carrying the marker `public-check:allow` is exempt from the
  `email`, `home-path`, `ipv4`, `cgnat` and `tailnet` rules — for a test that genuinely needs a
  private or CGNAT address, say. The marker never excuses a credential or a blocklisted literal.
- **Do not bypass it** with `--no-verify`. If the check is wrong, fix the check.

The script is self-contained (bash 3.2, grep, sed, awk) and holds generic patterns only, so the
same file is used unchanged on the app branches. Its tests are `test/public-check.test.ts`.

`docs/smoke-test.md` covers what unit tests cannot: the service really being supervised,
unattended self-update, pause and freeze against live sessions. Run the sections your change
touches on a real machine — most of Part III is faults that every test suite reported as fine.

## Style

- Conventional commit messages: `feat(pause): …`, `fix(service): …`, `docs: …`.
- Every behaviour change comes with a test. Nothing is skipped, and no `TODO`/`FIXME` lands.
- Comments explain *why*, and cite the spec section when there is one. The interesting comments
  in this codebase are the ones recording what was measured on a real machine.
- If a change bends an invariant above, say so in the PR and explain why.

## Reporting problems

Bugs and ideas go in GitHub issues. Anything security-related goes through
[SECURITY.md](SECURITY.md) instead.
