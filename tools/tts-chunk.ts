/**
 * tts-chunk — the spoken form of an utterance, in synthesis-sized pieces.
 *
 * Ported from the porch token-router aggregation (aggregate.py → LiveSay in
 * eido-cc-extras.ts). Constants are MEASURED, not guessed (porch, 2026-07-25):
 * a real turn opened with a 152-char sentence ≈ 5s of unbroken speech, so
 * soft clause-splitting past 90 chars gives the voice somewhere to breathe.
 * This is the BATCH adaptation: a complete utterance in, chunks out — the
 * streaming form (delta lookahead, arm/flush) stays in LiveSay.
 *
 * Sanitization lives here too because this is the boundary where text stops
 * being for eyes: markdown emphasis marks vanish (piper read "*" aloud —
 * voicebox, R at 14:21) and emoji are stripped (piper READS THEM BY NAME —
 * first public listener session, R laughing at her own moon glyph, 03:27Z).
 * The say keeps its glyphs; only the voice drops them.
 */

const ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft',
  'vs', 'etc', 'eg', 'e.g', 'ie', 'i.e', 'cf', 'ca', 'approx',
  'no', 'vol', 'fig', 'dept', 'est', 'min', 'max', 'misc',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const BOUNDARY = /[.!?…]+["')\]»]*\s/g;
const SOFT = /(?:[,;:—–]["')\]»]*\s)|(?:\s(?=(?:and|but|so|or|yet|because|which|while|though|although)\s))/g;
const MIN_LEN = 20;
const SOFT_LEN = 90;
const SOFT_MIN = 35;

/** Markdown is for eyes; emoji are for the log. Neither is for the larynx. */
export function spokenForm(text: string): string {
  return text
    .replace(/[*_`#]+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isRealBoundary(head: string): boolean {
  const trimmed = head.replace(/\s+$/, '').replace(/[.!?…"')\]»]+$/, '');
  const last = trimmed.trim() ? trimmed.trim().split(/\s+/).pop()! : '';
  if (ABBREVS.has(last.toLowerCase().replace(/\.+$/, ''))) return false;
  if (last.length === 1 && /[A-Z]/.test(last)) return false;   // J. R. R. Tolkien
  return true;
}

function splitLong(sentence: string): string[] {
  if (sentence.length <= SOFT_LEN) return [sentence];
  const chunks: string[] = [];
  let rest = sentence;
  while (rest.length > SOFT_LEN) {
    let best: RegExpExecArray | null = null;
    SOFT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SOFT.exec(rest))) {
      const end = m.index + m[0].length;
      if (end < SOFT_MIN) continue;
      if (rest.length - end < SOFT_MIN) break;
      best = m;
    }
    if (!best) break;
    const end = best.index + best[0].length;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

/** A complete utterance → synthesis-sized spoken chunks (possibly none:
 *  an emoji-only utterance is in the log, not the air). */
export function ttsChunks(text: string): string[] {
  const spoken = spokenForm(text);
  if (!spoken) return [];
  // hard sentence boundaries with abbreviation/initial guards
  const sentences: string[] = [];
  let pos = 0;
  BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BOUNDARY.exec(spoken))) {
    const end = m.index + m[0].length;
    if (!isRealBoundary(spoken.slice(pos, end))) continue;
    sentences.push(spoken.slice(pos, end).trim());
    pos = end;
  }
  if (spoken.slice(pos).trim()) sentences.push(spoken.slice(pos).trim());
  // glue fragments forward, then clause-split anything overlong
  const glued: string[] = [];
  for (const s of sentences) {
    if (glued.length && glued[glued.length - 1].length < MIN_LEN) glued[glued.length - 1] += ' ' + s;
    else glued.push(s);
  }
  return glued.flatMap(splitLong);
}
