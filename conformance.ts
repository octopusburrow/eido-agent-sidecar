/** speechbridge v1 conformance — run against ANY sidecar.
 *
 *    bun conformance.ts [ws://127.0.0.1:8927]
 *
 *  Passing this is what "speaks speechbridge" MEANS. It checks the behaviors a
 *  body actually depends on, including the failure ones — a sidecar that fails
 *  by silence instead of by explicit error is nonconformant, because silence
 *  is indistinguishable from a working voice nobody heard (we spent an evening
 *  in that exact dark).
 */

const url = process.argv[2] ?? "ws://127.0.0.1:8927";
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${!ok && detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const ws = new WebSocket(url);
const replies: Record<string, unknown[]> = {};
const waiters: Map<unknown, (m: Record<string, unknown>) => void> = new Map();
ws.onmessage = (ev) => {
  let m: Record<string, unknown>;
  try { m = JSON.parse(String(ev.data)); } catch { return; }
  (replies[String(m.type)] ??= []).push(m);
  const w = waiters.get(m.id);
  if (w) { waiters.delete(m.id); w(m); }
};
const synth = (id: string, text: string, ms = 90000) =>
  new Promise<Record<string, unknown>>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no synth-result for ${id} in ${ms}ms`)), ms);
    waiters.set(id, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ type: "synth", id, text }));
  });

await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error(`cannot connect to ${url} — is the sidecar running?`));
});
console.log(`speechbridge v1 conformance against ${url}\n`);

// 1. hello is accepted without a reply (fire-and-forget)
ws.send(JSON.stringify({ type: "hello", name: "conformance", world: "none" }));

// 2. a synth produces a synth-result carrying the SAME id
const r1 = await synth("c1", "Conformance says hello.");
check("synth-result echoes the request id", r1.id === "c1");
check("result carries sampleRate", typeof r1.sampleRate === "number" && (r1.sampleRate as number) >= 8000,
      `sampleRate=${r1.sampleRate}`);
check("result carries base64 pcm", typeof r1.pcm === "string" && (r1.pcm as string).length > 0);

// 3. the pcm is REAL audio: 16-bit samples, plausible length, not silence
{
  const bytes = Uint8Array.from(atob(String(r1.pcm)), (c) => c.charCodeAt(0));
  const s16 = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
  const secs = s16.length / (r1.sampleRate as number);
  let peak = 0; for (const v of s16) peak = Math.max(peak, Math.abs(v));
  check("pcm decodes to whole 16-bit samples", bytes.byteLength % 2 === 0);
  check("duration is plausible for a short sentence", secs > 0.3 && secs < 30, `${secs.toFixed(2)}s`);
  check("audio is not silence", peak > 500, `peak=${peak}`);
}

// 4. concurrent ids do not cross wires
{
  const [a, b] = await Promise.all([synth("c2", "First utterance, quite short."),
                                    synth("c3", "Second utterance, which is deliberately quite a bit longer than the first one.")]);
  check("two in-flight synths keep their ids", a.id === "c2" && b.id === "c3");
  const la = String(a.pcm ?? "").length, lb = String(b.pcm ?? "").length;
  check("longer text yields more audio (wires not crossed)", lb > la, `${la} vs ${lb}`);
}

// 5. empty text fails EXPLICITLY (error or empty pcm) — never hangs
{
  const r = await synth("c4", "", 30000).catch((e) => ({ id: "c4", error: String(e) }));
  const explicit = "error" in r || String(r.pcm ?? "") === "";
  check("empty text yields explicit error or empty pcm, not a hang", explicit,
        JSON.stringify(r).slice(0, 80));
}

// 6. unknown message types are ignored, and the bridge still works after
ws.send(JSON.stringify({ type: "definitely-not-in-the-protocol", id: "x" }));
{
  const r = await synth("c5", "Still alive after an unknown message.");
  check("unknown message types are ignored (bridge survives)", r.id === "c5" && !!r.pcm);
}

ws.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
