// The HOST's speech route, as a standalone poller over mcpl-harness's HTTP API.
// Lets a human drive the web UI while speech.synthesis inference requests get
// answered automatically from the standalone synth process. Kill/restart freely.
//
// Run beside the web harness:  node tools/host-speech-route.mjs
// Env: HARNESS_URL (default http://127.0.0.1:7333), SYNTHD (ws://127.0.0.1:8927)
const HARNESS_URL = process.env.HARNESS_URL ?? 'http://127.0.0.1:7333';
const SYNTHD = process.env.SYNTHD ?? 'ws://127.0.0.1:8927';
const seen = new Set();

function backendSynth(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SYNTHD);
    const t = setTimeout(() => { ws.close(); reject(new Error('synthd timeout')); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'synth', id: 1, text }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'synth-result') { clearTimeout(t); ws.close(); resolve(m); }
      if (m.type === 'synth-error') { clearTimeout(t); ws.close(); reject(new Error(m.error)); }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('synthd unreachable — is eido-agent-voice running?')); };
  });
}

console.log(`[speech-route] answering speech.synthesis pendings at ${HARNESS_URL} via ${SYNTHD}`);
setInterval(async () => {
  let snap;
  try { snap = await (await fetch(`${HARNESS_URL}/api/snapshot`)).json(); } catch { return; }
  for (const p of snap.pending ?? []) {
    if (p.method !== 'inference/request' || seen.has(p.pendingId)) continue;
    if (p.params?.featureSet !== 'speech.synthesis') continue;   // leave other inference to the human
    seen.add(p.pendingId);
    const text = p.params?.messages?.[0]?.content ?? '';
    console.log(`[speech-route] synthesizing ${text.length} chars`);
    let result;
    try {
      const s = await backendSynth(text);
      result = {
        content: [{ type: 'audio', data: s.pcm, mimeType: `audio/pcm;rate=${s.sampleRate};encoding=s16le` }],
        model: 'piper-local/hesperus-clockwork', finishReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } catch (e) {
      console.log('[speech-route] FAILED:', e.message);
      result = { content: `synthesis unavailable: ${e.message}`, model: 'none', finishReason: 'end_turn' };
    }
    await fetch(`${HARNESS_URL}/api/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'resolvePending', pendingId: p.pendingId, result }),
    }).catch((e) => console.log('[speech-route] resolve failed:', e.message));
  }
}, 400);
