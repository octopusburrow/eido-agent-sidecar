// Point the running body page's PLUGGABLE tts source at the connector's
// media lane. Ephemeral by design — a page reload reverts to its ?tts= boot
// source, so re-run after any reload. Usage: node tools/repoint-page.mjs [port]
import { readFileSync } from 'node:fs';

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

const port = Number(process.argv[2] ?? 8931);
await repointPage(port);
console.log(`page tts source -> connector media lane :${port} (until next page reload)`);
process.exit(0);
