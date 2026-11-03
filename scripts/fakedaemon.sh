#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
# Run the Ktor fake daemon so the deck has something to talk to without a real `claude-usage`.
#
#   scripts/fakedaemon.sh                # idle scenario
#   scripts/fakedaemon.sh warnCrossing   # walks weekly_all past warn and critical
#   scripts/fakedaemon.sh freeze         # hard-freezes the first session on step 3
#   scripts/fakedaemon.sh machineDrop    # stops the heartbeat so the machine ages to DEAD
#   scripts/fakedaemon.sh tokenRotated   # rejects the token from step 5: the deck shows Re-pair
#   scripts/fakedaemon.sh noFiveHour     # a plan with no 5-hour window: weeks only (daemon §23.68)
#
# It listens like the real daemon: plain HTTP on loopback only (PORT, default 47299) and pinned
# HTTPS on TLS_PORT (default PORT+1), which is what the deck uses. It prints a single-use pairing
# link and a token generated for this run; there is no fixed token.
#
# HTTPS binds 127.0.0.1 by default. That already serves the Android emulator, which reaches this
# machine's loopback as 10.0.2.2 (the link advertises it); pair it with scripts/pair-emulator.sh.
# A device on the network needs an explicit opt-in:
#
#   BIND=0.0.0.0 ADDRS=<this machine's address> scripts/fakedaemon.sh
#
# DEMO=1 swaps the sample person and home directory for made-up ones, for screenshots.
set -euo pipefail
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
SCENARIO=${1:-idle}
PORT=${PORT:-47299}
TLS_PORT=${TLS_PORT:-$((PORT + 1))}
BIND=${BIND:-127.0.0.1}
ADDRS=${ADDRS:-10.0.2.2,127.0.0.1}
# Where the current pairing link is kept (owner-only) for scripts/pair-emulator.sh to push.
LINK_FILE=${LINK_FILE:-$(pwd)/build/fakedaemon/pair-link}
mkdir -p "$(dirname "$LINK_FILE")"
exec ./gradlew -q --console=plain :fakedaemon:run \
  --args="--port $PORT --tls-port $TLS_PORT --bind $BIND --addrs $ADDRS --scenario $SCENARIO --link-file $LINK_FILE${DEMO:+ --demo}"
