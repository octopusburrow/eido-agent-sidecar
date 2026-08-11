#!/usr/bin/env bun
/**
 * media-peer — topology B: the agent's voice WITHOUT a browser.
 *
 * A sidecar-owned WebRTC peer (werift, pure TS — no Chromium anywhere) that
 * joins an eidoverse world as an AUX LEG of the agent's identity
 * (surface:"voice", the #57 surface-sessions model): no avatar, no arrival,
 * log-mute, RTC-capable, reaped when the primary leaves. The agent's PRIMARY
 * (its ordinary MCPL door) stays the one embodied author; this leg only
 * renders that identity's says as sound into the human voice mesh.
 *
 * Trigger: the leg watches its own world ws for `say` broadcasts from its own
 * id — voice-leg-speaks-what-the-body-says. No CDP, no page, no second author.
 *
 * Signaling: the world's own rtc verbs, sender role per client/lib/voice.js —
 * sendonly offers to embodied humans, answer/ice handling, the #34 recvReady
 * wake. Never initiates inbound (the leg has no ears; hearing is the door's
 * job on the text tier, or a future recv leg's).
 *
 * Audio: speechbridge synth (warm piper, tools/eido-synthd.ts, :8927) →
 * s16le PCM → ffmpeg (opus/48k RTP to loopback UDP) → track.writeRtp per
 * peer. Samples never touch JSON-RPC (Mica's line).
 *
 * Run: bun tools/media-peer.ts [--world workbench] [--id hesperus]
 *      [--url ws://127.0.0.1:8940/ws] [--synth ws://127.0.0.1:8927]
 */
import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket } from 'werift';
import { spawn, type Subprocess } from 'bun';
import { createSocket } from 'node:dgram';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WORLD = arg('world', 'workbench');
const ID = arg('id', 'hesperus');
const URL_ = arg('url', 'ws://127.0.0.1:8940/ws');
const SYNTH = arg('synth', 'ws://127.0.0.1:8927');
const RTP_PORT = Number(arg('rtp-port', '5004'));
// Agent names are reserved (server closes the spoofing hole): the join must
// carry the agent's own bearer. Sourced from env or the lab's tokens.json.
const TOKENS_PATH = arg('tokens', '/home/claude/eido-dev/worlds-native/mcpl/tokens.json');
function agentToken(): string {
  if (process.env.EIDO_AGENT_TOKEN) return process.env.EIDO_AGENT_TOKEN;
  try {
    const map = JSON.parse(require('node:fs').readFileSync(TOKENS_PATH, 'utf8')) as Record<string, { id?: string }>;
    for (const [k, v] of Object.entries(map)) if (v.id === ID) return k;
  } catch { /* fall through */ }
  return '';
}
const log = (...a: unknown[]) => console.log(`[media-peer ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ── peers: sender role, one pc per remote id ────────────────────────────────
type Peer = { pc: RTCPeerConnection; track: MediaStreamTrack; pendingIce: unknown[]; offering: boolean };
const peers = new Map<string, Peer>();
let world: WebSocket;

function newPeer(remoteId: string): Peer {
  const track = new MediaStreamTrack({ kind: 'audio' });
  const pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })] },
  });
  pc.addTransceiver(track, { direction: 'sendonly' });
  pc.onIceCandidate.subscribe((c) => { if (c) sendRtc(remoteId, { ice: c.toJSON() }); });
  pc.iceConnectionStateChange.subscribe((s) => log(`ice[${remoteId}] = ${s}`));
  const p: Peer = { pc, track, pendingIce: [], offering: false };
  peers.set(remoteId, p);
  return p;
}

function sendRtc(to: string, payload: unknown): void {
  world.send(JSON.stringify({ type: 'rtc', to, payload }));
}

async function offerTo(remoteId: string): Promise<void> {
  const p = peers.get(remoteId) ?? newPeer(remoteId);
  if (p.offering) return;
  p.offering = true;
  try {
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    sendRtc(remoteId, { sdp: p.pc.localDescription });
    log(`offered → ${remoteId} (sendonly)`);
  } finally { p.offering = false; }
}

function dropPeer(remoteId: string): void {
  const p = peers.get(remoteId);
  if (!p) return;
  peers.delete(remoteId);
  p.pc.close().catch(() => {});
  log(`dropped ${remoteId}`);
}

async function onRtc(from: string, payload: Record<string, unknown>): Promise<void> {
  // recvReady wake (#34): a listener turned consent on — reach them.
  if (payload.recvReady) {
    const p = peers.get(from);
    if (p?.offering) return;
    if (p && p.pc.signalingState !== 'stable') dropPeer(from);
    if (!peers.has(from)) await offerTo(from);
    return;
  }
  const sdp = payload.sdp as { type?: string } | undefined;
  if (sdp?.type === 'answer') {
    const p = peers.get(from);
    if (!p) return;
    await p.pc.setRemoteDescription(sdp as never).catch((e) => log(`answer[${from}] failed:`, e.message));
    for (const c of p.pendingIce) await p.pc.addIceCandidate(c as never).catch(() => {});
    p.pendingIce = [];
    log(`answer ← ${from}`);
  } else if (sdp?.type === 'offer') {
    // The leg has no ears — inbound negotiation is not ours to answer. The
    // human's client heals via the roster (their offer targets the identity;
    // the DOOR is the text-tier listener). Logged so nobody debugs silence.
    log(`inbound offer from ${from} ignored (voice leg is send-only)`);
  } else if (payload.ice) {
    const p = peers.get(from);
    if (!p) return; // ICE never creates a peer (contamination rule)
    if (p.pc.remoteDescription) await p.pc.addIceCandidate(payload.ice as never).catch(() => {});
    else p.pendingIce.push(payload.ice);
  }
}

// ── audio: synthd → ffmpeg → RTP/UDP → every peer's track ───────────────────
const udp = createSocket('udp4');
// A dgram 'error' event with no listener KILLS the process — and loopback RTP
// reliably produces one (ICMP port-unreachable ricochet when ffmpeg's RTCP
// aims at an unbound port). Log and carry on; the socket survives.
udp.on('error', (e) => log('udp error (survived):', e.message));
udp.on('message', (buf) => {
  const rtp = RtpPacket.deSerialize(buf);
  for (const p of peers.values()) p.track.writeRtp(rtp);
});
udp.bind(RTP_PORT, '127.0.0.1');

let speaking: Promise<void> = Promise.resolve();
function speak(text: string): void {
  speaking = speaking.then(() => speakNow(text)).catch((e) => log('speak failed:', e.message));
}

async function speakNow(text: string): Promise<void> {
  const pcm = await synth(text);
  if (!pcm) return;
  const ff = spawn({
    cmd: ['ffmpeg', '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(pcm.rate), '-ac', '1', '-i', 'pipe:0',
      '-af', 'aresample=48000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip',
      '-f', 'rtp', `rtp://127.0.0.1:${RTP_PORT}`],
    stdin: 'pipe', stdout: 'ignore', stderr: 'inherit',
  }) as Subprocess<'pipe'>;
  ff.stdin.write(pcm.data);
  ff.stdin.end();
  await ff.exited;
  log(`spoke ${pcm.data.length} bytes pcm → mesh (${peers.size} peer(s))`);
}

function synth(text: string): Promise<{ data: Uint8Array; rate: number } | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(SYNTH);
    const id = Math.random().toString(36).slice(2);
    const to = setTimeout(() => { ws.close(); resolve(null); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'synth', id, text }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type !== 'synth-result' || m.id !== id) return;
      clearTimeout(to); ws.close();
      if (m.error || !m.pcm) { log('synth error:', m.error ?? 'no pcm'); resolve(null); return; }
      resolve({ data: Buffer.from(m.pcm, 'base64'), rate: m.sampleRate ?? 22050 });
    };
    ws.onerror = () => { clearTimeout(to); resolve(null); };
  });
}

// ── the world ws: aux-leg join + say watch + presence-driven offers ─────────
world = new WebSocket(URL_);
world.onopen = () => {
  world.send(JSON.stringify({ type: 'join', world: WORLD, id: ID, surface: 'voice', agent: true, agentToken: agentToken() }));
  log(`joined ${WORLD} as ${ID}/voice (aux leg)`);
};
world.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
  const t = msg.type;
  if (t === 'error') { log('WORLD ERROR:', msg.error); return; }
  if (t === 'rtc' && msg.to === ID) { void onRtc(String(msg.from), msg.payload as Record<string, unknown>); return; }
  // Says arrive as authoritative log echoes: {type:"log", entry:{actor, verb, args}}.
  if (t === 'log') {
    const e = msg.entry as { actor?: string; verb?: string; args?: { text?: string } } | undefined;
    if (e?.verb === 'say' && e.actor === ID && e.args?.text) {
      log(`primary said: "${e.args.text.slice(0, 60)}"`);
      speak(e.args.text);
    }
    return;
  }
  // Presence reveals who is here: arrivals announce, poses stream. Offer to
  // anyone embodied that isn't us.
  if ((t === 'arrive' || t === 'pose') && typeof msg.id === 'string' && msg.id !== ID && !peers.has(msg.id)) {
    log(`presence: ${msg.id} — offering`);
    void offerTo(msg.id);
  }
  if (t === 'leave' && typeof msg.id === 'string') dropPeer(msg.id);
};
world.onclose = (ev) => { log(`world ws closed (${ev.code} ${ev.reason}) — exiting`); process.exit(ev.code === 4008 ? 2 : 0); };
process.on('SIGINT', () => { for (const id of [...peers.keys()]) dropPeer(id); process.exit(0); });
log(`media peer starting: world=${WORLD} id=${ID} rtp=:${RTP_PORT} synth=${SYNTH}`);
