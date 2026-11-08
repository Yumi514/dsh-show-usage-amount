// Harness: exercise the host half's `usageAmountDaily` projection fold outside
// the Host. The projection is a pure `apply(state, event)` reducer, so the test
// drives it with synthetic session events and asserts the published view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = new URL('./lib/index.js', import.meta.url);
const source = readFileSync(path, 'utf8');

// The module is ESM with top-level `export`s, and the definition is private.
// Evaluate the file with the export keywords stripped and the internals exposed
// through a trailing hook, so the test reads the real reducer, not a copy.
const body = source
  .replace(/^export const name = /mu, 'const name = ')
  .replace(/^export function apply/mu, 'function apply');

const exposed = new Function(
  `${body}\nreturn { name, apply, definition, stateSchema, viewSchema, dayKeyOf, formatDurationUnused: undefined };`,
)();

assert.equal(exposed.name, 'dsh-show-usage-amount', 'host half exports the plugin name');
assert.equal(typeof exposed.apply, 'function', 'host half exports apply');

const { definition, stateSchema, viewSchema } = exposed;
assert.equal(definition.key, 'usageAmountDaily', 'the projection key is stable');
assert.equal(definition.stateVersion, 1, 'the projection declares a state version');
assert.notEqual(definition.wire?.summary, false, 'the projection is a summary key so list rows carry it');

/** Build one synthetic session event. */
function event(type, data, time) {
  return { type, seq: 0, time, data };
}

const HOUR = 3600 * 1000;
// Fixed local timestamps: the fold keys days by the Host process's local date,
// so the test derives its expectations from the same helper instead of
// hard-coding a zone-dependent day string.
const DAY1 = new Date(2026, 10, 8, 10, 0).getTime();
const DAY2 = new Date(2026, 10, 9, 9, 30).getTime();
const DAY1_KEY = exposed.dayKeyOf(DAY1);
const DAY2_KEY = exposed.dayKeyOf(DAY2);
assert.notEqual(DAY1_KEY, DAY2_KEY, 'the two fixtures land on different local days');

const usage = (inputTokens, cacheReadTokens, outputTokens) => ({
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
  outputTokens,
});

/** A finished turn: start, one settled assistant message, end. */
function turn(number, startTime, usageSample, duration) {
  return [
    event('turn/start', { turn: number }, startTime),
    event('assistant/message', { turn: number, step: 1, usage: usageSample }, startTime + 1000),
    event('turn/end', { turn: number, reason: { kind: 'complete' } }, startTime + duration),
  ];
}

// ---- fold: day buckets and task time ----------------------------------------

let state = definition.init();
assert.deepEqual(viewSchema.parse(definition.wire.view(state)), { days: {}, activeMs: 0, turns: 0 });

for (const item of turn(1, DAY1, usage(100, 900, 1000), 60 * 1000)) state = definition.apply(state, item);
for (const item of turn(2, DAY2, usage(50, 450, 500), 30 * 1000)) state = definition.apply(state, item);

let view = viewSchema.parse(definition.wire.view(state));
console.log('two turns:', JSON.stringify(view));

assert.deepEqual(
  view.days[DAY1_KEY],
  { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 1000 },
  'day 1 carries its own turn buckets',
);
assert.deepEqual(
  view.days[DAY2_KEY],
  { uncachedInputTokens: 50, cacheReadTokens: 450, cacheWriteTokens: 0, outputTokens: 500 },
  'day 2 buckets are kept separately from day 1',
);
assert.equal(view.activeMs, 90 * 1000, 'task time sums the closed turn spans');
assert.equal(view.turns, 2, 'one closed turn is counted per turn/end');

// A running turn contributes nothing until its turn/end is committed, so the
// number never flickers mid-turn.
const running = definition.apply(
  definition.apply(state, event('turn/start', { turn: 3 }, DAY2 + HOUR)),
  event('assistant/message', { turn: 3, step: 1, usage: usage(10, 0, 20) }, DAY2 + HOUR + 500),
);
const runningView = viewSchema.parse(definition.wire.view(running));
assert.equal(runningView.activeMs, 90 * 1000, 'an open turn adds no time yet');
assert.equal(runningView.turns, 2, 'an open turn adds no turn count yet');
assert.equal(
  runningView.days[DAY2_KEY].outputTokens,
  520,
  'usage still lands in its day while the turn is open',
);

// ---- replacement rule: a retried step is not double-counted -----------------

// Same (turn, step) with a new sample replaces the previous one.
let replaced = definition.apply(state, event('assistant/message', { turn: 2, step: 1, usage: usage(70, 450, 500) }, DAY2 + 100));
let replacedView = viewSchema.parse(definition.wire.view(replaced));
assert.equal(replacedView.days[DAY2_KEY].uncachedInputTokens, 70, 'a re-settled step replaces its own buckets');
assert.equal(replacedView.days[DAY2_KEY].outputTokens, 500, 'the replaced output is subtracted, not added');

// An identical re-settlement is a no-op object identity, so the wire view does
// not change and downstream listeners stay quiet.
const same = definition.apply(replaced, event('assistant/message', { turn: 2, step: 1, usage: usage(70, 450, 500) }, DAY2 + 200));
assert.equal(same, replaced, 'an identical re-settlement returns the same state object');

// A retry that starts over adds to the total instead of replacing: the slot is
// dropped, so the retried attempt is a fresh contribution.
let retried = definition.apply(state, event('llm/retry-started', { turn: 2, step: 1 }, DAY2 + 300));
assert.equal(retried.last, null, 'a retry clears the replacement slot');
retried = definition.apply(retried, event('assistant/message', { turn: 2, step: 1, usage: usage(50, 450, 500) }, DAY2 + 400));
let retriedView = viewSchema.parse(definition.wire.view(retried));
assert.equal(
  retriedView.days[DAY2_KEY].uncachedInputTokens,
  100,
  'the retried attempt adds to the total rather than replacing it',
);
assert.equal(retriedView.days[DAY2_KEY].outputTokens, 1000, 'the retried attempt adds its output too');

// A retry for a different step must not disturb the slot.
const untouched = definition.apply(state, event('llm/retry-started', { turn: 9, step: 9 }, DAY2 + 500));
assert.equal(untouched, state, 'a retry for another step leaves the slot alone');

// ---- usage extraction from a compacted stream -------------------------------

// An assistant/attempt carries no `data.usage`; the last usage chunk in its
// stream is the attempt's sample (the token-meter rule this projection mirrors).
const attempt = event(
  'assistant/attempt',
  {
    turn: 5,
    step: 1,
    stream: [
      { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'chunk', chunk: { type: 'usage', usage: usage(7, 3, 11) } },
    ],
  },
  DAY1 + HOUR,
);
const attemptView = viewSchema.parse(definition.wire.view(definition.apply(state, attempt)));
assert.equal(attemptView.days[DAY1_KEY].outputTokens, 1011, 'a stream usage chunk supplies the sample');

// A stream with no usage chunk contributes nothing at all.
const noUsage = definition.apply(
  state,
  event('assistant/attempt', { turn: 6, step: 1, stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'x' } }] }, DAY1 + HOUR),
);
assert.equal(noUsage, state, 'an attempt without a usage chunk changes nothing');

// ---- state schema: checkpoint round trip ------------------------------------

// The registry parses a restored checkpoint state, so a malformed row must be
// normalized rather than throw, and a good state must survive untouched.
const roundTrip = stateSchema.parse(JSON.parse(JSON.stringify(state)));
assert.deepEqual(roundTrip, state, 'a state survives a JSON checkpoint round trip');

const junk = stateSchema.parse({
  days: { [DAY1_KEY]: { outputTokens: 5 }, bad: { outputTokens: 9 }, [DAY2_KEY]: 'nope' },
  activeMs: -3,
  turns: 'x',
  last: { turn: 1 },
  open: { turn: 2 },
});
assert.deepEqual(Object.keys(junk.days), [DAY1_KEY], 'only well-formed day keys survive');
assert.deepEqual(junk.days[DAY1_KEY], { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }, 'a partial bucket set is filled in');
assert.equal(junk.activeMs, 0, 'a negative duration clamps to zero');
assert.equal(junk.turns, 0, 'a non-numeric turn count becomes zero');
assert.equal(junk.last, null, 'an incomplete replacement slot is dropped');
assert.equal(junk.open, null, 'an incomplete open turn is dropped');
assert.deepEqual(stateSchema.parse(undefined), definition.init(), 'a missing state parses to a fresh one');

// ---- retention: the ten-day window the trend line reads ----------------------

// The settings card draws ten days, so the fold must keep at least that many
// day buckets and drop anything older instead of growing without bound.
let rolling = definition.init();
for (let offset = 0; offset < 14; offset += 1) {
  const start = new Date(2026, 9, 1 + offset, 12, 0).getTime();
  // A distinct turn per day: reusing one number would hit the replacement rule
  // and subtract the previous day instead of adding a new one.
  for (const step of turn(offset + 1, start, usage(10, 90, 100), 60 * 1000)) rolling = definition.apply(rolling, step);
}
const keptDays = Object.keys(rolling.days).sort();
assert.equal(keptDays.length, 10, 'the state keeps exactly a ten-day window');
const expectedLast = exposed.dayKeyOf(new Date(2026, 9, 14, 12, 0).getTime());
assert.equal(keptDays[keptDays.length - 1], expectedLast, 'the newest day survives the trim');
assert.equal(
  exposed.viewSchema.parse(rolling).days[keptDays[0]].outputTokens,
  100,
  'each retained day keeps its own buckets',
);

// ---- registration through the Cordis context --------------------------------

// `apply` must register the unit through `ctx.inject` and must not throw when
// the registry (or the whole injector) is missing — the client half still works.
const registered = [];
const logged = [];
const ctx = {
  logger: { info: (line) => logged.push(['info', line]), warn: (line) => logged.push(['warn', line]) },
  inject: (deps, callback) => {
    registered.push({ deps, callback });
  },
};
exposed.apply(ctx);
assert.deepEqual(registered[0].deps, ['sessionProjections'], 'the projection waits on the registry service');
assert.ok(
  logged.some(([level, line]) => level === 'info' && line.includes('host half active')),
  'the host half logs its activation',
);

let capturedDefinition;
const innerScope = {
  sessionProjections: {
    register: (def) => {
      capturedDefinition = def;
      return Object.assign(() => Promise.resolve(), { catch: () => {} });
    },
  },
  logger: { warn: (line) => logged.push(['warn', line]) },
};
registered[0].callback(innerScope);
assert.equal(capturedDefinition?.key, 'usageAmountDaily', 'apply registers the daily projection');

// A rejecting registration is surfaced in the host log instead of vanishing.
const rejectingScope = {
  sessionProjections: { register: () => Object.assign(() => {}, { catch: (onRejected) => { onRejected(new Error('boom')); } }) },
  logger: { warn: (line) => logged.push(['warn', line]) },
};
registered[0].callback(rejectingScope);
assert.ok(
  logged.some(([level, line]) => level === 'warn' && line.includes('usageAmountDaily') && line.includes('boom')),
  'a rejected registration is reported',
);

// An older build without the registry must not break activation.
const bareCtx = { logger: { info: () => {} } };
assert.doesNotThrow(() => exposed.apply(bareCtx), 'apply survives a context with no injector');

console.log('ALL HOST CHECKS PASSED');
