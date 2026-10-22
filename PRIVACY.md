# Privacy

Usage Deck collects nothing.

- **No accounts, no analytics, no tracking, no ads.** The app has no server of its own.
- **It talks only to your own devices.** The iPhone app connects to the `claude-usage` daemons
  you pair it with — on your local network, or over a private network you run, such as Tailscale — and to nothing else. It
  never contacts Anthropic. The Apple Watch app talks only to your iPhone.
- **What stays on your iPhone:** the list of paired devices, your settings, and each device's
  access token, which is kept in the iPhone Keychain (this device only; not synced to iCloud,
  not shared with the watch, widgets or any other app).
- **What reaches your watch and widgets:** usage percentages, reset times, project and session
  names and token counts — the same numbers the iPhone shows. Never the access token.
- **Debug log:** the app keeps a short record (at most 800 lines) of pairing, connection and
  alert events on your iPhone to help with troubleshooting. It is excluded from device backups
  and leaves the iPhone only when you choose Settings › Send debug log, to whoever you send it
  to; you can clear it there too. Exactly what an exported log contains:
  - the time of each event; the app version, iOS version and how many devices are paired;
  - when the app entered or left the foreground and when a background refresh ran;
  - pairing attempts: how many addresses were tried, how many attempts it took, and an error
    code if it failed;
  - which address answered or failed, with an error code (never an error's text);
  - each change in a device's health or pairing state;
  - each alert's kind and its identifier (a device, session, limit or account id) — never the
    alert's text, an account name or an e-mail address.

  Device names and addresses are replaced with placeholders (`device-1`, `host-1`) in the copy
  you send unless you turn off "Hide device names and addresses". The log never contains access
  tokens, pairing codes, certificate fingerprints, project names, session titles or usage
  figures.
- **Try the demo:** shows made-up devices and sessions generated on the iPhone. Nothing is
  fetched or saved, and it ends when you leave it, pair a device or quit the app.
- **Camera:** used only to scan a pairing QR code when you choose to; no image is stored.
- **Local network:** used only to reach the devices you pair.

**Apple:** if you share analytics with app developers in iOS Settings, Apple may pass crash
reports to the developer. While you test a TestFlight build, Apple's TestFlight service may share crash
reports and basic usage information (such as sessions and device model) with the developer,
under Apple's own privacy policy. That data is collected by Apple, not by this app, and you can
turn it off in TestFlight's settings.

Questions: open an issue at <https://github.com/drmuzikbpn/usage-deck>.
