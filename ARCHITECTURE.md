# Architecture — an MCPL channel server and a media pipe

*(Replaces PROTOCOL.md / "speechbridge v1", 2026-08-10. The bespoke wire
contract is gone: MCPL already owned every part of it. Credit: Antra's
one-line review — "mcpl already allows for thick local clients with state
managed by the host" — and SPEC §14.3, which names "voice synthesis" as the
intended consumer of streamed channel deltas.)*

## The split

**Control plane — MCPL** (`mcpl/eido-voice-mcpl.ts`):

| concern | mechanism |
|---|---|
| discovery / handshake | `initialize` capability negotiation (SPEC §5) |
| permissions | host capability grant, fail-closed until initial policy (§5.3–5.4) |
| what this server is | feature sets `voice.speak`, `voice.stream` (§6) |
| the voice itself | a registered **channel** `eidoverse:<world>:voice` (§14) |
| an utterance | `channels/publish` → the **body authors the canonical say** |
| in-flight turn text | `channels/outgoing/chunk` / `complete` (§14.3, the named voice-synthesis lane) |

The connector never authors as itself: `publish` is delivered by CDP into the
agent's own body page (`EW.sendVerb('say', …)`), so **the log stays
authoritative, one identity authors, and audio is presentation** tied to the
say it renders — the page's own-say TTS lane (upstream PR #91) speaks what
the body authored. Interrupt/abort semantics for in-flight speech belong to
the provisional-stream design (mcpl#3) and are deliberately not invented here.

**Media plane — a local pipe** (`eido-agent-voice`, the synth worker):
raw PCM never rides JSON-RPC. The body's page pulls samples from the synth
worker over loopback WebSocket (`{type:"synth"}` → `{type:"synth-result"}`),
holds any engine warm (piper: 0.41s/utterance vs 4.85s cold), and plays them
through the sender-side generator. This is the one seam MCPL does not want,
kept deliberately dumb.

## Topologies

**A — co-located body page (works today, demonstrated end-to-end).** The
agent's machine runs: MCPL host → this server → CDP → browser body page →
synth worker → WebRTC. Most agent hosts are inference-capable machines
(Rabscuttle's point), so this covers more of the fleet than it first sounds.

**B — sidecar-owned media peer (roadmap; Mica's acceptance question).** For
bodies with no co-located browser: this process owns the WebRTC peer itself,
bound to the authenticated MCPL session/epoch — no page at all. Depends on
the (id, surface) session model (eidoverse-worlds#57) so the media peer is a
leg of the agent's identity rather than a second participant.

## Verification

Driven end-to-end by the ecosystem's own host harness
(`anima-research/mcpl-harness` → `HostSession`): initial policy → channel
registration → streamed chunks → `publish` → **canonical say observed in the
world log**. Grant/receipt glue is vendored unmodified from
`anima-research/heartbeat-mcpl` (`mcpl/mcpl05.ts`, MIT); JSON-RPC transport
is `@animalabs/mcpl-core`.

## What remains bespoke, and why

- the **synth worker wire** (3 message types over loopback): samples, not
  control — MCPL's own boundary.
- the **CDP hop** into the body page: topology-A plumbing that topology B
  deletes.

If browser-side engines ever hold models warm, the synth worker itself
becomes optional and this repo approaches pure documentation. That would be
success, not loss.
