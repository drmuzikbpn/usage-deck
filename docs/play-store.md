# Google Play

Everything the Play Console asks for, ready to paste. Store copy says "local network", never
Tailscale or VPN, the same as the App Store listing.

## Listing

- **App name:** Usage Deck
- **Default language:** English (United States)
- **Category:** Developer tools, or Productivity if the Console has no such category
- **Short description (80 max):** Your Claude Code limits and sessions, live, from your own computers.
- **Full description:**

```text
See how close you are to your Claude limits without leaving your phone.

Usage Deck connects to the free claude-usage daemon on your computer and shows, live:

• Your 5-hour and 7-day limits, with reset times
• Every running Claude Code session, grouped by project
• Tokens per minute, and today's total
• Several computers and accounts in one view

Stop a session from your phone: tap to pause it at its next tool call, or hold to freeze it. Tap again to resume.

Get an alert before you hit a limit. Turn on background watching and alerts keep coming with the app closed.

Private by design. There is no account and no server. The app talks only to your own computers over your local network, and everything stays on your devices.

You need a computer running Claude Code with the claude-usage daemon installed. Setup takes a minute: run claude-usage pair and scan the QR code. No computer handy? Tap Try the demo.

Usage Deck is an independent app, not affiliated with Anthropic.
```

- **Assets:** `docs/images/play/` has the 512 px icon, the 1024×500 feature graphic and phone
  screenshots. The screenshots are the emulator running "Try the demo", so every name and number
  is synthetic and the demo banner stays visible.
- **Privacy policy:** <https://github.com/drmuzikbpn/usage-deck/blob/usage-android/PRIVACY.md>

## App content

- **Ads:** no ads.
- **App access:** all functionality needs a paired computer. Under "Any other instructions":
  `Open the app and tap "Try the demo" on the first screen. It shows made-up computers and sessions, with every screen available. A real connection needs the claude-usage daemon on a computer on the same local network.`
- **Content rating:** utility, no user-generated content, no sharing of location, no purchases.
- **Target audience:** 18 and over.
- **News, health, financial, government, gambling:** no to each.
- **Data safety:** no data collected, no data shared. All traffic goes to the user's own computers,
  never to the developer, and is encrypted in transit (pinned HTTPS).

## Foreground service declaration

- **Type:** `specialUse`.
- **Description:** `Optional, off by default. When the user turns on "Keep watching in the background" in Settings, the app keeps a connection to the user's own computers so it can alert them before they hit a usage limit. An ongoing notification stays visible, and turning the switch off stops the service.`
- **User impact if deferred:** `A usage-limit alert would arrive after the limit was reached, when it is too late to act on it.`
- **Demo video:** still to record: Settings, turn the switch on, leave the app, show the
  notification, return, turn it off.

## Release

1. CI's `play-bundle` job signs a bundle on each push to `usage-android`, once the `release-play`
   environment holds `PLAY_UPLOAD_KEYSTORE_B64`, `PLAY_UPLOAD_STORE_PASSWORD` and
   `PLAY_UPLOAD_KEY_ALIAS`. The upload key lives in the `usagedeck` 1Password vault first.
2. Upload that artifact to internal testing, enrolling in Play App Signing, and fix what the
   pre-launch report finds.
3. A personal developer account created after 13 November 2023 then needs a closed test with 12
   opted-in testers for 14 days before it can apply for production access.
