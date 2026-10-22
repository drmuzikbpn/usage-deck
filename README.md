# Usage Deck for iPhone and Apple Watch

<img src="docs/images/header.png" width="100%" alt="Usage Deck: your Claude Code rate limits and every live session, on iPhone, Apple Watch and your desk">

Not affiliated with Anthropic.

See how close your Claude account is to its 5-hour and 7-day limits, how many tokens your Claude
Code sessions are burning, and pause or freeze sessions — from your iPhone, your lock screen and
your wrist.

Usage Deck does not talk to Anthropic. It reads everything from
[`claude-usage`](https://github.com/drmuzikbpn/usage-deck), a small daemon you run on
the computer where you use Claude Code (macOS or Linux), and talks only to that computer.

## Get it

Usage Deck is free on the App Store (in App Review now). It runs on iOS 18 or later; the Apple
Watch app needs watchOS 11 or later and installs with it. Nothing to pair yet? Tap
**Try the demo** to explore it with made-up data.

## What it looks like

Every picture here is the app's demo mode: made-up devices, accounts and projects.

| Ledger | Expanded project | Project | Device | Pairing |
| --- | --- | --- | --- | --- |
| <img src="docs/images/iphone-ledger.png" width="160" alt="iPhone home: two accounts and three live projects"> | <img src="docs/images/iphone-ledger-expanded.png" width="160" alt="A project unfolded into its sessions"> | <img src="docs/images/iphone-project.png" width="160" alt="Project drill-in with a five-hour burn chart"> | <img src="docs/images/iphone-device.png" width="160" alt="Device screen with its setup checklist"> | <img src="docs/images/iphone-pairing.png" width="160" alt="Pairing sheet"> |

Landscape turns the iPhone into the wide dock, the way it looks best on a desk stand, and every
screen follows it round:

<img src="docs/images/iphone-wide-dock.png" width="520" alt="Landscape wide dock: an account's limit rings beside every live session"> <img src="docs/images/iphone-landscape-project.png" width="520" alt="A project's five-hour burn chart in landscape">

A re-pair that would change a device's certificate says so first:

<img src="docs/images/iphone-re-pair-warning.png" width="160" alt="Re-pair confirmation warning that the certificate differs">

Widgets (small, medium, and the lock-screen circular, rectangular and inline families):

<img src="docs/images/widget-systemSmall.png" width="120" alt="Small widget"> <img src="docs/images/widget-systemMedium.png" width="250" alt="Medium widget"> <img src="docs/images/widget-accessoryCircular.png" width="56" alt="Circular lock-screen widget"> <img src="docs/images/widget-accessoryRectangular.png" width="130" alt="Rectangular lock-screen widget"> <img src="docs/images/widget-accessoryInline.png" width="190" alt="Inline lock-screen widget">

Apple Watch: an account page, the projects list, a project, the actions page, and the
complications (circular, rectangular, corner, inline):

<img src="docs/images/watch-account.png" width="150" alt="Watch account page with 5-hour and 7-day rings"> <img src="docs/images/watch-projects.png" width="150" alt="Watch projects list"> <img src="docs/images/watch-project.png" width="150" alt="Watch project detail"> <img src="docs/images/watch-actions.png" width="150" alt="Watch actions page">

<img src="docs/images/complication-accessoryCircular.png" width="50" alt="Circular complication"> <img src="docs/images/complication-accessoryRectangular.png" width="150" alt="Rectangular complication"> <img src="docs/images/complication-accessoryCorner.png" width="44" alt="Corner complication"> <img src="docs/images/complication-accessoryInline.png" width="150" alt="Inline complication">

## Pair a computer

1. Install `claude-usage` on the computer: see
   <https://github.com/drmuzikbpn/usage-deck>.
2. Turn on local-network access: `claude-usage configure lan on` (or answer yes when `install`
   asks).
3. Run `claude-usage pair`. It opens a page with a QR code.
4. Point the iPhone Camera at the QR and tap **Open in Usage Deck**. (Or scan it from inside the
   app.)

Pairing happens over HTTPS pinned to the computer's own certificate, and the QR holds a one-time
code that expires after five minutes — it never contains your access token. When you re-pair a
device and the code carries a different certificate from the one you paired, the app says so
before it replaces anything: continue only if you ran `claude-usage pair` on that device yourself. Your iPhone and the
device need to be on the same Wi-Fi, or on the same private network, such as Tailscale, when you are away.

The Apple Watch app needs no setup: it gets everything from the iPhone, never from the device
directly.

## Removing a device, or losing the iPhone

Each paired device gives the iPhone an access token, kept in the iPhone Keychain (this iPhone
only: never iCloud, never the watch). Removing a device in Usage Deck deletes the iPhone's copy,
and the app also deletes any stored token that no paired device owns the next time it opens (the
Keychain outlives an uninstall). **Neither revokes the token**: the daemon still accepts it.

To revoke access — after removing a device you no longer trust this iPhone with, or if the
iPhone is lost, sold or stolen — run this on **each** paired machine:

```bash
claude-usage configure rotate-token
```

That replaces the daemon's token, so every phone paired with that machine stops being accepted;
pair the ones you still use again with `claude-usage pair`.

## Building

```bash
brew install xcodegen swiftlint swiftformat lefthook
lefthook install            # lint, licence headers and scripts/public-check.sh on every commit
(cd Packages/UsageCore && swift test)
xcodegen generate
xcodebuild -project UsageDeck.xcodeproj -scheme UsageDeck -destination 'generic/platform=iOS Simulator' build
```

With nothing paired, **Try the demo** on the home screen shows the same made-up data in any
build. Launch a Debug build with the `-UsageDeckDemo` argument to see the app filled with made-up
devices and no daemon; the UI smoke test (`xcodebuild ... test`) does exactly that.

Requires Xcode with the iOS 18 and watchOS 11 SDKs or later. Design:
[`docs/superpowers/specs/2026-10-01-usage-ios-design.md`](docs/superpowers/specs/2026-10-01-usage-ios-design.md).
Privacy: [`PRIVACY.md`](PRIVACY.md). Licence: [MIT](LICENSE); the bundled fonts are under the SIL
Open Font License (`App/Resources/Fonts/OFL.txt`, `SharedUI/Fonts/OFL.txt`).
