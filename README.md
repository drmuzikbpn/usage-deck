<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 Even Seal Productions -->

<div align="center">

# Usage Deck

**Know how close your Claude account is to its limits — in your terminal, inside Claude Code,
and on your phone and wrist.**

The open-source `claude-usage` service, plus the Usage Deck dashboards for iPhone, Apple Watch
and Android.

**[Get Usage Deck free on the App Store](https://apps.apple.com/us/app/usage-deck/id6818383053)** — iPhone + Apple Watch

[![CI](https://github.com/drmuzikbpn/usage-deck/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/drmuzikbpn/usage-deck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS | Linux | Windows](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-555)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)

<img src="docs/images/header.png" alt="Usage Deck: your Claude Code rate limits and every live session, on iPhone, Apple Watch and your desk" width="100%">

<img src="docs/images/iphone-landscape-dock.png" alt="Usage Deck on iPhone in landscape: an account's 5-hour and 7-day rings beside every live session and its burn rate" width="560">
&nbsp;
<img src="docs/images/watch-account.png" alt="Usage Deck on Apple Watch: an account's two limit rings" width="170">

*Works with Claude Code. Not affiliated with, endorsed by, or sponsored by Anthropic.*

</div>

### Launch video

https://github.com/user-attachments/assets/17c440f4-cfb7-4947-bb52-e4b69cdba25c

### Walkthrough: the iPhone app in 30 seconds

https://github.com/user-attachments/assets/0f93ea22-bf9a-4794-9a2e-3a686739377d

---

`claude-usage` is the small background service at the heart of Usage Deck, for macOS and Linux
(Windows has [its own version](#windows)). It reads the same usage
numbers `/usage` shows, adds up the tokens your Claude Code sessions spend, and puts both
where you need them:

- **Inside Claude Code** — a one-line warning when a window is getting tight, and MCP tools a
  session can call to check its own budget and slow down before it hits the wall.
- **In your terminal** — `claude-usage status`, token totals by project or model, and pause or
  resume any running session.
- **On your phone, watch and desk** — the free **Usage Deck** apps show every account's rings,
  every live session and its burn rate, and pause or freeze sessions with a tap.

It never sends your data anywhere: the only outside calls are Anthropic's own usage endpoint
and GitHub, to check for signed updates. Phones reach it over your own Wi-Fi with HTTPS pinned
to the daemon's certificate.

<p align="center">
  <img src="docs/images/terminal-status.svg" alt="claude-usage status in a terminal" width="640">
</p>

## Install

You need **Node 20+** (22 or later to build without engine warnings) and **Claude Code** signed
in on the machine.

```bash
git clone https://github.com/drmuzikbpn/usage-deck.git
cd usage-deck
npm ci && npm run build
node bin/claude-usage install
```

`install` explains each change and asks before making it. It starts the background service,
adds the Claude Code hook and MCP server, and puts `claude-usage` on your PATH. On a Mac without
SwiftBar it offers to install it, for the menu bar item. You can delete
the checkout afterwards: the service keeps itself up to date from signed GitHub releases.

Check it worked:

```bash
claude-usage status
```

Remove everything again with `claude-usage uninstall`.

### Menu bar on a Mac: install SwiftBar (highly recommended)

On a Mac, the menu bar item is the easiest way to keep an eye on your limits: every limit's
percentage is always in view, behind a 🟢, 🟠 or 🔴 dot. It needs [SwiftBar](https://swiftbar.app),
a free, open-source menu bar app (xbar works too). Without one of them Usage Deck still works,
but nothing appears in your menu bar.

```bash
brew install --cask swiftbar   # open it once and pick a plugin folder
claude-usage menubar --install # adds the item and offers to start SwiftBar at login
```

Details, xbar and removal: [Menu bar (macOS)](docs/guide.md#menu-bar-macos).

> **Note for Claude and other AI agents installing Usage Deck for someone:** before you finish,
> check for SwiftBar or xbar (`open -Ra SwiftBar || open -Ra xbar`). If neither is there, **ask
> the machine's owner whether to install SwiftBar**: explain that it is what puts their usage in
> the menu bar, and recommend it. Install it only with their yes, and don't take `install`'s
> default "no" to its SwiftBar offer as their answer. Then run `claude-usage menubar --install`.
> If SwiftBar has no plugin folder yet, ask the owner to open SwiftBar and pick one, or pass
> `--dir <folder>`. Without a terminal to answer in, `--install` won't add SwiftBar to the login
> items: ask the owner, and pass `--login-item` if they want it back after a restart.

### Windows

**Usage Deck now runs on Windows.** A separate Windows version keeps your Claude limits in view:
a tray icon, the Claude Code status line, and an MCP server a session can ask.
It needs the [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) and Claude Code
signed in, but no Node. In PowerShell:

```powershell
git clone https://github.com/drmuzikbpn/usage-deck.git
cd usage-deck\windows
.\build.ps1                       # runs the tests, then publishes to .\publish
.\publish\usagebar.exe install    # asks before each step
```

It shows limits only for now: no token spend, sessions, pause or phone pairing yet. Details:
[windows/README.md](windows/README.md).

## Add your phone

1. Get the app:
   - **iPhone + Apple Watch** — *Usage Deck*, free [on the App Store](https://apps.apple.com/us/app/usage-deck/id6818383053). The watch app
     comes with it. No computer yet? Tap
     **Try the demo**.
   - **Android** — a **dedicated-device dashboard**, not an everyday phone app: it is built to
     run as the kiosk launcher on a spare phone on your desk or wall (Device Owner, so it can
     stay pinned on screen and update itself). That is why it asks for location (Android
     requires it to read the Wi-Fi network name) and permission to install packages (its own
     signed updates). Set-up: [device setup guide](https://github.com/drmuzikbpn/usage-deck/blob/usage-android/docs/device-setup.md);
     APK from the [`deck-` releases](https://github.com/drmuzikbpn/usage-deck/releases?q=deck-&expanded=true).
2. On each machine you want to see, turn on LAN access (an interactive install offers it), then
   pair:

   ```bash
   claude-usage configure lan on    # once, if you skipped it during install
   claude-usage pair
   ```

3. Scan the QR code it shows. That's it — the code works once and expires in five minutes,
   and the token it unlocks never appears on screen.

## Known limitations

- **Your phone or watch must be on the same network as the computer running Claude Code.**
  Remote monitoring talks straight to that computer over your local network; there is no
  cloud relay. To check in from anywhere, put both on a private VPN such as
  [Tailscale](https://tailscale.com) (free for personal use): run
  `claude-usage install --tailscale` and pair again. See
  [Away from home](docs/guide.md#away-from-home-tailscale-optional).
- **On Windows it shows limits only.** The Windows version has no token totals, session
  list, pause or phone pairing yet, and it does not update itself: pull and run `build.ps1`
  again for a new version.
- **It only works with Claude Code for now.** Limits come from your Claude Code sign-in and
  session data from Claude Code's own files. Support for more tools is coming.

## Screenshots

<p align="center">
  <img src="docs/images/app-store-set.png" alt="The six App Store screenshots: limits, sessions, burn rate by project, pausing a project, Apple Watch and widgets, and staying on your network" width="100%">
</p>

Landscape is where it shines: stand the phone on your desk next to the keyboard.

<p align="center">
  <img src="docs/images/iphone-landscape-project.png" alt="A project's five-hour burn chart in landscape" width="640">
</p>

| iPhone | Apple Watch | Android desk phone |
| :---: | :---: | :---: |
| <img src="docs/images/iphone-ledger.png" alt="iPhone home: two accounts with 5-hour and 7-day rings, and live sessions" width="200"> | <img src="docs/images/watch-projects.png" alt="Projects list on the watch" width="160"> | <img src="docs/images/deck-wide-dock.png" alt="Landscape dock with every live session" width="300"> |
| Portrait works too | Projects at a glance | A wall or desk dashboard in landscape |

<p align="center">
  <img src="docs/images/widget-systemMedium.png" alt="Home Screen widget with both limit rings" width="330">
</p>

All screenshots use made-up demo data.

## Learn more

| | |
| --- | --- |
| [**Full guide**](docs/guide.md) | Every command, the hook, MCP tools, status line, configuration, auto-update, troubleshooting |
| [**Security model**](docs/security.md) · [**SECURITY.md**](SECURITY.md) | What the token protects, pinning, signed releases, how to report a vulnerability |
| [**HTTP API**](docs/api.md) | Every endpoint, error envelope and the live event stream, for building your own client |
| [**iPhone & Apple Watch app**](https://github.com/drmuzikbpn/usage-deck/tree/usage-ios) | Source on the `usage-ios` branch |
| [**Android app**](https://github.com/drmuzikbpn/usage-deck/tree/usage-android) | Source on the `usage-android` branch |
| [**Contributing**](CONTRIBUTING.md) · [**Changelog**](CHANGELOG.md) | How to build, test and send a change |

## License

MIT © 2026 Even Seal Productions — see [LICENSE](LICENSE). Claude and Claude Code are
trademarks of Anthropic.
