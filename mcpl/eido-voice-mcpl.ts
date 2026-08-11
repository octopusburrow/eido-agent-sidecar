#!/usr/bin/env bun
/**
 * eido-voice-mcpl — the voice channel as an MCPL server.
 *
 * This is the control plane the bespoke "speechbridge" protocol used to be,
 * rebuilt on what the ecosystem already owns (SPEC.md 0.5):
 *
 *   - §5/§6   capability negotiation + feature sets — was speechbridge `hello`
 *   - §5.3    fail-closed until the host's initial policy — was nothing at all
 *   - §14.3   channels/register + channels/publish     — was `{type:"synth"}`
 *   - §14.3   channels/outgoing/chunk + /complete       — the streaming lane the
 *             spec names for "voice synthesis" verbatim; was going to be a
 *             parallel invention on mcpl#3
 *
 * Semantics: the registered channel IS the agent's embodied voice in one
 * eidoverse world. `channels/publish` delivers an utterance: the connector
 * authors the canonical `say` through the agent's OWN body page (CDP →
 * EW.sendVerb), and the page's own-say TTS lane speaks it — so the log stays
 * authoritative and audio is presentation tied to the say, exactly the
 * invariant Mica named. outgoing/chunk streams the in-flight turn; v1
 * BUFFERS ONLY (dedup + reassembly proven; no synth pre-warm yet — that lands
 * with the speak-ahead/provisional work), and `complete` discards the
 * advisory buffer because `publish` is authoritative.
 *
 * Raw PCM never crosses this connection. Media stays on the local pipe the
 * body already uses (ARCHITECTURE.md) — samples do not ride JSON-RPC.
 *
 * Run: bun mcpl/eido-voice-mcpl.ts --stdio     (spawned by an MCPL host)
 * Env: EIDO_WORLD (channel naming, default "world"),
 *      EIDO_BODY_STATE (default ~/.eido-body.json — where eido-body keeps the
 *      CDP port of the running body page).
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type { McplInitializeParams } from '@animalabs/mcpl-core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, parsePolicy, capabilityGranted, narrowGrant,
} from './mcpl05.js';
import type {
  FeatureSetMap, Grant, InitializeCapabilities05, McplInitializeResult05,
  McplServerCapabilities05,
} from './mcpl05.js';

const WORLD = process.env.EIDO_WORLD ?? 'world';
const CHANNEL_ID = `eidoverse:${WORLD}:voice`;
const BODY_STATE = process.env.EIDO_BODY_STATE ?? `${homedir()}/.eido-body.json`;
const log = (...a: unknown[]) => console.error(`[eido-voice-mcpl ${new Date().toISOString().slice(11, 19)}]`, ...a);

const featureSets: FeatureSetMap = {
  'voice.speak': {
    description: 'Deliver utterances to the agent’s embodied voice in an eidoverse world (canonical say + spoken audio)',
    uses: ['channels.register', 'channels.publish'],
  },
  'voice.stream': {
    description: 'Receive moderated in-flight text deltas to synthesize ahead of delivery (SPEC §14.3 voice-synthesis lane)',
    uses: ['channels.streaming'],
  },
  'speech.synthesis': {
    description: 'Render utterance text to audio via HOST-routed inference (prototype for content blocks in inference responses — one sentence-sized block per response, no streaming)',
    uses: ['inferenceRequest'],
  },
};

// ── the body: CDP into the agent's own page ──────────────────────────────────
// The say is authored by the BODY, never by this server directly: one author,
// one identity, and the page's own-say TTS speaks what it authored (#91).

async function bodySay(text: string, utt?: number): Promise<void> {
  const st = JSON.parse(readFileSync(BODY_STATE, 'utf8')) as { debug_port: number };
  const tabs = (await (await fetch(`http://127.0.0.1:${st.debug_port}/json`)).json()) as
    Array<{ webSocketDebuggerUrl?: string; url?: string }>;
  const tab = tabs.find((t) => t.url?.includes('world=') && t.webSocketDebuggerUrl);
  if (!tab?.webSocketDebuggerUrl) throw new Error('no body page found on CDP');
  log(`bodySay → ${tab.url?.slice(0, 70)}`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('CDP connect failed')); });
  try {
    const args = utt !== undefined ? { text, utt } : { text };
    const expr = `EW.sendVerb('say', ${JSON.stringify(args)}), 'said'`;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr } }));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP eval timeout')), 5000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id !== 1) return;
        clearTimeout(t);
        // A page-side exception is NOT an RPC error: it arrives as
        // exceptionDetails on a successful-looking response. Checking only
        // m.error reported 'delivered' for a say that never happened.
        const exc = m.result?.exceptionDetails;
        if (m.error) rej(new Error(m.error.message));
        else if (exc) rej(new Error(`page threw: ${exc.exception?.description ?? exc.text}`));
        else res();
      };
    });
  } finally { ws.close(); }
}

// ── media lane: the page's EXISTING ?tts= dialect, fulfilled via the host ────
// No new protocol: the page dials the same 3-message synth contract it always
// has ({type:"synth",id,text} → {type:"synth-result",id,pcm,sampleRate}); this
// server fulfills each pull with inference/request to the HOST, whose route
// executes the model wherever it likes (a standalone, killable synth process).
// Samples never ride the MCPL connection except as the proposed §10.3 audio
// block in the inference RESPONSE — sentence-sized, base64, no streaming.

const MEDIA_PORT = Number(process.env.EIDO_MEDIA_PORT ?? 8931);

// ── say authorship, topology B: no body page — author through a WORLD aux leg ─
// EIDO_SAY_VIA=world-ws joins the world directly as surface:"mcpl" with the
// agent's bearer (EIDO_AGENT_TOKEN); the lab's verified-aux-say rule (#57
// design prototype) accepts say — and only say — from a token-proven leg.
// The canonical log entry stays the ONE authoritative utterance either way.
const SAY_VIA = process.env.EIDO_SAY_VIA ?? 'cdp';
const WORLD_WS = process.env.EIDO_WORLD_WS ?? 'ws://127.0.0.1:8940/ws';
let worldLeg: WebSocket | null = null;
const ECHO_ID = process.env.EIDO_ID ?? 'hesperus';
type EchoWaiter = { text: string; res: (seq: number) => void };
const echoWaiters: EchoWaiter[] = [];

function legHandleFrame(ev: MessageEvent): void {
  const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
  // The server answers a refused verb with an error FRAME, not a closed
  // socket. The first cut stopped listening after the join — five publishes
  // reported delivered while every say bounced off the spectator gate.
  if (m.type === 'error') { log(`world error: ${m.error}`); return; }
  if (m.type === 'log') {
    const e = m.entry as { seq?: number; actor?: string; verb?: string; args?: { text?: string } };
    if (e?.verb === 'say' && e.actor === ECHO_ID) {
      const i = echoWaiters.findIndex((w) => w.text === e.args?.text);
      if (i >= 0) echoWaiters.splice(i, 1)[0].res(Number(e.seq ?? 0));
    }
  }
}

function legConnect(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    if (worldLeg?.readyState === WebSocket.OPEN) return res(worldLeg);
    const ws = new WebSocket(WORLD_WS);
    const to = setTimeout(() => rej(new Error('world ws join timeout')), 8000);
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'join', world: WORLD, id: ECHO_ID,
      surface: 'mcpl', agent: true, agentToken: process.env.EIDO_AGENT_TOKEN ?? '',
      token: process.env.EIDO_JOIN_TOKEN ?? 'workbench-2026',
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type?: string; error?: string };
      if (m.type === 'error') { clearTimeout(to); rej(new Error(`world: ${m.error}`)); ws.close(); return; }
      if (m.type !== 'snapshot') return;   // join completes at the snapshot, not the first frame
      clearTimeout(to); worldLeg = ws;
      ws.onmessage = legHandleFrame;       // keep listening: errors and echoes both matter
      res(ws);
    };
    ws.onclose = () => { if (worldLeg === ws) worldLeg = null; };
    ws.onerror = () => { clearTimeout(to); rej(new Error('world ws error')); };
  });
}

/** Deliver a say and resolve only on the AUTHORITATIVE log echo — send is not
 *  delivery (the verified-aux-say hunt: sends acked as delivered while the
 *  server refused every one). Returns the world-log seq. */
async function worldLegSay(text: string, utt?: number): Promise<number> {
  const ws = await legConnect();
  const echoed = new Promise<number>((res, rej) => {
    echoWaiters.push({ text, res });
    setTimeout(() => {
      const i = echoWaiters.findIndex((w) => w.res === res);
      if (i >= 0) { echoWaiters.splice(i, 1); rej(new Error('say not echoed by world log within 5s')); }
    }, 5000);
  });
  // spoken:true = this utterance is PERFORMED as presence by our media leg;
  // clients must log it and never re-perform it (the spoken-say protocol).
  // Without it every listener's own TTS lane ALSO spoke each say, overlapping
  // and canceling against the RTP voice ("no time or pacing", 03:33Z).
  ws.send(JSON.stringify({ type: 'verb', verb: 'say',
    args: utt !== undefined ? { text, utt, spoken: true, t0: Date.now() } : { text } }));
  return echoed;
}
async function deliverSay(text: string, utt?: number): Promise<number | undefined> {
  if (SAY_VIA === 'world-ws') return worldLegSay(text, utt);
  await bodySay(text, utt);
  return undefined;
}

// ── the server ───────────────────────────────────────────────────────────────

type ReqMsg = { id: number | string; method: string; params?: unknown };
type NotifMsg = { method: string; params?: unknown };

class EidoVoiceServer {
  private uttSeq = 0;
  private conn: McplConnection | null = null;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;
  private registered = false;
  private synthServed = 0;
  /** outgoing/chunk sentence buffers, keyed by inferenceId (SPEC §14.3: index
   *  is monotonic per inference; per-channel concat reconstructs the text). */
  private streams = new Map<string, { buf: string; lastIndex: number; touched: number }>();
  private gcTimer = setInterval(() => {
    // §10.5/§14.3 terminals are best-effort: a dropped outgoing/complete must
    // not leak its buffer forever. 120s without a chunk = the inference died.
    const cut = Date.now() - 120_000;
    for (const [k, v] of this.streams) if (v.touched < cut) this.streams.delete(k);
  }, 30_000);

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
        else await this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    this.conn = null;
  }

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    const mcpl = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplServerCapabilities05 = {
      version: '0.5',
      channels: { register: true, publish: true, streaming: true },
      featureSets,
    };
    const capabilities: InitializeCapabilities05 = mcpl ? { experimental: { mcpl: serverCaps } } : {};
    const result: McplInitializeResult05 = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'eido-voice-mcpl', version: '0.3.0' },
    };
    conn.sendResponse(msg.request.id, result);
    log(`initialize answered (channel ${CHANNEL_ID}; awaiting policy)`);
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    try {
      switch (req.method) {
        case method.FEATURE_SETS_UPDATE: {
          // §5.3: the REQUEST form is the initial policy exchange — only it
          // establishes readiness. (The notification form below updates the
          // grant but cannot conjure ready state.)
          await this.applyPolicy(req.params);
          this.policyReady = true;
          conn.sendResponse(req.id, buildReceipt(featureSets, this.grant));
          await this.registerChannel();
          break;
        }
        case 'tools/list':
          conn.sendResponse(req.id, { tools: [] }); // pure channel server — MCP baseline still answered
          break;
        case 'channels/list':
          conn.sendResponse(req.id, { channels: this.channelDescriptors() });
          break;
        case 'channels/publish': {
          if (!this.mayPublish()) { conn.sendError(req.id, -32001, 'channels.publish not granted'); break; }
          const text = extractText((req.params ?? {}) as Record<string, unknown>);
          // Audio tied to its utterance ID (Mica) — on the wire, not by
          // page-side coincidence: the say carries the world's own utt field,
          // the §14.3 ack returns it as messageId, and host synthesis for it
          // is tagged with the same id in metadata.
          const utt = ++this.uttSeq;
          const seq = await deliverSay(text, utt);
          conn.sendResponse(req.id, { delivered: true, messageId: seq !== undefined ? `seq:${seq}` : `utt:${utt}` });
          break;
        }
        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      conn.sendError(req.id, -32000, (e as Error).message);
    }
  }

  private async handleNotification(notif: NotifMsg): Promise<void> {
    const p = (notif.params ?? {}) as Record<string, unknown>;
    switch (notif.method) {
      case 'notifications/initialized': break;
      case method.FEATURE_SETS_UPDATE: {
        // §6.7 (pinned across five implementations): from the NOTIFICATION form,
        // apply narrowing only — a notification can take capabilities away but
        // never widen, and never establishes readiness. Wholesale applyPolicy
        // here let a stray notification WIDEN the grant (caught in independent
        // review, 2026-08-10).
        const parsed = parsePolicy(notif.params);
        if (parsed.ok) {
          this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
          log('policy narrowed (notification form):', JSON.stringify(this.grant.patterns));
        } else log('malformed policy notification ignored:', parsed.error);
        break;
      }
      case 'channels/publish': {
        if (!this.mayPublish()) { log('publish dropped: not granted'); break; }
        await deliverSay(extractText(p), ++this.uttSeq).catch((e) => log('say failed:', (e as Error).message));
        break;
      }
      case 'channels/outgoing/chunk': {
        if (!capabilityGranted(this.grant, 'channels.streaming') || p.channelId !== CHANNEL_ID) break;
        const key = String(p.inferenceId ?? '');
        const s = this.streams.get(key) ?? { buf: '', lastIndex: -1, touched: 0 };
        if (typeof p.index === 'number' && p.index <= s.lastIndex) break; // §9.4-style dedupe
        s.lastIndex = typeof p.index === 'number' ? p.index : s.lastIndex;
        s.buf += String(p.delta ?? ''); s.touched = Date.now();
        this.streams.set(key, s);
        // v1: buffered pre-warm only. Sentence-by-sentence speak-ahead is the
        // provisional-speech lane — presentation, never authored — and lands
        // with the media-peer topology (ARCHITECTURE.md, topology B).
        break;
      }
      case 'channels/outgoing/complete': {
        const key = String(p.inferenceId ?? '');
        this.streams.delete(key); // publish is authoritative; the buffer was advisory
        break;
      }
      default: log(`ignored notification: ${notif.method}`);
    }
  }

  private async applyPolicy(raw: unknown): Promise<void> {
    const parsed = parsePolicy(raw);
    if (!parsed.ok) { log('malformed policy:', parsed.error); return; }
    this.grant = parsed.grant;
    log('policy applied:', JSON.stringify(parsed.grant.patterns));
  }

  private mayPublish(): boolean {
    return this.policyReady && capabilityGranted(this.grant, 'channels.publish');
  }

  /** Ask the HOST to render text — the prototype's whole point. Returns
   *  s16le PCM + rate, decoded from the audio content block in the response.
   *  Tolerates a plain-string response (spec 0.5 hosts) by returning null. */
  private async hostSynth(text: string): Promise<{ pcm: string; sampleRate: number } | null> {
    if (!this.policyReady || !capabilityGranted(this.grant, 'inferenceRequest')) return null;
    const res = await this.conn!.sendRequest('inference/request', {
      featureSet: 'speech.synthesis',
      stream: false,
      messages: [{ role: 'user', content: text }],
      metadata: { utterance: `utt:${this.uttSeq}` },   // ties host synthesis to the say it renders
    }, 30000) as { content?: unknown };
    const c = res?.content;
    if (typeof c === 'string' || !Array.isArray(c)) return null;   // text-only host
    const block = c.find((b) => (b as { type?: string }).type === 'audio') as
      { data?: string; mimeType?: string } | undefined;
    if (!block?.data) return null;
    const rate = Number(/rate=(\d+)/.exec(block.mimeType ?? '')?.[1] ?? 22050);
    return { pcm: block.data, sampleRate: rate };
  }

  startMediaLane(): void {
    try {
      this.doStartMediaLane();
    } catch (e) {
      // A second connector on one machine (another world, another agent, a
      // test rig beside the live one) must not die over the media port —
      // it can still serve the channel plane; only page-pulls need the lane.
      // Set EIDO_MEDIA_PORT per instance. (Independent review: multi-agent
      // port collision was an unhandled case.)
      log(`media lane UNAVAILABLE on :${MEDIA_PORT} (${(e as Error).message}) — channel plane still up`);
    }
  }

  private doStartMediaLane(): void {
    Bun.serve({
      port: MEDIA_PORT, hostname: '127.0.0.1',
      fetch: (req, srv) => srv.upgrade(req) ? undefined : new Response('synth ws', { status: 426 }),
      websocket: {
        message: async (ws, raw) => {
          let m: { type?: string; id?: unknown; text?: string };
          try { m = JSON.parse(String(raw)); } catch { return; }
          if (m.type !== 'synth' || !m.text) return;
          try {
            const out = await this.hostSynth(m.text);
            // PROTOCOL.md v1 rules 1-2: EVERY synth gets exactly one
            // synth-result; failure is synth-result WITH error, never a
            // different type. (The first cut invented synth-error — my own
            // frozen contract, violated same-day; independent review caught it.)
            if (out) { this.synthServed++; ws.send(JSON.stringify({ type: 'synth-result', id: m.id, pcm: out.pcm, sampleRate: out.sampleRate })); }
            else ws.send(JSON.stringify({ type: 'synth-result', id: m.id, error: 'host returned no audio block' }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'synth-result', id: m.id, error: (e as Error).message }));
          }
        },
      },
    });
    log(`media lane on 127.0.0.1:${MEDIA_PORT} (page dialect, host-fulfilled)`);
  }

  servedCount(): number { return this.synthServed; }

  private channelDescriptors() {
    return [{
      id: CHANNEL_ID,
      type: 'eidoverse',
      label: `voice — ${WORLD} (embodied)`,
      direction: 'outbound',
      address: { world: WORLD, surface: 'voice' },
      metadata: { serverId: 'eido-voice-mcpl', media: `local-pipe:${MEDIA_PORT}` },
    }];
  }

  private async registerChannel(): Promise<void> {
    if (this.registered || !this.policyReady) return;
    if (!capabilityGranted(this.grant, 'channels.register')) return;
    this.registered = true;
    try {
      await this.conn!.sendRequest('channels/register', { channels: this.channelDescriptors() });
      log(`registered ${CHANNEL_ID}`);
    } catch (e) {
      this.registered = false;
      log('channels/register failed:', (e as Error).message);
    }
  }
}

function extractText(p: Record<string, unknown>): string {
  const c = p.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.filter((b) => b && (b as { type?: string }).type === 'text')
      .map((b) => String((b as { text?: string }).text ?? '')).join('');
    // An empty utterance is a caller bug, not a delivery: saying '' would be
    // silently dropped by the world and reported here as delivered:true —
    // which is how a mis-shaped publish (e.g. {content} where the caller
    // meant {text}) masqueraded as success for five straight smoke tests.
    if (!t.trim()) throw new Error('publish: text content is empty');
    return t;
  }
  throw new Error('publish: no text content');
}

if (process.argv.includes('--stdio') || !process.stdin.isTTY) {
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  const srv = new EidoVoiceServer();
  srv.startMediaLane();
  srv.serve(conn).then(() => process.exit(0));
} else {
  console.error('usage: eido-voice-mcpl.ts --stdio  (JSON-RPC over stdio; spawned by an MCPL host)');
  process.exit(2);
}
