/**
 * dsh-show-usage-amount — host half.
 *
 * The visible feature lives in the client bundle (`./lib/client.js`), but the
 * settings page also shows two numbers the built-in `tokenUsage` projection
 * cannot answer: today's usage (that projection keeps one running total with no
 * time dimension) and total task time (no projection records durations at all).
 *
 * This half registers one session projection, `usageAmountDaily`, that folds
 * both out of the event log and publishes them as a summary key, so every
 * conversation's row in the session list carries them and the root-scoped
 * settings page can aggregate across conversations.
 *
 * The state is a plain JSON object with a hand-written `parse` in place of a
 * zod schema: the projection registry only ever calls `stateSchema.parse` and
 * `wire.viewSchema.parse`, and avoiding the import keeps this half dependency
 * free (the bundle row then resolves from any absolute path).
 */

export const name = 'dsh-show-usage-amount';

/**
 * Day buckets kept in state. The settings card draws a ten-day trend, so ten
 * days have to survive a checkpoint; anything older than that has no reader and
 * would only grow the state.
 */
const DAY_WINDOW = 10;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;
const BUCKET_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];

/** A count that survives a checkpoint round trip: non-negative safe integer. */
function countOf(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
}

/** Read one bucket set out of stored state, filling gaps and rejecting junk. */
function parseBuckets(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of BUCKET_KEYS) out[key] = countOf(source[key]);
  return out;
}

/**
 * The four billing buckets of one usage sample. `inputTokens` is the
 * uncached prompt side, exactly as `@deepseek-ai/dsh-token-meter` reads it.
 */
function bucketsFrom(usage) {
  return {
    uncachedInputTokens: countOf(usage?.inputTokens),
    cacheReadTokens: countOf(usage?.cacheReadTokens),
    cacheWriteTokens: countOf(usage?.cacheWriteTokens),
    outputTokens: countOf(usage?.outputTokens),
  };
}

function bucketsEqual(left, right) {
  return BUCKET_KEYS.every((key) => left[key] === right[key]);
}

/** `target + sign * source`, clamped at zero so a late replacement cannot go negative. */
function shiftBuckets(target, source, sign) {
  const out = {};
  for (const key of BUCKET_KEYS) out[key] = Math.max(0, target[key] + sign * source[key]);
  return out;
}

/** Local calendar day of one event timestamp, in the Host process's time zone. */
function dayKeyOf(ms) {
  const time = Number(ms);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Keep only the newest `DAY_WINDOW` well-formed days. */
function trimDays(days) {
  const keys = Object.keys(days).filter((key) => DAY_KEY.test(key)).sort();
  if (keys.length <= DAY_WINDOW) return days;
  const kept = {};
  for (const key of keys.slice(keys.length - DAY_WINDOW)) kept[key] = days[key];
  return kept;
}

/**
 * The usage one durable Assistant settlement reports, if any. Mirrors the
 * token-meter rule: an explicit `data.usage` wins, otherwise the last `usage`
 * chunk of the compacted stream carries the attempt's numbers.
 */
function usageOf(event) {
  const data = event?.data;
  if (data === undefined || data === null) return undefined;
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return undefined;
}

function parseLast(value) {
  if (value === null || typeof value !== 'object') return null;
  const turn = Number(value.turn);
  const step = Number(value.step);
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return null;
  const day = typeof value.day === 'string' && DAY_KEY.test(value.day) ? value.day : '';
  return { turn, step, day, buckets: parseBuckets(value.buckets) };
}

function parseOpen(value) {
  if (value === null || typeof value !== 'object') return null;
  const turn = Number(value.turn);
  const time = Number(value.time);
  if (!Number.isSafeInteger(turn) || !Number.isFinite(time)) return null;
  return { turn, time };
}

function parseDays(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const days = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (!DAY_KEY.test(key)) continue;
    if (entry === null || typeof entry !== 'object') continue;
    days[key] = parseBuckets(entry);
  }
  return trimDays(days);
}

/**
 * Stored-state schema. The registry calls `parse` when restoring a persisted
 * checkpoint, so this is the one place a restored state is normalized — a row
 * written by an older shape cannot leak a malformed state into the fold.
 */
const stateSchema = {
  parse(value) {
    const source = value !== null && typeof value === 'object' ? value : {};
    return {
      days: parseDays(source.days),
      activeMs: countOf(source.activeMs),
      turns: countOf(source.turns),
      last: parseLast(source.last),
      open: parseOpen(source.open),
    };
  },
};

/** Wire schema: the value every session-list row carries. */
const viewSchema = {
  parse(value) {
    const source = value !== null && typeof value === 'object' ? value : {};
    return {
      days: parseDays(source.days),
      activeMs: countOf(source.activeMs),
      turns: countOf(source.turns),
    };
  },
};

/**
 * The projection unit. Two folds share one state:
 *
 * - **Day buckets** replay the token-meter replacement rule so a retried
 *   attempt is not double-counted: the last `(turn, step)` sample is remembered
 *   with the day it landed on, and a newer sample for the same step subtracts
 *   the old one before adding the new. `llm/retry-started` drops the slot so the
 *   retried attempt adds to the total instead of replacing it.
 * - **Task time** sums each turn's `turn/start` → `turn/end` span. Only closed
 *   turns count, which keeps the number stable across reads; a turn still
 *   running is not included until its `turn/end` is committed.
 */
const definition = {
  key: 'usageAmountDaily',
  stateVersion: 1,
  stateSchema,
  init: () => ({ days: {}, activeMs: 0, turns: 0, last: null, open: null }),
  apply(state, event) {
    // A projection runs inside the Host's committed-event drive: a throw here
    // would propagate into session handling, so any surprise in an event shape
    // leaves the state untouched instead.
    try {
      return fold(state, event);
    } catch {
      return state;
    }
  },
  wire: {
    viewSchema,
    view: (state) => ({ days: state.days, activeMs: state.activeMs, turns: state.turns }),
  },
};

/** The fold itself; see {@link definition} for what each arm contributes. */
function fold(state, event) {
  const type = event?.type;

  if (type === 'turn/start') {
    const turn = Number(event.data?.turn);
    if (!Number.isSafeInteger(turn)) return state;
    return { ...state, open: { turn, time: Number(event.time) } };
  }

  if (type === 'turn/end') {
    const open = state.open;
    if (open === null || open === undefined) return state;
    if (Number(event.data?.turn) !== open.turn) return state;
    const elapsed = Number(event.time) - open.time;
    return {
      ...state,
      open: null,
      activeMs: state.activeMs + (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0),
      turns: state.turns + 1,
    };
  }

  if (type === 'llm/retry-started') {
    const last = state.last;
    if (last === null || last === undefined) return state;
    if (last.turn !== Number(event.data?.turn) || last.step !== Number(event.data?.step)) return state;
    return { ...state, last: null };
  }

  if (type !== 'assistant/message' && type !== 'assistant/attempt') return state;
  const usage = usageOf(event);
  if (usage === undefined) return state;

  const turn = Number(event.data?.turn);
  const step = Number(event.data?.step);
  const buckets = bucketsFrom(usage);
  const last = state.last;
  const previous =
    last !== null && last !== undefined && last.turn === turn && last.step === step ? last : undefined;
  if (previous !== undefined && bucketsEqual(previous.buckets, buckets)) return state;

  const day = dayKeyOf(event.time);
  const days = { ...state.days };
  if (previous !== undefined && previous.day !== '') {
    days[previous.day] = shiftBuckets(days[previous.day] ?? zeroBuckets(), previous.buckets, -1);
  }
  if (day !== '') days[day] = shiftBuckets(days[day] ?? zeroBuckets(), buckets, 1);

  return { ...state, days: trimDays(days), last: { turn, step, day, buckets } };
}

/**
 * Bring the row up.
 *
 * The projection is registered under its own `ctx.inject` so the visible badge
 * and settings page keep working when the registry is absent (an older build)
 * — this half then simply publishes nothing.
 * @param ctx - Cordis context of this Loader row.
 */
export function apply(ctx) {
  try {
    ctx.logger?.info?.('dsh-show-usage-amount: host half active');
  } catch {
    /* the logger is optional; a missing one must not fail activation */
  }

  if (typeof ctx.inject !== 'function') return;
  try {
    ctx.inject(['sessionProjections'], (scope) => {
      const registry = scope.sessionProjections;
      if (registry === undefined || typeof registry.register !== 'function') return;
      const pending = registry.register(definition);
      // `register` returns a thenable that doubles as the disposer. Attaching a
      // handler both surfaces a rejected registration in the host log (the
      // registry otherwise logs it only for an unobserved promise) and marks it
      // observed so the default path does not log twice.
      if (pending !== undefined && typeof pending.catch === 'function') {
        pending.catch((error) => {
          scope.logger?.warn?.(
            `dsh-show-usage-amount: usageAmountDaily projection was not registered: ${String(error)}`,
          );
        });
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(`dsh-show-usage-amount: projection registration unavailable: ${String(error)}`);
  }
}
