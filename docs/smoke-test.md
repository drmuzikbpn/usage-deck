# Smoke test

The manual checklist from spec §14. Run it on the real phone after any release that touches the
kiosk, wifi, pairing or update paths — the automated suites cannot reach any of these.

Tick each line, or write down what happened instead.

## Kiosk

- [ ] `adb shell dumpsys device_policy | grep -i "device owner"` names
      `com.evenseal.usagedeck/.kiosk.DeviceAdminReceiver`.
- [ ] Lock task holds: pressing Home and Recents does nothing, and the status and navigation bars
      are gone.
- [ ] Rebooting the phone comes straight back into the deck with no launcher picker.
- [ ] With no PIN set, holding the top-left corner for 3 s leaves lock task at once.
- [ ] With a PIN set, the same hold opens the PIN dialog; a wrong PIN counts down
      remaining attempts; the right one leaves lock task.
- [ ] Within 10 minutes of that exit the deck re-pins itself without being touched.
- [ ] Battery-optimisation exemption is still granted (Machine screen, or
      `adb shell dumpsys deviceidle whitelist | grep usagedeck`).

## Wifi

- [ ] The Wifi screen lists networks sorted strongest first, each with a security tag, and says
      how old the scan is.
- [ ] Rescan is disabled for 30 s after a scan, then works.
- [ ] Joining a **phone hotspot** with a WPA2 passphrase succeeds and the status chip updates.
- [ ] Joining an open network succeeds without a passphrase prompt.
- [ ] Forget removes a saved network.
- [ ] On a captive-portal network, *Open captive portal* loads the login page **inside lock task**
      and Done returns to the deck.

## Exit PIN and storage

- [ ] A freshly provisioned deck does not ask for a PIN; *Settings → Kiosk exit PIN* says Off.
- [ ] *Turn on* stays disabled until both entries match; the keyboard's Next key moves to *Again*.
- [ ] *Remove PIN* needs the current PIN and puts the corner gate back to hold-only.
- [ ] *Settings → Kiosk exit PIN* refuses a new PIN or removal without the current one, and five wrong
      "current" entries lock the corner gate too.
- [ ] During a lockout, changing the phone's date forward does not unlock the gate.
- [ ] `adb shell bmgr backupnow com.evenseal.usagedeck` reports the package is not allowed to back up.

## Pairing

- [ ] *Pairing → Scan QR* reads the QR from `claude-usage pair`, shows a progress bar while it
      redeems, and the machine appears, its data arriving over HTTPS.
- [ ] Scanning the same `claude-usage pair` QR a second time reports the daemon's "run
      `claude-usage pair` again" and leaves the machine paired.
- [ ] After upgrading a deck that had a machine paired the old way (`claude-usage configure
      pairing`), that machine shows the amber "<name> needs to be paired again" card and nothing is
      sent to it; **Re-pair** → scan `claude-usage pair` restores it in the same row, keeping any
      pending escalation and showing the daemon's current name.
- [ ] Scanning an old `claude-usage configure pairing` QR is refused with "run `claude-usage pair`".
- [ ] From *Pairing* (not a Re-pair card), scanning a QR for an address that is already paired under
      another certificate asks "Replace <old> with <new>?" before anything changes.
- [ ] Rotating a paired Mac's token (`claude-usage configure rotate-token`) shows the amber "<name>
      no longer accepts this deck" card within about 30 s, the Mac's sessions disappear and its
      pause buttons are disabled; **Re-pair** → scan `claude-usage pair` restores it in the same row.
- [ ] Re-pair from that card but scan a *different* Mac's QR: the deck asks "Replace <old> with
      <new>?"; Keep both adds the new Mac and leaves the lost card in place.
- [ ] A machine that is merely asleep stays paired and is shown unreachable.
- [ ] Unpair asks for confirmation and removes the token.

## Live data

- [ ] Each person shows as one folded line with 5 h and 7 d percentages; tapping it unfolds the
      bars with reset captions, and tapping again folds it.
- [ ] Long-pressing a person's row opens the rename dialog; the new name shows on the Ledger and
      the wide-dock rail, and survives a relaunch. *Use daemon name* clears it.
- [ ] Two machines logged into the same account and organisation show as one person; the same
      account in two organisations shows as two.
- [ ] The status bar stays one line tall with two machine chips and shows the clock.
- [ ] A teammate whose Mac is closed fades to 55 % within two minutes and their machine dot goes
      red.
- [ ] Rotating the phone switches Ledger ↔ Wide dock with no data loss.
- [ ] Session rows show tokens/min and a moving 30-minute sparkline.

## Pause

- [ ] Tap a live session's pause → the session soft-pauses on the Mac and the countdown starts.
- [ ] Tap it again → it resumes, and `claude-usage` on the Mac agrees.
- [ ] Let the countdown run out → the session hard-freezes and the row reads **frozen**. The
      daemon's rules list holds one rule (hard), not a soft and a hard one.
- [ ] On the Mac, the `claude` process itself stays `S` (`ps -o stat= -p <pid>`); only its tool
      subprocesses (`pause.frozenPids` in `/v1/sessions`) show `T`. The terminal never says
      "suspended".
- [ ] Resume from the *project* row → the session rule under it is lifted too, and the session
      carries on rather than dying.
- [ ] Kill a frozen session and `claude --resume` it while the rule stands → it is frozen again on
      arrival and the row reads **frozen again ×2**.
- [ ] Hold *Pause all* → every reachable machine freezes; a dead machine is skipped, not retried
      forever.
- [ ] With *Pause all* standing → the button reads **Resume all**, session and project buttons show
      ↳ (disabled), and tapping *Resume all* lifts everything. Same with the event stream down.
- [ ] A session discovered from its transcript (no trusted pid) refuses a hard pause with a clear
      message.

## Alerts

- [ ] Crossing the warn threshold buzzes once and shows the chip; crossing critical buzzes five
      times.
- [ ] In the dock, an alert takes the full screen for 8 s; on battery it arrives as a heads-up
      notification.
- [ ] Inside quiet hours the visual still appears and the phone stays silent.

## Update

- [ ] *Settings → Check for update now* reports the installed version against the newest `deck-`
      pre-release in the shared repo, ignoring the daemon's `v` releases.
- [ ] Publishing a newer release causes the deck to download, verify and install it with **no
      prompt** (Device Owner), and the version footer changes afterwards.
- [ ] An update that arrives while a hold is in progress or an escalation is armed is deferred,
      and installs once the deck goes quiet.
- [ ] A release whose `usage-deck.apk.sha256` does not match is refused and the APK is deleted.
