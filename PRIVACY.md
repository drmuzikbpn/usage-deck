# Privacy

This policy covers Usage Deck for Android from Google Play. Even Seal Productions makes the app.
Usage Deck collects nothing.

- **No accounts, no analytics, no tracking, no ads.** The app has no server of its own.
- **It talks only to your own computers.** The app connects to the `claude-usage` daemons you pair
  it with, over your local network or a private network you run, and to nothing else. It never
  contacts Anthropic, and nothing is sent to the developer.
- **What stays on your phone:** the list of paired computers, your settings, and each computer's
  access token, which is encrypted with a key held in the Android Keystore. App data is excluded
  from Android backups.
- **What the app shows:** usage percentages, reset times, project and session names, and token
  counts, read from your own computers. The app does not keep a history once it is closed.
- **Pausing:** when you pause a session, the app sends that request to the computer running it,
  with a random id made on this phone so that it can recognise its own pauses.
- **Try the demo:** shows made-up computers and sessions generated on the phone. Nothing is fetched
  or saved, and it ends when you exit it, pair a computer or quit the app.
- **Camera:** used only to scan a pairing QR code when you choose to; no image is stored.
- **Notifications:** used only for usage alerts and the notice that background watching is on. The
  app asks for this permission only when you turn background watching on.
- **Background watching:** off by default. While on, the app keeps its connection to your computers
  open and shows an ongoing notification.

**Google:** if you share usage and diagnostics with app developers on your phone, Google may pass
crash reports to the developer. That data is collected by Google, under Google's own privacy policy.

Removing the app deletes everything it stored. Questions: open an issue at
<https://github.com/drmuzikbpn/usage-deck/issues>.
