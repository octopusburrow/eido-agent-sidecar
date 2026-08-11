#!/usr/bin/env bash
# voice-stack — bring up the topology-B voice pipeline in the ONE order that
# works. Written after the 2026-08-10 trim restored it by 25min of archaeology.
#
#   world server → door (auto-heals) → synthd → PRIMARY leg → aux media peer
#
# Order matters twice: the aux leg is reaped/held without a living primary,
# and the primary (connector, world-ws mode) needs BOTH tokens:
#   join token   = workbench-2026            (world door key)
#   agent token  = hesperus-workbench-local  (tokens.json KEY — reserved name)
# The MCPL policy must then be granted via the REQUEST form (§5.3 — the
# harness UI button sends the Notification form, which never establishes
# readiness).
set -u
S=/mnt/c/Users/Claude/code/eido-agent-sidecar

echo "── 1. world server + door (tmux: eido) ──"
bash /mnt/c/Users/Claude/code/scripts/eido-dev.sh up | head -2
# if the server window died inside a live tmux session, eido-dev.sh up says
# "already up" and lies — respawn by hand:
curl -sf -o /dev/null http://localhost:8940/ || tmux new-window -t eido -n server \
  "cd /home/claude/eido-dev/worlds-native && EIDOVERSE_DIR=/home/claude/eido-dev/eidoverse-video WORLDS_DIR=/home/claude/eido-dev/worlds-data JOIN_TOKEN=workbench-2026 PORT=8940 bun --watch server/server.ts 2>&1 | tee /tmp/eido-dev.log"
sleep 3; curl -sf -o /dev/null http://localhost:8940/ && echo "  8940 ✓"

echo "── 2. synthd (warm piper) ──"
timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/8927" 2>/dev/null && echo "  8927 ✓ (already)" || {
  (cd $S && setsid bun tools/synthd.ts > /tmp/synthd.log 2>&1 &); sleep 5
  timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/8927" && echo "  8927 ✓"
}

echo "── 3. PRIMARY leg: harness :7334 (world-ws say mode) ──"
pkill -f "eido-voice-mcp[l]" 2>/dev/null; sleep 1
cd /tmp/mcpl-harness && (setsid env EIDO_WORLD=workbench EIDO_SAY_VIA=world-ws \
  EIDO_AGENT_TOKEN=hesperus-workbench-local \
  nohup npm run web -- --port 7334 -- bun $S/mcpl/eido-voice-mcpl.ts --stdio \
  > /tmp/harness-web-7334.log 2>&1 &)
sleep 12
curl -sm 15 -X POST http://127.0.0.1:7334/api/command -H 'content-type: application/json' \
  -d '{"op":"raw","method":"featureSets/update","params":{"effectiveCapabilities":["channels.register","channels.publish","channels.streaming","inferenceRequest"]}}' \
  | grep -q '"accepted":true' && echo "  policy ✓"

echo "── 4. aux media peer (needs the primary above alive FIRST) ──"
pkill -f "media-pee[r].ts" 2>/dev/null; sleep 1
(cd $S && setsid bun tools/media-peer.ts >> /tmp/media-peer.log 2>&1 &)
sleep 6

echo "── receipt ──"
curl -sm 30 -X POST http://127.0.0.1:7334/api/command -H 'content-type: application/json' \
  -d '{"op":"publish","channelId":"eidoverse:workbench:voice","text":"Voice stack up."}' | head -c 60; echo
sleep 4; grep -E "performing" /tmp/media-peer.log | tail -1 | sed 's/^/  /'
echo "listener page: cloudflared tunnel → ?world=workbench (check: pgrep -af cloudflared)"
