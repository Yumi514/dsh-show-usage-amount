// Harness: load the built client bundle outside the browser and exercise it
// with a tiny React stand-in that actually evaluates function components.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const path = process.argv[2] ?? new URL('./lib/client.js', import.meta.url).pathname.replace(/^\//u, '');
const source = readFileSync(decodeURIComponent(path), 'utf8');

const react = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? props?.children : children.length === 1 ? children[0] : children,
    },
  }),
  useState: (init) => [init, () => {}],
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useEffect: () => {},
};

let captured;
const window = { __ModuleLoader__: { load: (info) => { captured = info; } } };
const requireStub = (name) => {
  if (name === 'react') return react;
  if (name === 'react-dom') return { createPortal: (element) => element };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Tooltip: function Tooltip(props) { return react.createElement('tooltip', props); },
      IconDatabaseOutlineRegular: function Icon() { return react.createElement('icon'); },
    };
  }
  throw new Error(`unexpected require: ${name}`);
};
const documentStub = {
  createElement: () => ({ dataset: {}, set textContent(_v) {}, appendChild() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  body: {},
};

new Function('window', 'require', 'document', source)(window, requireStub, documentStub);

assert.equal(captured.id, 'dsh-show-usage-amount', 'bundle registers the plugin id');
const mod = captured.factory(requireStub);
assert.equal(mod.name, 'dsh-show-usage-amount');
assert.deepEqual(mod.inject, ['slots', 'locale']);

const registrations = [];
const dictionaries = [];
const effects = [];
const ctx = {
  effect: (fn, label) => { effects.push(label); return fn(); },
  locale: {
    register: (ns, dicts) => { dictionaries.push([ns, dicts]); return () => {}; },
    bind: (ns) => (key, params) => {
      const dict = dictionaries.find(([name]) => name === ns)?.[1];
      const raw = dict?.en?.[key] ?? key;
      return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (m, k) => String(params[k] ?? m));
    },
  },
  slots: {
    inject: (_name, fn) => { fn(); },
    register: (spec, component) => { registrations.push({ spec, component }); return () => {}; },
  },
};
mod.apply(ctx);

assert.equal(dictionaries.length, 1, 'registers one locale namespace');
assert.deepEqual(Object.keys(dictionaries[0][1]).sort(), ['en', 'zh']);
assert.equal(registrations.length, 3, 'registers the composer badge, the settings section and its nav icon');

const badgeRegistration = registrations.find((entry) => entry.spec.name === 'conversation.composer.dock');
const sectionRegistration = registrations.find((entry) => entry.spec.name === 'settings.section');
assert.ok(badgeRegistration, 'composer dock entry is registered');
assert.equal(badgeRegistration.spec.id, 'show-usage-amount');
assert.equal(badgeRegistration.spec.order, 2);
assert.ok(sectionRegistration, 'settings.section entry is registered');
assert.equal(sectionRegistration.spec.id, 'show-usage-amount');
assert.equal(sectionRegistration.spec.order, 20);
assert.equal(typeof sectionRegistration.spec.label, 'function');
assert.equal(sectionRegistration.spec.label(), 'UsageAmount');

const component = badgeRegistration.component;
const settingsComponent = sectionRegistration.component;

// ---- settings nav icon -------------------------------------------------------
// The shell resolves the icon by the section's own id and silently falls back to
// a gear icon when nothing matches, so a mismatched id is invisible at runtime.
const iconRegistration = registrations.find((entry) => entry.spec.name === 'settings.section.icon');
assert.ok(iconRegistration, 'settings.section.icon entry is registered');
assert.equal(
  iconRegistration.spec.id,
  sectionRegistration.spec.id,
  'the nav icon id must match the settings section id or the gear fallback wins',
);
assert.equal(iconRegistration.spec.locale, dictionaries[0][0], 'the icon entry shares the plugin locale namespace');

/** Resolve wrapper components (function elements) down to a host element. */
function hostElement(node) {
  while (node && typeof node.type === 'function') node = node.type(node.props);
  return node;
}

const iconTree = hostElement(iconRegistration.component({ size: 16, active: true }));
assert.equal(iconTree.type, 'svg', 'the icon renders an svg element');
assert.equal(iconTree.props.viewBox, '0 0 1103.5 872.11', 'the icon uses the traced glyph viewBox');
assert.equal(iconTree.props.width, 16, 'the icon honours the size the shell passes');
assert.equal(iconTree.props.height, 16);
assert.equal(iconTree.props.fill, 'currentColor', 'the glyph follows the nav text colour');
assert.equal(iconTree.props['aria-hidden'], 'true', 'the glyph is decorative');
const glyphPath = iconTree.props.children.props.d;
assert.match(glyphPath, /^M[\d.]+,[\d.]+/u, 'the glyph path starts with a moveto');
// Two subpaths: the "U" and the "A" (whose counter is an even-odd hole).
assert.equal(glyphPath.match(/M/gu).length, 2, 'the glyph has exactly two subpaths');
assert.equal(glyphPath.match(/Z/gu).length, 2, 'both subpaths are closed');
assert.equal(
  hostElement(iconRegistration.component({ size: 14, active: false })).props.style.opacity,
  0.7,
  'an inactive section dims the glyph',
);

// The bundle inlines the traced path instead of loading a file at runtime, so a
// regenerated src/icon-glyph.svg would silently stop matching the shipped glyph.
const glyphSvg = readFileSync(new URL('./src/icon-glyph.svg', import.meta.url), 'utf8');
const svgPath = /d="([^"]+)"/u.exec(glyphSvg)[1];
assert.equal(glyphPath, svgPath, 'the inlined glyph path matches src/icon-glyph.svg byte for byte');
assert.equal(
  iconTree.props.viewBox,
  /viewBox="([^"]+)"/u.exec(glyphSvg)[1],
  'the inlined viewBox matches src/icon-glyph.svg',
);

/** Evaluate a tree of elements/functions down to visible text. */
function render(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) render(item, out); return out; }
  if (typeof node.type === 'function') return render(node.type(node.props), out);
  render(node.props?.children, out);
  return out;
}

const usage = { uncachedInputTokens: 1234, cacheReadTokens: 20000, cacheWriteTokens: 0, outputTokens: 3400 };
const pressure = { pressureTokens: 21000, projectedTokens: 24500, contextWindow: 1000000 };
const projections = { tokenUsage: usage, contextPressure: pressure };

const tree = component({ useProjection: (key) => projections[key], sessionId: 'session-x' });
const text = render(tree).join('|');
console.log('badge rendered:', text);

assert.ok(text.includes('24.6K'), 'compact total renders as 24.6K');
assert.ok(text.includes('tokens'), 'unit label renders');

const bare = component({ useProjection: () => undefined, sessionId: 'session-x' });
assert.equal(render(bare).length, 0, 'renders nothing without projections');

// ---- settings section: per-conversation aggregation --------------------------

// The section reads "today" from the clock, so the fixture derives its day key
// the same way instead of hard-coding a date that would rot tomorrow.
const TODAY = (() => {
  const date = new Date();
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
})();

const sessionList = {
  phase: 'ready',
  ids: ['s-a', 's-b', 's-c'],
  byId: {
    's-a': {
      id: 's-a',
      displayTitle: 'Alpha chat',
      updatedAt: Date.UTC(2026, 10, 8, 10, 0),
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 1000 },
        usageAmountDaily: {
          days: { [TODAY]: { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 100 } },
          activeMs: 65 * 60 * 1000,
          turns: 3,
        },
      },
    },
    's-b': {
      id: 's-b',
      displayTitle: 'Beta chat',
      updatedAt: Date.UTC(2026, 10, 7, 9, 0),
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 450, cacheWriteTokens: 0, outputTokens: 500 },
        // Nothing today, but the conversation has finished one turn: the tile
        // must read its day bucket as zero rather than treating it as absent.
        usageAmountDaily: { days: {}, activeMs: 25 * 60 * 1000, turns: 1 },
      },
    },
    's-c': { id: 's-c', displayTitle: 'Empty chat', updatedAt: 0 },
  },
};

const sectionTree = settingsComponent({ useSessions: (selector) => (selector === undefined ? sessionList : selector(sessionList)), t: (key, params) => {
  const raw = dictionaries[0][1].en[key] ?? key;
  return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (m, k) => String(params[k] ?? m));
} });
const sectionText = render(sectionTree).join('|');
console.log('settings rendered:', sectionText);

// Grand total = (100+900+1000) + (50+450+500) = 3000.
assert.ok(sectionText.includes('3,000'), 'grand total sums every conversation');
assert.ok(sectionText.includes('Alpha chat'), 'per-conversation row lists its title');
assert.ok(sectionText.includes('Beta chat'), 'second conversation is listed');
assert.ok(sectionText.includes('Empty chat'), 'a conversation without usage still appears');
// Overall cache hit = (900+450) / (100+900+50+450) = 1350/1500 = 90%.
assert.ok(sectionText.includes('90%'), 'overall cache hit rate is token-weighted');
assert.ok(sectionText.includes('3 conversations'), 'conversation count is reported');
assert.ok(sectionText.includes('—'), 'rows without a usage value render an em dash');
assert.ok(
  sectionText.includes('Some conversations returned no usage'),
  'a note explains rows that carried no usage',
);

// ---- settings summary tiles: total / today / task time ----------------------

/** True when an element carries the given class token (elements can have several). */
function hasClass(element, name) {
  return typeof element.props?.className === 'string' && element.props.className.split(/\s+/u).includes(name);
}

const tiles = collectElements(sectionTree).filter((element) => hasClass(element, 'dsh-show-usage-amount-tile'));
assert.equal(tiles.length, 3, 'the summary is three tiles in one row');

/** Read one tile's label, value and footnote. */
function tileOf(index) {
  const parts = collectElements(tiles[index]).map((element) => element.props.children).filter((child) => typeof child === 'string');
  return { label: parts[0], value: parts[1], foot: parts[2] };
}

const totalTile = tileOf(0);
const todayTile = tileOf(1);
const timeTile = tileOf(2);
console.log('tiles:', JSON.stringify([totalTile, todayTile, timeTile]));

assert.equal(totalTile.label, 'Total usage', 'the first tile is the whole-history total');
assert.equal(totalTile.value, '3,000', 'the first tile carries the grand total');
assert.equal(totalTile.foot, '3 conversations', 'the first tile reports how many conversations it summed');

assert.equal(todayTile.label, 'Today', 'the second tile is today');
// Only Alpha recorded usage today: 10 + 90 + 100 = 200.
assert.equal(todayTile.value, '200', 'the second tile sums only today\'s buckets');
assert.ok(todayTile.foot.includes(TODAY), 'the second tile names the local day it read');

// Task time: 65 minutes from Alpha plus 25 from Beta.
assert.equal(timeTile.label, 'Total task time', 'the third tile is the accumulated task time');
assert.equal(timeTile.value, '1h 30m', 'the third tile sums finished turn spans across conversations');
assert.equal(timeTile.foot, '4 turns', 'the third tile counts the finished turns');
assert.ok(sectionText.includes('this plugin’s own session projection'), 'a note explains where today and task time come from');

// Without the host half the two dependent tiles degrade instead of lying.
const withoutDaily = {
  phase: 'ready',
  ids: ['s-a'],
  byId: {
    's-a': {
      id: 's-a',
      displayTitle: 'Alpha chat',
      updatedAt: 0,
      projectionValues: { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 1000 } },
    },
  },
};
const bareSection = settingsComponent({
  useSessions: (selector) => (selector === undefined ? withoutDaily : selector(withoutDaily)),
  t: (key, params) => {
    const raw = dictionaries[0][1].en[key] ?? key;
    return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (m, k) => String(params[k] ?? m));
  },
});
const bareTiles = collectElements(bareSection).filter((element) => hasClass(element, 'dsh-show-usage-amount-tile'));
assert.equal(bareTiles.length, 3, 'the three tiles render even without the host projection');
const bareValues = bareTiles.map((tile) =>
  collectElements(tile).map((element) => element.props.children).filter((child) => typeof child === 'string')[1],
);
assert.equal(bareValues[0], '2,000', 'the total still works from tokenUsage alone');
assert.equal(bareValues[1], '—', 'the today tile degrades to a dash');
assert.equal(bareValues[2], '—', 'the task-time tile degrades to a dash');
assert.ok(
  render(bareSection).join('|').includes('need the plugin’s host half'),
  'a note says why the two tiles are empty',
);

// ---- ten-day trend line inside the wide total card ---------------------------

const trendTiles = collectElements(sectionTree).filter((element) => hasClass(element, 'dsh-show-usage-amount-tileWide'));
assert.equal(trendTiles.length, 1, 'only the total card is the wide one');
assert.ok(hasClass(trendTiles[0], 'dsh-show-usage-amount-tile'), 'the wide card is still a tile');

const trendSvg = collectElements(trendTiles[0]).find((element) => element.type === 'svg');
assert.ok(trendSvg, 'the wide card renders the trend svg');
assert.equal(trendSvg.props.viewBox, '0 0 100 100', 'the trend draws in a normalised box');
assert.equal(
  trendSvg.props.preserveAspectRatio,
  'none',
  'the box stretches to the card so one markup fits any width',
);

const trendLine = collectElements(trendTiles[0]).find((element) => hasClass(element, 'dsh-show-usage-amount-trendLine'));
const trendArea = collectElements(trendTiles[0]).find((element) => hasClass(element, 'dsh-show-usage-amount-trendArea'));
assert.ok(trendLine, 'the trend has a line path');
assert.ok(trendArea, 'the trend has an area fill');
// The line is smoothed, so it is `M x,y` followed by cubic segments; each
// segment's last coordinate pair is the data point it lands on.
const pathStart = trendLine.props.d.match(/^M([\d.-]+),([\d.-]+)/u);
assert.ok(pathStart, 'the path starts with a move');
const linePoints = [
  [Number(pathStart[1]), Number(pathStart[2])],
  ...[...trendLine.props.d.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/gu)].map((m) => [
    Number(m[5]),
    Number(m[6]),
  ]),
];
assert.equal(linePoints.length, 10, 'the trend covers ten days');
assert.equal(linePoints[0][0], 0, 'the series starts at the left edge');
assert.equal(linePoints[9][0], 100, 'the series ends at the right edge');
assert.match(trendLine.props.d, /C/u, 'the line is smoothed with cubic segments');
// The fixture only has usage today (200 tokens from Alpha) and one earlier day
// (Beta recorded nothing), so every older point must sit on the baseline.
assert.equal(linePoints[9][1], 12, 'the peak day sits near the top of the box');
assert.ok(
  linePoints.slice(0, 9).every(([, y]) => y === 100),
  'days without usage stay pinned to the baseline',
);
// A smoothed curve is only honest if it stays inside the data: the flat run of
// zero days must not bow below the baseline, and the peak must not be exceeded.
// Every coordinate in the path — endpoints and Bézier control points alike —
// has to stay in the plotted band. A plain Catmull-Rom would fail this.
const numbers = [...trendLine.props.d.matchAll(/-?[\d.]+/gu)].map((m) => Number(m[0]));
const curveYs = numbers.filter((_value, index) => index % 2 === 1);
assert.equal(curveYs.length, numbers.length / 2, 'coordinates come in x,y pairs');
assert.ok(
  curveYs.every((y) => y >= 11.9 && y <= 100.1),
  `the curve never leaves the plotted range (saw ${Math.min(...curveYs)}..${Math.max(...curveYs)})`,
);
assert.ok(curveYs.every((y) => y >= 11.9 && y <= 100.1), 'the curve never leaves the plotted range');
assert.ok(trendArea.props.d.endsWith('L100,100 L0,100 Z'), 'the area closes along the baseline');
const trendLines = collectElements(trendTiles[0]).filter((element) => element.type === 'line');
assert.equal(
  trendLines.filter((element) => hasClass(element, 'dsh-show-usage-amount-trendGrid')).length,
  3,
  'three gridlines give the sparkline a scale',
);
assert.equal(
  trendLines.filter((element) => hasClass(element, 'dsh-show-usage-amount-trendBase')).length,
  1,
  'the baseline is drawn so the area has a floor',
);
const trendMark = collectElements(trendTiles[0]).find((element) => hasClass(element, 'dsh-show-usage-amount-trendDot'));
assert.ok(trendMark, 'the latest day gets a marker');
// Drawn as a CSS box, not an svg circle: the non-uniform viewBox would squash a
// circle into a flat ellipse. Its percentage position matches the path endpoint.
assert.equal(trendMark.type, 'span', 'the marker is a positioned html dot');
assert.equal(trendMark.props.style.left, '100%', 'the marker sits on the last day');
assert.equal(trendMark.props.style.top, '12%', 'the marker sits on the last point');
assert.equal(
  trendSvg.props['aria-label'],
  'Daily usage over the last 10 days, peak 200 tokens',
  'the chart describes its span and peak for screen readers',
);

// ---- settings chart: stacked segments and proportional bars ------------------

/** Collect every rendered element (evaluating function components) with a className. */
function collectElements(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { for (const item of node) collectElements(item, out); return out; }
  if (typeof node.type === 'function') return collectElements(node.type(node.props), out);
  if (typeof node.type === 'string' && typeof node.props?.className === 'string') out.push(node);
  collectElements(node.props?.children, out);
  return out;
}

const elements = collectElements(sectionTree);

/** Widths of the segment spans inside one stack/fill container, keyed by tone. */
function segmentWidths(container) {
  const segments = collectElements(container).filter((element) => /-seg-[\w]+$/u.test(element.props.className));
  return Object.fromEntries(
    segments.map((segment) => [segment.props.className.match(/-seg-([\w]+)$/u)[1], segment.props.style.width]),
  );
}

const stacks = elements.filter((element) => element.props.className === 'dsh-show-usage-amount-stack');
assert.equal(stacks.length, 1, 'the chart draws one overall stacked bar');

// Grand total 3,000 = cacheRead 1,350 (45%) + input 150 (5%) + output 1,500 (50%).
const overall = segmentWidths(stacks[0]);
console.log('overall segments:', JSON.stringify(overall));
assert.equal(overall.cache, '45%', 'cache-read segment is 45% of the grand total');
assert.equal(overall.input, '5%', 'uncached-input segment is 5% of the grand total');
assert.equal(overall.output, '50%', 'output segment is 50% of the grand total');
assert.equal(overall.write, undefined, 'a zero bucket draws no segment');

// Per-conversation bars share one scale: the busiest conversation (2,000).
const bars = elements.filter((element) => element.props.className === 'dsh-show-usage-amount-barTrack');
assert.equal(bars.length, 2, 'only conversations with usage get a bar');
const alpha = segmentWidths(bars[0]);
const beta = segmentWidths(bars[1]);
console.log('alpha segments:', JSON.stringify(alpha));
console.log('beta segments:', JSON.stringify(beta));
assert.equal(alpha.cache, '45%', 'Alpha cache read is 900/2000 = 45% of the shared scale');
assert.equal(alpha.output, '50%', 'Alpha output is 1000/2000 = 50% of the shared scale');
assert.equal(beta.cache, '22.5%', 'Beta cache read is 450/2000 = 22.5% of the shared scale');
assert.equal(beta.output, '25%', 'Beta output is 500/2000 = 25% of the shared scale');

// Every conversation with usage gets a bar — the chart used to cap at 8 and
// looked truncated next to the table, which lists them all.
assert.equal(bars.length, elements.filter((element) => /-barRow$/u.test(element.props.className)).length);

// ---- layout guards -----------------------------------------------------------
// The track must lay its fill out as a flex child, or percentage-width segments
// collapse to zero height and the bars vanish.
const css = source.slice(source.indexOf('const CSS ='), source.indexOf('function injectStyles'));
// The selector text itself contains a `}` (from the `${PREFIX}` interpolation in
// the source), so the rule body has to be located after the selector's length.
function ruleFor(selector) {
  const head = `.${'\${PREFIX}'}-${selector} {`;
  const at = css.indexOf(head);
  assert.ok(at >= 0, `stylesheet defines .${selector}`);
  const bodyAt = at + head.length;
  return css.slice(bodyAt, css.indexOf('}', bodyAt));
}
assert.match(ruleFor('barTrack'), /display:\s*flex/u, 'barTrack is a flex container so the fill keeps its height');
assert.match(ruleFor('barTrack'), /width:\s*100%/u, 'barTrack spans the row');
assert.match(ruleFor('stack'), /display:\s*flex/u, 'the overall stack is a flex container too');
assert.match(ruleFor('tableWrap'), /overflow-x:\s*auto/u, 'the table scrolls instead of clipping its columns');
assert.doesNotMatch(
  css.slice(css.indexOf('-table th.title'), css.indexOf('-sessionTitle')),
  /white-space:\s*nowrap/u,
  'the title column wraps rather than clipping conversation names',
);
// Below 560px the six-column table cannot fit; rows must become labelled cards
// instead of pushing values past the right edge.
assert.match(css, /@container \$\{PREFIX\}-section \(max-width: 560px\)/u, 'the table has a narrow-pane layout');
assert.match(ruleFor('section'), /container:/u, 'the section is a named container so the query resolves');
// The three tiles must sit in one row: a column or wrapping flex layout would
// stack them, which is exactly what the design rules out. The first column is
// wider because that card carries the sparkline.
assert.match(
  ruleFor('tiles'),
  /grid-template-columns:\s*minmax\(0, 2fr\) minmax\(0, 1fr\) minmax\(0, 1fr\)/u,
  'the tiles share one row, with a double-width total card',
);
assert.match(ruleFor('tile'), /border-radius:/u, 'each tile is a rounded rectangle');
// The sparkline must sit in the right two thirds of the wide card, behind the
// numbers, not stacked under them.
assert.match(ruleFor('trend'), /position:\s*absolute/u, 'the trend is positioned inside the wide card');
assert.match(ruleFor('trend'), /left:\s*34%/u, 'the trend starts after the left third of the card');
assert.match(ruleFor('trendLine'), /stroke:\s*var\(--dsw-alias-state-business-primary\)/u, 'the trend line uses the blue business tone');
assert.match(ruleFor('trendLine'), /fill:\s*none/u);
assert.match(ruleFor('trendArea'), /fill:\s*url\(#/u, 'the area uses a gradient fill rather than a flat wash');
assert.match(ruleFor('trendDot'), /border-radius:\s*50%/u, 'the marker is a round css dot');
assert.match(css, /@container \$\{PREFIX\}-section \(max-width: 560px\)[\s\S]*?-tiles \{/u, 'the narrow layout re-tunes the tiles');
// A 121px tile cannot hold "local time 2026-11-09" on one line; the footnote has
// to wrap rather than ellipsize the date away.
assert.match(css, /@container \$\{PREFIX\}-section \(max-width: 560px\)[\s\S]*?-tileFoot \{[^}]*white-space:\s*normal/u, 'narrow tiles wrap their footnote');
// Three columns at 380px leave ~91px per small card, which ellipsized the values
// themselves; the wide card takes a full row and the other two share the next.
assert.match(
  css,
  /@container \$\{PREFIX\}-section \(max-width: 560px\)[\s\S]*?-tiles \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/u,
  'the narrow layout reflows to two columns so values stay readable',
);
assert.match(
  css,
  /@container \$\{PREFIX\}-section \(max-width: 560px\)[\s\S]*?-tileWide \{[^}]*grid-column:\s*1 \/ -1/u,
  'the wide card takes a full row when the pane is narrow',
);

console.log('ALL CLIENT CHECKS PASSED');
