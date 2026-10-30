#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
# Pair the debug build on the emulator with a running scripts/fakedaemon.sh: pushes the fake's
# current single-use pairing link to the place a DEBUG build watches for one. A release build
# ignores that directory, so this cannot pair a provisioned phone.
#
# Pairs the kiosk's debug build; PACKAGE=com.evenseal.usagedeck.phone pairs the Play build's.
#
# Pinned to an emulator serial on purpose: a real phone is often attached over USB as well.
set -euo pipefail
export ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
SERIAL=${EMULATOR_SERIAL:-emulator-5554}
case "$SERIAL" in
  emulator-*) ;;
  *) echo "refusing to push a pairing to '$SERIAL': not an emulator" >&2; exit 2 ;;
esac
LINK_FILE=${LINK_FILE:-$(pwd)/build/fakedaemon/pair-link}
[ -s "$LINK_FILE" ] || { echo "no pairing link at $LINK_FILE — is scripts/fakedaemon.sh running?" >&2; exit 1; }
ADB="$ANDROID_HOME/platform-tools/adb"
DEST=/sdcard/Android/data/${PACKAGE:-com.evenseal.usagedeck}/files
"$ADB" -s "$SERIAL" shell mkdir -p "$DEST"
"$ADB" -s "$SERIAL" push "$LINK_FILE" "$DEST/pairing-import.json" >/dev/null
echo "pushed the pairing link to $SERIAL; the deck picks it up within a few seconds"
