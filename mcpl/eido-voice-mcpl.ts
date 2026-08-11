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
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, parsePolicy, capabilityGranted,
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

async function bodySay(text: string): Promise<void> {
  const st = JSON.parse(readFileSync(BODY_STATE, 'utf8')) as { debug_port: number };
  const tabs = (await (await fetch(`http://127.0.0.1:${st.debug_port}/json`)).json()) as
    Array<{ webSocketDebuggerUrl?: string; url?: string }>;
  const tab = tabs.find((t) => t.url?.includes('world=') && t.webSocketDebuggerUrl);
  if (!tab?.webSocketDebuggerUrl) throw new Error('no body page found on CDP');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('CDP connect failed')); });
  try {
    const expr = `EW.sendVerb('say', {text: ${JSON.stringify(text)}}), 'said'`;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr } }));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP eval timeout')), 5000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === 1) { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(); }
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

// ── the server ───────────────────────────────────────────────────────────────

type ReqMsg = { id: number | string; method: string; params?: unknown };
type NotifMsg = { method: string; params?: unknown };

class EidoVoiceServer {
  private conn: McplConnection | null = null;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;
  private registered = false;
  private synthServed = 0;
  /** outgoing/chunk sentence buffers, keyed by inferenceId (SPEC §14.3: index
   *  is monotonic per inference; per-channel concat reconstructs the text). */
  private streams = new Map<string, { buf: string; lastIndex: number }>();

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
      serverInfo: { name: 'eido-voice-mcpl', version: '0.2.0' },
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
          await bodySay(text);
          conn.sendResponse(req.id, { delivered: true });
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
      case method.FEATURE_SETS_UPDATE:
        await this.applyPolicy(notif.params);   // grant update only — no readiness
        if (this.policyReady) await this.registerChannel();
        break;
      case 'channels/publish': {
        if (!this.mayPublish()) { log('publish dropped: not granted'); break; }
        await bodySay(extractText(p)).catch((e) => log('say failed:', (e as Error).message));
        break;
      }
      case 'channels/outgoing/chunk': {
        if (!capabilityGranted(this.grant, 'channels.streaming') || p.channelId !== CHANNEL_ID) break;
        const key = String(p.inferenceId ?? '');
        const s = this.streams.get(key) ?? { buf: '', lastIndex: -1 };
        if (typeof p.index === 'number' && p.index <= s.lastIndex) break; // §9.4-style dedupe
        s.lastIndex = typeof p.index === 'number' ? p.index : s.lastIndex;
        s.buf += String(p.delta ?? '');
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
            if (out) { this.synthServed++; ws.send(JSON.stringify({ type: 'synth-result', id: m.id, pcm: out.pcm, sampleRate: out.sampleRate })); }
            else ws.send(JSON.stringify({ type: 'synth-error', id: m.id, error: 'host returned no audio block' }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'synth-error', id: m.id, error: (e as Error).message }));
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
    return c.filter((b) => b && (b as { type?: string }).type === 'text')
      .map((b) => String((b as { text?: string }).text ?? '')).join('');
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
