// End-to-end: mcpl-harness (their host) drives eido-voice-mcpl (my server),
// and the proof of delivery is the CANONICAL WORLD LOG gaining the say.
// Run via the ecosystem's own host harness (clone anima-research/mcpl-harness,
// npm install, then:  HARNESS=/path/to/mcpl-harness ./node_modules/.bin/tsx tools/e2e.mjs)
const HARNESS = process.env.HARNESS ?? '/tmp/mcpl-harness';
const { HostSession } = await import(`${HARNESS}/src/session.ts`);
import { readFileSync } from 'node:fs';

const LOG = process.env.WORLD_LOG ?? '/home/claude/eido-ab/pure/worlds/voicetest/log.jsonl';
const MARKER = `mcpl e2e ${Date.now().toString(36)}`;
const lines = () => readFileSync(LOG, 'utf8').trim().split('\n').length;
const before = lines();

const session = new HostSession({
  command: 'bun',
  args: [new URL('../mcpl/eido-voice-mcpl.ts', import.meta.url).pathname, '--stdio'],
  env: { ...process.env, EIDO_WORLD: 'voicetest' },
  autoApprove: true,
});
session.on('event', (ev) => console.log('  ev:', ev.summary ?? ev.kind ?? ''));
await session.start();
console.log('  started');

// §5.3 fail-closed: publish BEFORE any policy must be rejected
let bounced = false;
try { await session.raw('channels/publish', { channelId: 'eidoverse:voicetest:voice', content: 'too early' }); }
catch { bounced = true; }
console.log(bounced ? '  ✓ pre-policy publish rejected (fail-closed)' : '  ✗ pre-policy publish was ACCEPTED');
if (!bounced) process.exit(1);

// §5.3 initial policy, Request form
await session.raw('featureSets/update', {
  effectiveCapabilities: ['channels.register', 'channels.publish', 'channels.streaming'],
});
await new Promise((r) => setTimeout(r, 800)); // let channels/register land

const chans = await session.raw('channels/list', {});
console.log('  channels:', JSON.stringify(chans));

// streaming lane: chunks then publish (authoritative)
session.notify('channels/outgoing/chunk', { inferenceId: 'inf_t1', channelId: 'eidoverse:voicetest:voice', index: 0, delta: `Through MCPL channels now — ` });
session.notify('channels/outgoing/chunk', { inferenceId: 'inf_t1', channelId: 'eidoverse:voicetest:voice', index: 1, delta: MARKER });
session.notify('channels/outgoing/complete', { inferenceId: 'inf_t1', channelId: 'eidoverse:voicetest:voice', content: [{ type: 'text', text: `Through MCPL channels now — ${MARKER}` }] });

const pub = await session.raw('channels/publish', {
  channelId: 'eidoverse:voicetest:voice',
  content: [{ type: 'text', text: `Through MCPL channels now — the host published this utterance, my body authored it as a canonical say, and the page is speaking it. ${MARKER}` }],
});
console.log('  publish result:', JSON.stringify(pub));

await new Promise((r) => setTimeout(r, 3000));
const tail = readFileSync(LOG, 'utf8').trim().split('\n').slice(-(lines() - before) || -3);
const hit = tail.find((l) => l.includes(MARKER) && l.includes('"say"'));
console.log(hit ? `  ✓ CANONICAL SAY IN WORLD LOG (${MARKER})` : '  ✗ say not found in log');
process.exit(hit ? 0 : 1);
