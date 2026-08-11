/** PCM join craft — shared by media-peer (live) and join-lab (capture tests).
 *  See media-peer.ts for the defect history; acceptance test: silences
 *  between phrases, never inside words. */
// ── origin: join craft (2026-08-11, R's ear: "cut right in the middle of words") ────
// Three defects made the seams audible, all fixed here:
//  1. serial synth: chunk N+1 synthesized only after N was written, so every
//     join waited 0.3–0.5s on piper — a hole the listener hears as a hang.
//     Now all chunks synthesize EAGERLY; the write chain just consumes results.
//  2. raw butt-splices: piper clips carry edge silence and abrupt onsets;
//     joined raw, the discontinuity lands as a glottal hiccup ON the next
//     word ("s-(uh)-orry"). Now: edge-trim + 10ms equal-power fades.
//  3. starve-vs-breath: between sentences the encoder just starved (RTP
//     timeline hiccup). Now a sentence-final chunk is followed by EXPLICIT
//     silence PCM — the pause has contour and the timeline never breaks.
// Acceptance test (Hillesum 1942, via R): silences between phrases, never
// inside words. "All that words should do is to lend the silence form."
export const EDGE_KEEP_MS = 12;
export const FADE_MS = 10;
export const BREATH_MS = 180;
const TRIM_THRESH = 300;             // |s16| below this ≈ silence (~-40 dBFS)

export function i16(data: Uint8Array): Int16Array {
  return new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
}
export function trimEdges(data: Uint8Array, rate: number): Uint8Array {
  const s = i16(data);
  let a = 0, b = s.length;
  while (a < b && Math.abs(s[a]) < TRIM_THRESH) a++;
  while (b > a && Math.abs(s[b - 1]) < TRIM_THRESH) b--;
  const keep = Math.round((EDGE_KEEP_MS / 1000) * rate);
  a = Math.max(0, a - keep); b = Math.min(s.length, b + keep);
  const out = s.slice(a, b);
  return new Uint8Array(out.buffer, 0, out.length * 2);
}
export function fade(data: Uint8Array, rate: number): void {
  const s = i16(data);
  const n = Math.min(s.length >> 1, Math.round((FADE_MS / 1000) * rate));
  for (let k = 0; k < n; k++) {
    const g = Math.sin((Math.PI / 2) * (k / n));       // equal-power quarter-sine
    s[k] = Math.round(s[k] * g);
    s[s.length - 1 - k] = Math.round(s[s.length - 1 - k] * g);
  }
}
export function silencePcm(ms: number, rate: number): Uint8Array {
  return new Uint8Array(Math.round((ms / 1000) * rate) * 2);
}
export const sentenceFinal = (text: string): boolean => /[.!?…]["')\]]?$/.test(text.trim());

