#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
# Create (if needed) and start the API 29 arm64 emulator used for androidTests.
# Nexus 5X-like: 1080x1920 @ 420dpi.
#
# Every adb call is pinned to the emulator: a real Nexus 5X is usually attached over USB at the
# same time, and an unpinned `adb wait-for-device` or `getprop` will happily answer for the phone.
set -euo pipefail
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
export ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
AVD=deck29
SERIAL=${EMULATOR_SERIAL:-emulator-5554}
ADB="$ANDROID_HOME/platform-tools/adb"

if ! "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx "$AVD"; then
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
    -n "$AVD" -k "system-images;android-29;default;arm64-v8a" -d "Nexus 5X" --force
  cfg="$HOME/.android/avd/$AVD.avd/config.ini"
  {
    echo "hw.lcd.density=420"
    echo "hw.lcd.width=1080"
    echo "hw.lcd.height=1920"
    echo "hw.keyboard=yes"
  } >> "$cfg"
fi

if ! "$ADB" devices | grep -q "^$SERIAL"; then
  # -partition-size keeps the system image small enough to start on a nearly full disk; the
  # emulator otherwise demands ~7 GB free before it will boot at all.
  nohup "$ANDROID_HOME/emulator/emulator" -avd "$AVD" \
    -no-snapshot -no-boot-anim -no-audio -gpu swiftshader_indirect \
    -partition-size 2048 ${EMULATOR_ARGS:-} >/dev/null 2>&1 &
  "$ADB" -s "$SERIAL" wait-for-device
  until [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2
  done
fi

echo "emulator $AVD ready as $SERIAL"
echo "run tests with: ANDROID_SERIAL=$SERIAL ./gradlew :app:connectedDeckDebugAndroidTest"
