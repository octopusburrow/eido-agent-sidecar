#!/usr/bin/env bun
/**
 * probe-ear — headless acceptance listener for the topology-B demo.
 *
 * Joins the world as an ordinary embodied participant ("testling-ear"),
 * answers the voice leg's sendonly offer recvonly, and MEASURES the inbound
 * track instead of playing it: RTP packet count, total payload bytes, and a
 * coarse energy envelope over the opus payload sizes (VBR opus emits bigger
 * packets for speech than for silence — envelope variance is the cheap check
 * that what arrived is speech-shaped, not a stuck beep, without a decoder).
 *
 * Exits 0 with a report once >= --min-packets arrive (default 50) or exits 1
 * on --timeout (default 60s).
 *
 * Run: bun tools/probe-ear.ts [--world workbench] [--url ws://127.0.0.1:8940/ws]
 */
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WORLD = arg('world', 'workbench');
const URL_ = arg('url', 'ws://127.0.0.1:8940/ws');
const ID = arg('id', 'testling-ear');
const MIN = Number(arg('min-packets', '50'));
const TIMEOUT = Number(arg('timeout', '60')) * 1000;
const log = (...a: unknown[]) => console.log(`[probe-ear ${new Date().toISOString().slice(11, 19)}]`, ...a);

let packets = 0, bytes = 0;
const sizes: number[] = [];
let pc: RTCPeerConnection | null = null;
const pendingIce: unknown[] = [];

const world = new WebSocket(URL_);
const send = (o: unknown) => world.send(JSON.stringify(o));

world.onopen = () => {
  send({ type: 'join', world: WORLD, id: ID, agent: true });
  log(`joined ${WORLD} as ${ID} (embodied listener)`);
  // announce consent so a live sender reaches us (#34 recvReady wake)
  setTimeout(() => send({ type: 'rtc', to: 'hesperus', payload: { recvReady: true } }), 1000);
};

world.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
  if (msg.type === 'error') { log('WORLD ERROR:', msg.error); return; }
  if (msg.type !== 'rtc' || msg.to !== ID) return;
  const from = String(msg.from);
  const payload = msg.payload as Record<string, unknown>;
  const sdp = payload.sdp as { type?: string } | undefined;
  if (sdp?.type === 'offer') {
    log(`offer ← ${from}; answering recvonly`);
    pc = new RTCPeerConnection({
      codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })] },
    });
    pc.onIceCandidate.subscribe((c) => { if (c) send({ type: 'rtc', to: from, payload: { ice: c.toJSON() } }); });
    pc.iceConnectionStateChange.subscribe((s) => log(`ice = ${s}`));
    pc.onTrack.subscribe((track) => {
      log(`track arrived: ${track.kind}`);
      track.onReceiveRtp.subscribe((rtp) => {
        packets++; bytes += rtp.payload.length; sizes.push(rtp.payload.length);
        if (packets === MIN) report(0);
      });
    });
    await pc.setRemoteDescription(sdp as never);
    for (const c of pendingIce) await pc.addIceCandidate(c as never).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'rtc', to: from, payload: { sdp: pc.localDescription } });
  } else if (payload.ice) {
    if (pc?.remoteDescription) await pc.addIceCandidate(payload.ice as never).catch(() => {});
    else pendingIce.push(payload.ice);
  }
};

function report(code: number): void {
  const mean = sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1);
  const varc = sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / (sizes.length || 1);
  const speechy = Math.sqrt(varc) / (mean || 1);
  console.log(JSON.stringify({
    packets, bytes, meanPayload: Math.round(mean),
    envelopeCv: Number(speechy.toFixed(3)),
    speechShaped: speechy > 0.05,   // a stuck tone is near-constant-size; speech varies
  }));
  process.exit(code);
}

setTimeout(() => { log(`timeout with ${packets} packets`); report(packets >= MIN ? 0 : 1); }, TIMEOUT);
