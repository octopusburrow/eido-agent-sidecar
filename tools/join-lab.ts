/** join-lab: render the same utterance through the OLD path (raw butt-splice,
 *  serial gaps simulated) and the NEW path (trim+fade+breath), write both as
 *  WAVs, and print discontinuity metrics. Capture, not ears. */
import { ttsChunks } from './tts-chunk.ts';
import { trimEdges, fade, silencePcm, sentenceFinal, i16, BREATH_MS } from './pcm-craft.ts';

const SYNTH = 'ws://127.0.0.1:8927';
const RATE = 22050;
const text = process.argv[2] ?? "Mystery solved, and it's worse than prosody. I'm sorry — you got an earful of my homework, and web text should never reach this room uncurated.";

function synth(t: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(SYNTH);
    const id = Math.random().toString(36).slice(2);
    const to = setTimeout(() => { ws.close(); resolve(null); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'synth', id, text: t }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type !== 'synth-result' || m.id !== id) return;
      clearTimeout(to); ws.close();
      resolve(m.pcm ? new Uint8Array(Buffer.from(m.pcm, 'base64')) : null);
    };
    ws.onerror = () => { clearTimeout(to); resolve(null); };
  });
}

function wav(path: string, pcm: Uint8Array): void {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  require('fs').writeFileSync(path, Buffer.concat([h, Buffer.from(pcm)]));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** max sample-to-sample jump at each join index (clicks live here) */
function joinJumps(parts: Uint8Array[]): number[] {
  const jumps: number[] = [];
  for (let k = 1; k < parts.length; k++) {
    const a = i16(parts[k - 1]), b = i16(parts[k]);
    if (!a.length || !b.length) continue;
    jumps.push(Math.abs(b[0] - a[a.length - 1]));
  }
  return jumps;
}

const chunks = ttsChunks(text);
console.log(`chunks: ${chunks.length} — ${chunks.map(c => c.length).join('+')}`);
const raws: Uint8Array[] = [];
for (const c of chunks) {
  const p = await synth(c);
  if (!p) { console.log('synth failed for a chunk — is synthd up on :8927?'); process.exit(1); }
  raws.push(p);
}

// OLD path: raw butt-splice, plus the serial-synth hole (~400ms silence) at joins
const GAP = silencePcm(400, RATE);
const oldParts: Uint8Array[] = [];
raws.forEach((r, idx) => { oldParts.push(r); if (idx < raws.length - 1) oldParts.push(GAP); });
wav('/tmp/join-before.wav', concat(oldParts));
console.log(`before: raw join jumps = [${joinJumps(raws).join(', ')}] (s16 units; >~500 clicks)`);

// NEW path: trim + fade + breath only at sentence-finals
const newParts: Uint8Array[] = [];
raws.forEach((r, idx) => {
  const t = trimEdges(r, RATE); fade(t, RATE);
  newParts.push(t);
  if (idx < raws.length - 1 && sentenceFinal(chunks[idx])) newParts.push(silencePcm(BREATH_MS, RATE));
});
wav('/tmp/join-after.wav', concat(newParts));
const treated = newParts.filter((_, i) => true);
console.log(`after: treated join jumps = [${joinJumps(newParts).join(', ')}]`);
const durB = concat(oldParts).length / 2 / RATE, durA = concat(newParts).length / 2 / RATE;
console.log(`duration: before ${durB.toFixed(2)}s → after ${durA.toFixed(2)}s (holes → breaths)`);
console.log('wavs: /tmp/join-before.wav /tmp/join-after.wav');
