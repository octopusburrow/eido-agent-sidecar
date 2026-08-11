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
import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, MediaStream, RtpPacket } from 'werift';
import { spawn, type Subprocess } from 'bun';
import { createSocket } from 'node:dgram';
import { ttsChunks } from './tts-chunk.js';

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

// ICMP port-unreachable ricochets surface as ECONNREFUSED on UDP sockets we
// don't own (werift's ICE sockets — a peer restart leaves the remote firing
// at a candidate that no longer answers). One unlistened socket kills the
// process; the class is survivable by definition — log and keep talking.
process.on('uncaughtException', (e) => {
  if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') { log('udp ricochet (survived):', e.message); return; }
  log('FATAL:', e); process.exit(1);
});

// ── peers: sender role, one pc per remote id ────────────────────────────────
type Peer = { pc: RTCPeerConnection; track: MediaStreamTrack; pendingIce: unknown[]; offering: boolean };
const peers = new Map<string, Peer>();
let world: WebSocket;

function newPeer(remoteId: string): Peer {
  const track = new MediaStreamTrack({ kind: 'audio' });
  const pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })] },
    // Same STUN the browser client uses (voice.js RTC_CFG): loopback proved
    // the protocol; srflx candidates are what make it real across NAT.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  // The track must ride in a STREAM (msid in the SDP): the browser client
  // does `audio.srcObject = e.streams[0]` — a bare track means e.streams is
  // EMPTY on Chrome and the audio element gets no source: perfect ICE,
  // flowing packets, total silence. (First human listener, 2026-08-10.)
  const stream = new MediaStream([track]);
  const trx = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
  void trx;
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
    // ANSWER renegotiations — never ignore them. A listener's consent toggle
    // sends an offer at us; ignoring it wedged their pc in have-local-offer
    // and silenced the very stream we were proudly transmitting (03:35Z).
    // The leg still has no ears: our transceiver stays sendonly, so their
    // mic m-line answers inactive and no inbound path opens.
    const p = peers.get(from) ?? newPeer(from);
    try {
      await p.pc.setRemoteDescription(sdp as never);
      for (const c of p.pendingIce) await p.pc.addIceCandidate(c as never).catch(() => {});
      p.pendingIce = [];
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sendRtc(from, { sdp: p.pc.localDescription });
      log(`answered renegotiation ← ${from}`);
    } catch (e) { log(`renegotiation with ${from} failed:`, (e as Error).message); dropPeer(from); }
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
// PACE AT THIS LAYER. ffmpeg's -re demonstrably does not: the probe-ear
// histogram read 222-342 pkts/s against opus's 50/s — the whole utterance
// flooded out 5x realtime and every listener's jitter buffer "tumbled",
// playing fragments as it overflowed (Rabscuttle's ear, then the histogram,
// 03:44Z). One opus frame is 20ms; release exactly one per 20ms tick.
// ...and the metronome must not drift: a plain 20ms interval fires ~21-25ms
// in practice, feeding slightly SLOWER than realtime — the receiver's NetEQ
// then time-stretches to cover the starvation ("words stretch and hang",
// 03:46Z). Schedule each packet on the absolute clock from its own RTP
// timestamp: tick fast, release everything due, rebase after silence.
const rtpQueue: RtpPacket[] = [];
let baseWall = 0, baseTs = 0;
udp.on('message', (buf) => { rtpQueue.push(RtpPacket.deSerialize(buf)); });
setInterval(() => {
  while (rtpQueue.length) {
    const rtp = rtpQueue[0];
    const ts = rtp.header.timestamp >>> 0;
    if (!baseWall || Date.now() - (baseWall + (ts - baseTs) / 48) > 2000) {
      // first packet ever, or a packet 2s+ late per the old base — that is a
      // fresh utterance after silence, not a late packet: rebase, don't rush.
      baseWall = Date.now(); baseTs = ts;
    }
    const due = baseWall + (ts - baseTs) / 48;   // 48kHz: samples → ms
    if (Date.now() < due) return;
    rtpQueue.shift();
    for (const p of peers.values()) p.track.writeRtp(rtp);
  }
}, 5);
udp.bind(RTP_PORT, '127.0.0.1');

let speaking: Promise<void> = Promise.resolve();
function speak(text: string): void {
  // Chunked: sentence 1 is in the air while sentence 2 synthesizes —
  // time-to-first-word stays ~synth(one sentence) regardless of length.
  const chunks = ttsChunks(text);
  if (!chunks.length) { log('utterance has no spoken form (emoji/markdown only)'); return; }
  log(`chunked into ${chunks.length}: ${chunks.map((c) => c.length).join('+')} chars`);
  for (const c of chunks) speaking = speaking.then(() => speakNow(c)).catch((e) => log('speak failed:', (e as Error).message));
}

// ONE persistent encoder, real-time paced. A per-utterance ffmpeg blasted the
// whole clip into RTP as fast as it encoded — the listener's jitter buffer
// keeps ~2s and DROPS the rest ("very choppy", first human listener) — and
// every restart broke the RTP timeline. `-re` paces to wall clock; one
// process means one continuous timeline across every utterance.
let encoder: Subprocess<'pipe'> | null = null;
const PIPER_RATE = 22050;
function ensureEncoder(): Subprocess<'pipe'> {
  if (encoder && encoder.exitCode === null) return encoder;
  encoder = spawn({
    cmd: ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 's16le', '-ar', String(PIPER_RATE), '-ac', '1', '-i', 'pipe:0',
      '-af', 'aresample=48000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip',
      '-f', 'rtp', `rtp://127.0.0.1:${RTP_PORT}`],
    stdin: 'pipe', stdout: 'ignore', stderr: 'inherit',
  }) as Subprocess<'pipe'>;
  log('encoder up (persistent, -re paced)');
  return encoder;
}

async function speakNow(text: string): Promise<void> {
  const pcm = await synth(text);
  if (!pcm) return;
  if (pcm.rate !== PIPER_RATE) { log(`unexpected synth rate ${pcm.rate} — skipping`); return; }
  const ff = ensureEncoder();
  // AWAIT THE BACKPRESSURE. The encoder reads realtime (-re): the pipe holds
  // ~1.5s of PCM and a fire-and-forget write silently loses the rest — every
  // sentence started and died mid-breath ("kept cutting you off", 03:32Z).
  // Write in slices and honor the promise bun returns when the pipe is full.
  for (let off = 0; off < pcm.data.length; off += 16384) {
    const r = ff.stdin.write(pcm.data.subarray(off, off + 16384));
    if (r instanceof Promise) await r;
  }
  await ff.stdin.flush?.();
  log(`streamed ${pcm.data.length} bytes pcm → encoder (${peers.size} peer(s))`);
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
  world.send(JSON.stringify({ type: 'join', world: WORLD, id: ID, surface: 'voice', agent: true, agentToken: agentToken(), token: arg('join-token', 'workbench-2026') }));
  log(`join sent: ${WORLD} as ${ID}/voice (aux leg) — awaiting ack`);
};
world.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
  const t = msg.type;
  if (t === 'error') { log('WORLD ERROR:', msg.error); return; }
  // Residents don't re-arrive: on join, the snapshot lists who is already
  // here — offer to each. (The recvReady wake never reaches us: clients
  // announce consent to humanIds() only, so an agent's leg makes the first
  // move or no move happens. Second human listener session, 2026-08-10.)
  if (t === 'snapshot') {
    for (const person of (msg.people as Array<{ id: string }> | undefined) ?? []) {
      if (person.id !== ID && !peers.has(person.id)) { log(`resident: ${person.id} — offering`); void offerTo(person.id); }
    }
    return;
  }
  if (t === 'rtc' && msg.to === ID) { void onRtc(String(msg.from), msg.payload as Record<string, unknown>); return; }
  // Says arrive as authoritative log echoes: {type:"log", entry:{actor, verb, args}}.
  if (t === 'log') {
    const e = msg.entry as { actor?: string; verb?: string; args?: { text?: string; spoken?: boolean } } | undefined;
    if (e?.verb === 'say' && e.actor === ID && e.args?.text) {
      // Perform ONLY says marked spoken:true — the ones our own stack authored
      // for this leg. Unmarked says (the door talking on the text tier) belong
      // to each listener's client-side TTS; performing them here made two
      // voices speak every utterance.
      if (e.args.spoken === true) { log(`performing: "${e.args.text.slice(0, 60)}"`); speak(e.args.text); }
      else log(`text-tier say (not ours to perform): "${e.args.text.slice(0, 40)}"`);
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
