# Contributing to Usage Deck

Thanks for looking. This branch (`usage-android`) is the Android kiosk; the `claude-usage` daemon it
talks to lives on `main` of the same repository and has its own contributing notes.

## Ground rules

- **Pull requests only.** `main` and `usage-android` do not accept direct pushes. Fork, branch from
  `usage-android`, open a PR against `usage-android`.
- **CI must be green.** ktlint, every JVM suite and the instrumented suite on an API 29 emulator run
  on every PR. Releases are only cut from `usage-android` itself, never from a PR.
- **Keep the contract.** The deck reads the daemon's `limits[]`, SSE stream and pause API exactly as
  the daemon spec describes them (see `docs/superpowers/specs/`). A change that needs a daemon
  change should say so and link the matching daemon PR.
- **No secrets, ever.** Nothing under `app/signing/` but the public lineage. Pairing files, tokens
  and keystores never enter the tree. Fixtures use `example.com` addresses and TEST-NET IPs.

## Setting up

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17          # any JDK 17 works
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
./gradlew :core:test :fakedaemon:test :app:testDeckDebugUnitTest :app:testPlayDebugUnitTest
scripts/emulator.sh && ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedDeckDebugAndroidTest
```

`scripts/fakedaemon.sh warnCrossing` gives the emulator something to show without a real daemon.
`README.md` has the rest; `CLAUDE.md` holds the working notes and gotchas and is worth a read
even if you are not using Claude Code.

## Style

- `./gradlew ktlintFormat` before every commit; lefthook runs `scripts/public-check.sh`, ggshield (when
  installed), `ktlintCheck` and `:core:test` on pre-commit (`lefthook install`).
- Conventional commit messages: `feat(widedock): …`, `fix(pause): …`, `docs: …`.
- Every behaviour change comes with a test. Core logic is tested on the JVM; anything Compose gets
  an instrumented test. Nothing may be `@Ignore`d and no `TODO`/`FIXME` lands.
- Single dark theme, tabular numerals, the gesture grammar in `CLAUDE.md` (tap = soft, hold = hard,
  red only on hold). If a change bends one of these, explain why in the PR.

## Reporting problems

Bugs and ideas go in GitHub issues. Anything security-related goes through
[SECURITY.md](SECURITY.md) instead.
