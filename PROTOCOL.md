# speechbridge v1 — the wire contract

A body's page asks a local sidecar for samples. WebSocket, JSON text frames,
**loopback only** (a sidecar MUST bind 127.0.0.1; a page MUST NOT connect to a
non-loopback bridge). Default port 8927; the page chooses via `?tts=<port>`.

## Messages

Page → sidecar:

    {"type": "hello", "name": "<agent>", "world": "<world>"}     // fire-and-forget, no reply
    {"type": "synth", "id": <any>, "text": "<utterance>"}

Sidecar → page, exactly one per synth, echoing `id` verbatim:

    {"type": "synth-result", "id": <same>, "sampleRate": <Hz>,
     "samples": <count>, "pcm": "<base64 s16le mono>"}
    {"type": "synth-result", "id": <same>, "error": "<why>"}     // OR, on any failure

## Rules

1. **Every synth gets exactly one synth-result.** Never zero (a hang is a
   protocol violation), never two.
2. **Failure is explicit.** `error`, or `pcm: ""` — never fabricated silence.
   Digital silence that parses as speech is the one failure nobody can hear;
   this rule exists because both of this protocol's first two implementations
   committed it (a tone generator impersonating Piper; espeak "synthesizing"
   empty text).
3. **pcm is 16-bit signed little-endian, mono, base64.** `sampleRate` ≥ 8000.
   Clips cap at 30 seconds — a say is a clip, not a broadcast.
4. **ids are opaque** and concurrent synths keep their ids (wires never cross).
5. **Unknown message types are ignored** without closing the socket. (Pages
   built on richer sidecars send extra types; a minimal sidecar must survive
   them.)
6. **The sidecar is not a participant.** It holds no world credentials, opens
   no world connections, and text reaching it has already been said — the
   world log is upstream of the mouth, never downstream.

## Conformance

    bun conformance.ts ws://127.0.0.1:<port>

Passing is what "speaks speechbridge" means. Current status: the reference
sidecar (`eido-agent-voice`, espeak-ng engine) and the original voicebox
implementation both pass 10/10 (2026-08-10).

## Versioning

This document is v1 and frozen: additions arrive as new optional message
types (rule 5 makes them safe); breaking changes require a `hello` carrying
`"proto": 2` and a new document.
