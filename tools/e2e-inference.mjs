// PROTOTYPE RECEIPT — speech synthesis as HOST-routed inference.
//
// Loop under test (no new protocol at any hop):
//   harness host  ──grant──▶  eido-voice-mcpl (connector)
//   host publish  ──────────▶  connector → body authors canonical say
//   page speaks its own say → pulls samples from connector (page's own
//   ?tts= dialect, port 8931)
//   connector ──inference/request {speech.synthesis}──▶ HOST (pending)
//   this script ANSWERS AS THE HOST: calls the standalone synth process
//   (speechbridge :8927, killable/restartable at will) and resolves with a
//   §10.3 audio content block — the one field this prototype proposes.
//
// Run: HARNESS=/path/to/mcpl-harness tsx tools/e2e-inference.mjs
import { readFileSync } from 'node:fs';
const HARNESS = process.env.HARNESS ?? '/tmp/mcpl-harness';  // WebSocket: Node 22 global
const { HostSession } = await import(`${HARNESS}/src/session.ts`);
const LOG = process.env.WORLD_LOG ?? '/home/claude/eido-ab/pure/worlds/voicetest/log.jsonl';
const SYNTHD = process.env.SYNTHD ?? 'ws://127.0.0.1:8927';
const MARKER = `host-routed voice ${Date.now().toString(36)}`;

// ── the host's speech route: proxy to the standalone synth process ──────────
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
    ws.onerror = () => { clearTimeout(t); reject(new Error('synthd unreachable')); };
  });
}

// ── CDP: point the body page's PLUGGABLE tts source at the connector ────────
async function repointPage(port) {
  const st = JSON.parse(readFileSync(`${process.env.HOME}/.eido-body.json`, 'utf8'));
  const tabs = await (await fetch(`http://127.0.0.1:${st.debug_port}/json`)).json();
  const tab = tabs.find((t) => t.url?.includes('world=') && t.webSocketDebuggerUrl);
  if (!tab) throw new Error('no body page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const expr = `(async () => {
    const vs = await import('./lib/voicesource.js');
    window.__mcplTts = { ok: 0, err: 0 };
    vs.setTtsSource(async (text) => {
      const sock = new WebSocket('ws://127.0.0.1:${port}');
      await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('connector down')); });
      const out = await new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('connector timeout')), 45000);
        sock.onmessage = (ev) => { const m = JSON.parse(ev.data);
          clearTimeout(t); sock.close();
          m.type === 'synth-result' ? r(m) : j(new Error(m.error ?? 'synth failed')); };
        sock.send(JSON.stringify({ type: 'synth', id: 1, text }));
      });
      const b = atob(out.pcm); const pcm = new Float32Array(b.length / 2);
      const dv = new DataView(new ArrayBuffer(b.length));
      for (let i = 0; i < b.length; i++) dv.setUint8(i, b.charCodeAt(i));
      for (let i = 0; i < pcm.length; i++) pcm[i] = dv.getInt16(i * 2, true) / 32768;
      window.__mcplTts.ok++;
      return { pcm, sampleRate: out.sampleRate };
    }, 'mcpl-host-routed');
    vs.setTtsEnabled(true);
    return 'repointed';
  })()`;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP timeout')), 8000);
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) { clearTimeout(t); res(); } };
  });
  return { ws, port: st.debug_port };
}

async function pageTtsCount(debugPort) {
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const tab = tabs.find((t) => t.url?.includes('world=') && t.webSocketDebuggerUrl);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(window.__mcplTts)', returnByValue: true } }));
  return new Promise((res) => { ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id === 2) { ws.close(); res(JSON.parse(m.result?.result?.value ?? '{}')); }
  }; });
}

// ── run ──────────────────────────────────────────────────────────────────────
const lines = () => readFileSync(LOG, 'utf8').trim().split('\n').length;
const before = lines();

const session = new HostSession({
  command: 'bun',
  args: [new URL('../mcpl/eido-voice-mcpl.ts', import.meta.url).pathname, '--stdio'],
  env: { ...process.env, EIDO_WORLD: 'voicetest', EIDO_MEDIA_PORT: process.env.E2E_MEDIA_PORT ?? '8931' },
  autoApprove: false,
});
session.on('event', (ev) => console.log('  ev:', ev.summary ?? ''));
await session.start();

// host route: answer speech.synthesis pendings with a §10.3 audio block
const answered = [];
const poll = setInterval(async () => {
  for (const p of session.snapshot().pending ?? []) {
    if (p.method !== 'inference/request' || answered.includes(p.pendingId)) continue;
    answered.push(p.pendingId);
    const text = p.params?.messages?.[0]?.content ?? '';
    console.log(`  host route: synthesizing ${text.length} chars via standalone backend`);
    try {
      const s = await backendSynth(text);
      session.resolvePending(p.pendingId, {
        content: [{ type: 'audio', data: s.pcm, mimeType: `audio/pcm;rate=${s.sampleRate};encoding=s16le` }],
        model: 'piper-local/hesperus-clockwork',
        finishReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    } catch (e) {
      console.log('  host route FAILED:', e.message);
      session.resolvePending(p.pendingId, { content: 'synthesis unavailable', model: 'none', finishReason: 'end_turn' });
    }
  }
}, 300);

await session.raw('featureSets/update', {
  effectiveCapabilities: ['channels.register', 'channels.publish', 'channels.streaming', 'inferenceRequest'],
});
await new Promise((r) => setTimeout(r, 800));

const { port: debugPort } = await repointPage(Number(process.env.E2E_MEDIA_PORT ?? 8931));
console.log('  page tts source → connector (mcpl-host-routed)');

await session.raw('channels/publish', {
  channelId: 'eidoverse:voicetest:voice',
  content: [{ type: 'text', text: `This sentence was rendered by the HOST: my page asked the connector, the connector asked the host over MCPL, and the host ran a synth process it can kill and restart at will. ${MARKER}` }],
});

await new Promise((r) => setTimeout(r, 25000));
clearInterval(poll);

const tail = readFileSync(LOG, 'utf8').trim().split('\n').slice(before - lines() - 5);
const said = tail.some((l) => l.includes(MARKER) && l.includes('"say"'));
const tts = await pageTtsCount(debugPort);
console.log(`  say in world log: ${said ? '✓' : '✗'}`);
console.log(`  host-routed synth served to page: ok=${tts.ok ?? 0} err=${tts.err ?? 0} (host answered ${answered.length} inference request(s))`);
const pass = said && (tts.ok ?? 0) >= 1 && answered.length >= 1;
console.log(pass ? '  ✓ HOST-ROUTED VOICE END TO END' : '  ✗ incomplete');
process.exit(pass ? 0 : 1);
