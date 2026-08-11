#!/usr/bin/env bash
# Watchdog for media-peer (the voice aux leg). Exit-code contract:
#   0 → deliberate replacement (4002 takeover): STOP — our successor is live.
#   2 → transient (4007 primary gone, drops): relaunch with backoff; the
#       primary seat usually returns within seconds of a restart.
# Usage: tools/run-media-peer.sh [--world W] [--id I] (args pass through)
cd "$(dirname "$0")/.." || exit 1
BACKOFF=2
while true; do
  /home/claude/.bun/bin/bun tools/media-peer.ts "$@"
  CODE=$?
  if [ "$CODE" -eq 0 ]; then
    echo "[run-media-peer] deliberate exit (takeover) — not relaunching"
    exit 0
  fi
  echo "[run-media-peer] exit $CODE — relaunch in ${BACKOFF}s"
  sleep "$BACKOFF"
  BACKOFF=$(( BACKOFF < 60 ? BACKOFF * 2 : 60 ))
done
