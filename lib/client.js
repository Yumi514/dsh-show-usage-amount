/**
 * dsh-show-usage-amount — browser half.
 *
 * Registers one `conversation.composer.dock` entry: a compact reading of how
 * many tokens the current conversation has used, sitting in the composer dock
 * (below the input card, beside the built-in session statistics). Clicking it
 * opens a portaled panel with the full prompt/output split, cache traffic and
 * the current context occupancy.
 *
 * Data sources are session projections published by
 * `@deepseek-ai/dsh-token-meter`:
 * - `tokenUsage` — whole durable log billing buckets (uncached input, cache
 *   read, cache write, output); unaffected by paging or compaction.
 * - `contextPressure` — `projectedTokens` is how large the next request's
 *   prompt will be, and `contextWindow` its capacity.
 *
 * Bundle contract: plain CJS-style script executed by `window.__ModuleLoader__`
 * — no top-level import/export; react comes from `require`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-show-usage-amount',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const react = require('react');
    const { createElement: h, Fragment, useState, useRef, useMemo, useEffect } = react;
    const { createPortal } = require('react-dom');

    let primitives;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-show-usage-amount] UI primitives unavailable: ' + String(error));
    }

    const NS = 'showUsageAmount';
    const PREFIX = 'dsh-show-usage-amount';

    /** Dictionaries; `zh` and `en` are the two required base locales. */
    const dicts = {
      zh: {
        short: 'tokens',
        label: '本次对话已用 {total} tokens',
        used: 'Token 用量',
        input: '输入（未缓存）',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入',
        output: '输出',
        total: '合计',
        cacheHit: '缓存命中率',
        context: '当前上下文',
        contextValue: '{used} / {window}',
        note: '全会话统计（含已压缩历史）；上下文为下一次请求的预估。',

        // settings section
        nav: 'UsageAmount',
        title: 'UsageAmount',
        intro: '按对话统计 token 用量；顶部是所有对话的合计。',
        grandTotal: '全部对话合计',
        sessions: '对话',
        sessionCount: '{count} 个对话',
        empty: '还没有任何对话的 token 用量记录。',
        loading: '正在读取对话列表…',
        session: '对话',
        updated: '最近活动',
        uncached: '输入',
        grandCacheHit: '整体缓存命中率',
        breakdownHint: '这些数字来自 DSH 的 tokenUsage 投影，覆盖整段持久日志，含已被压缩的历史。',
        unreadable: '部分对话暂未返回用量，行内显示为 —。',

        // settings section: chart
        chartTitle: '用量构成',
        chartBySession: '各对话用量',
        chartHint: '色块宽度按占比；同一对话内缓存读取越多，实际计费越低。',
        chartEmpty: '暂无可绘制的用量。',
        cacheReadShort: '缓存读取',
        cacheWriteShort: '缓存写入',
        inputShort: '未缓存输入',
        outputShort: '输出',

        // settings section: the three summary cards
        cardTotal: '总用量',
        cardToday: '当日用量',
        cardTime: '总任务用时',
        cardTotalFoot: '{count} 个对话',
        cardTodayFoot: '本地时间 {date}',
        cardTimeFoot: '{count} 轮对话',
        cardTodayEmpty: '今天还没有用量',
        cardTimeEmpty: '还没有已完成的任务',
        todayHint: '当日用量与任务用时来自本插件注册的会话投影，按事件发生时间累计。',
        noDailyHint: '当日用量与任务用时需要插件的宿主半侧；当前只显示总用量。',
        trendLabel: '最近 {days} 天的每日用量，峰值 {peak} tokens',
      },
      en: {
        short: 'tokens',
        label: 'This conversation has used {total} tokens',
        used: 'Token usage',
        input: 'Input (uncached)',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        output: 'Output',
        total: 'Total',
        cacheHit: 'Cache hit rate',
        context: 'Current context',
        contextValue: '{used} / {window}',
        note: 'Whole-session totals including compacted history; context is the next request estimate.',

        // settings section
        nav: 'UsageAmount',
        title: 'UsageAmount',
        intro: 'Token usage per conversation; the total across every conversation sits on top.',
        grandTotal: 'All conversations',
        sessions: 'Conversations',
        sessionCount: '{count} conversations',
        empty: 'No conversation has recorded token usage yet.',
        loading: 'Reading the conversation list…',
        session: 'Conversation',
        updated: 'Last activity',
        uncached: 'Input',
        grandCacheHit: 'Overall cache hit rate',
        breakdownHint: 'These numbers come from the DSH tokenUsage projection over the whole durable log, including compacted history.',
        unreadable: 'Some conversations returned no usage; their row shows —.',

        // settings section: chart
        chartTitle: 'Usage composition',
        chartBySession: 'Usage by conversation',
        chartHint: 'Segment width follows share; more cache reads in a conversation means a lower billed rate.',
        chartEmpty: 'Nothing to chart yet.',
        cacheReadShort: 'Cache read',
        cacheWriteShort: 'Cache write',
        inputShort: 'Uncached input',
        outputShort: 'Output',

        // settings section: the three summary cards
        cardTotal: 'Total usage',
        cardToday: 'Today',
        cardTime: 'Total task time',
        cardTotalFoot: '{count} conversations',
        cardTodayFoot: 'local time {date}',
        cardTimeFoot: '{count} turns',
        cardTodayEmpty: 'No usage today',
        cardTimeEmpty: 'No finished task yet',
        todayHint: 'Today and task time come from this plugin’s own session projection, summed by event time.',
        noDailyHint: 'Today and task time need the plugin’s host half; only the total is shown.',
        trendLabel: 'Daily usage over the last {days} days, peak {peak} tokens',
      },
    };

    function template(text, params) {
      if (params === undefined || text === undefined) return text;
      return text.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
      );
    }

    /** Compact token text: 1234 -> "1.2K", 12345 -> "12.3K", 1234567 -> "1.2M". */
    function formatCompact(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (Math.abs(n) < 1000) return String(Math.round(n));
      const scaled = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
      if (Math.abs(n) < 1e6) return `${scaled(n / 1e3)}K`;
      if (Math.abs(n) < 1e9) return `${scaled(n / 1e6)}M`;
      return `${scaled(n / 1e9)}B`;
    }

    function formatExact(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString() : '—';
    }

    /**
     * Translation seat. The slot registration declares no locale namespace,
     * so the badge binds its own: `ctx.locale.bind` returns one stable
     * function that reads the live locale on every call, which keeps the
     * reading correct across a language switch without re-registering.
     */
    function makeT(ctx) {
      let bound;
      try {
        bound = ctx.locale === undefined || ctx.locale === null ? undefined : ctx.locale.bind(NS);
      } catch (error) {
        console.warn('[dsh-show-usage-amount] locale binding unavailable: ' + String(error));
      }
      return (key, params) => {
        let raw;
        try {
          raw = bound === undefined ? undefined : bound(key, params);
        } catch {
          raw = undefined;
        }
        // A dictionary miss echoes the key back; fall back to English then the key.
        const source = typeof raw === 'string' && raw !== key ? raw : dicts.en[key] ?? key;
        return template(source, params);
      };
    }

    const CSS = `
.${PREFIX}-root { flex: none; display: inline-flex; align-items: center; }
.${PREFIX}-trigger {
  box-sizing: border-box; border: 0; background: transparent; cursor: pointer; flex: none;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 1px 8px; border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-variant-numeric: tabular-nums;
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
}
.${PREFIX}-trigger:hover,
.${PREFIX}-trigger[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.${PREFIX}-icon { display: inline-grid; place-items: center; flex: none; opacity: .85; }
.${PREFIX}-value { font-weight: 500; }
.${PREFIX}-panel {
  position: fixed; z-index: 1100; box-sizing: border-box;
  width: min(276px, 100vw - 24px); padding: 12px;
  border: 0; border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 20px;
  max-height: var(--dsh-anchored-max-height, none);
  max-width: var(--dsh-anchored-max-width, none);
  overflow: hidden auto;
}
.${PREFIX}-title { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-total {
  margin-left: auto; color: var(--dsw-alias-label-primary); font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.${PREFIX}-rule { height: 1px; margin: 8px 0; background: var(--dsw-alias-border-l2); }
.${PREFIX}-rows { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; }
.${PREFIX}-rows dt { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-rows dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.${PREFIX}-note { margin-top: 10px; color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 16px; }

/* settings section */
.${PREFIX}-section {
  max-width: 760px; color: var(--dsw-alias-label-primary);
  flex-direction: column; gap: 12px; display: flex;
  /* Named container so the table can react to the pane width, not the viewport. */
  container: ${PREFIX}-section / inline-size;
}
.${PREFIX}-heading { margin: 0; font-size: 18px; font-weight: 600; }
.${PREFIX}-intro { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 13px; line-height: 20px; }
/* Three rounded tiles in one row: whole-history total, today's slice, and the
   accumulated time spent on finished tasks. */
.${PREFIX}-tiles {
  /* The first card is wider: it carries a ten-day sparkline behind its numbers,
     and the right two thirds of that card are reserved for the chart. */
  display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px;
}
.${PREFIX}-tile {
  box-sizing: border-box; display: flex; flex-direction: column; gap: 2px;
  min-width: 0; padding: 14px 16px;
  border-radius: var(--dsw-radius-lg, 12px);
  border: .5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
}
/* The wide card reserves its right two thirds for a background trend line: the
   numbers stay on the left third and the chart is absolutely positioned behind
   them, so it reads as the card's backdrop rather than a second stacked block. */
.${PREFIX}-tileWide { position: relative; overflow: hidden; }
.${PREFIX}-tileWide .${PREFIX}-tileBody { position: relative; z-index: 1; max-width: 34%; }
.${PREFIX}-trend {
  position: absolute; top: 10px; right: 12px; bottom: 10px; left: 34%;
  display: flex; pointer-events: none;
}
.${PREFIX}-trendSvg { width: 100%; height: 100%; overflow: visible; }
.${PREFIX}-trendGrid { stroke: var(--dsw-alias-border-l2); stroke-width: 1; stroke-dasharray: 3 4; opacity: .7; }
.${PREFIX}-trendBase { stroke: var(--dsw-alias-border-l2); stroke-width: 1; opacity: .9; }
/* The fill fades out downwards so the chart sits behind the numbers instead of
   reading as a solid block; the gradient is defined in the svg itself. */
.${PREFIX}-trendArea { fill: url(#${PREFIX}-trendFade); stroke: none; }
.${PREFIX}-trendLine {
  fill: none; stroke: var(--dsw-alias-state-business-primary);
  stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
}
/* The plot is stretched by preserveAspectRatio=none, so an svg <circle> would be
   squashed into a flat ellipse. This dot is plain CSS in the same box, so it
   stays round, and its percentage position lines up with the path's last point. */
.${PREFIX}-trendDot {
  position: absolute; width: 6px; height: 6px; margin: -3px 0 0 -3px;
  border-radius: 50%; background: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, #fff);
}
.${PREFIX}-tileBody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.${PREFIX}-tileLabel { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.${PREFIX}-tileValue {
  color: var(--dsw-alias-label-primary); font-size: 24px; font-weight: 600; line-height: 32px;
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${PREFIX}-tileFoot {
  color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 18px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${PREFIX}-summaryFoot { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.${PREFIX}-summaryFoot b { color: var(--dsw-alias-label-secondary); font-weight: 500; font-variant-numeric: tabular-nums; }
.${PREFIX}-tableWrap { border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); overflow-x: auto; }
.${PREFIX}-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.${PREFIX}-table th, .${PREFIX}-table td {
  text-align: left; padding: 9px 12px; border-bottom: .5px solid var(--dsw-alias-border-l2);
  white-space: nowrap;
}
.${PREFIX}-table thead th {
  color: var(--dsw-alias-label-tertiary); font-weight: 500; font-size: 12px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.${PREFIX}-table tbody tr:last-child td { border-bottom: 0; }
.${PREFIX}-table td.num, .${PREFIX}-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
/* The title column takes the leftover width and wraps instead of clipping. */
.${PREFIX}-table th.title, .${PREFIX}-table td.title {
  width: 100%; min-width: 160px; max-width: 0;
  white-space: normal; overflow-wrap: anywhere;
}
.${PREFIX}-sessionTitle { display: block; }
.${PREFIX}-muted { color: var(--dsw-alias-label-caption); }
.${PREFIX}-hint { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; }

/* A narrow pane cannot fit six columns; each row becomes a labelled card so no
   value is pushed off the right edge. */
@container ${PREFIX}-section (max-width: 560px) {
  .${PREFIX}-table thead { display: none; }
  .${PREFIX}-table, .${PREFIX}-table tbody, .${PREFIX}-table tr, .${PREFIX}-table td { display: block; width: auto; }
  .${PREFIX}-table tr {
    padding: 10px 12px; border-bottom: .5px solid var(--dsw-alias-border-l2);
  }
  .${PREFIX}-table tbody tr:last-child { border-bottom: 0; }
  .${PREFIX}-table td { border-bottom: 0; padding: 2px 0; display: flex; gap: 12px; align-items: baseline; }
  .${PREFIX}-table td.num { text-align: left; }
  .${PREFIX}-table td::before {
    content: attr(data-label); flex: none; min-width: 92px;
    color: var(--dsw-alias-label-tertiary); font-size: 12px;
  }
  .${PREFIX}-table td.title { font-weight: 500; margin-bottom: 4px; }
  .${PREFIX}-table td.title::before { content: none; }
  /* Three columns at this width give the small cards ~91px, which ellipsized the
     values themselves ("1,369,…"). The wide card keeps a full row so its total
     and chart stay whole; today and task time share the next row, where each
     gets enough width to show its number in full. */
  .${PREFIX}-tiles { gap: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .${PREFIX}-tileWide { grid-column: 1 / -1; }
  .${PREFIX}-tile { padding: 10px 12px; }
  .${PREFIX}-tileValue { font-size: 18px; line-height: 26px; }
  /* A 121px tile cannot hold "local time 2026-11-09" on one line; the footnote has
     to wrap rather than ellipsize the date away. */
  .${PREFIX}-tileFoot { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
}

/* settings section: chart */
.${PREFIX}-chart {
  box-sizing: border-box; border-radius: var(--dsw-radius-lg, 12px);
  border: .5px solid var(--dsw-alias-border-l2);
  padding: 14px 16px 16px; flex-direction: column; gap: 14px; display: flex;
}
.${PREFIX}-chartHead { display: flex; align-items: baseline; gap: 10px; }
.${PREFIX}-chartTitle { color: var(--dsw-alias-label-secondary); font-size: 13px; font-weight: 500; }
.${PREFIX}-chartMeta {
  margin-left: auto; color: var(--dsw-alias-label-caption);
  font-size: 12px; font-variant-numeric: tabular-nums;
}
.${PREFIX}-stack {
  display: flex; box-sizing: border-box; width: 100%;
  height: 10px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-interactive-bg-hover);
}
.${PREFIX}-legend {
  display: flex; flex-wrap: wrap; gap: 6px 18px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
}
.${PREFIX}-legendItem { display: inline-flex; align-items: center; gap: 6px; }
.${PREFIX}-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.${PREFIX}-legendValue { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.${PREFIX}-bars { display: flex; flex-direction: column; gap: 10px; }
.${PREFIX}-barRow { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.${PREFIX}-barHead {
  display: flex; align-items: baseline; gap: 10px;
  font-size: 12px; line-height: 18px; min-width: 0;
}
.${PREFIX}-barTitle {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.${PREFIX}-barValue {
  margin-left: auto; flex: none; color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/* display: flex is load-bearing: the fill is a flex child whose segments size
   themselves with percentage widths, and a block track would collapse it. */
.${PREFIX}-barTrack {
  display: flex; box-sizing: border-box; width: 100%;
  height: 8px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-interactive-bg-hover);
}
.${PREFIX}-barFill {
  display: flex; height: 100%; width: 100%;
  border-radius: 999px; overflow: hidden;
}
.${PREFIX}-seg { flex: none; height: 100%; min-width: 2px; }

/* Segment tones: cache reads are the cheap bulk, uncached input is billed at
   full rate, cache writes pay a premium, output is generated. */
.${PREFIX}-seg-cache, .${PREFIX}-dot-cache { background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-seg-input, .${PREFIX}-dot-input { background: var(--dsw-alias-state-business-primary); }
.${PREFIX}-seg-write, .${PREFIX}-dot-write { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-seg-output, .${PREFIX}-dot-output { background: var(--dsw-alias-state-done-primary); }
`;

    function injectStyles() {
      const tagId = `${PREFIX}/styles`;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = PREFIX;
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** Place the panel above the trigger, clamped inside the viewport. */
    function anchored(trigger, panel) {
      if (trigger === null || panel === null) return undefined;
      const anchor = trigger.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const margin = 12;
      const gap = 8;
      let top = anchor.top - box.height - gap;
      if (top < margin) top = Math.min(anchor.bottom + gap, window.innerHeight - box.height - margin);
      let left = anchor.left + anchor.width / 2 - box.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
      return { top: Math.round(Math.max(margin, top)), left: Math.round(left) };
    }

    /** One compact badge plus its click-open breakdown panel. */
    function UsageBadge(props) {
      const { useProjection, t } = props;
      const usage = useProjection === undefined ? undefined : useProjection('tokenUsage');
      const pressure = useProjection === undefined ? undefined : useProjection('contextPressure');
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState(undefined);
      const rootRef = useRef(null);
      const panelRef = useRef(null);

      const totals = useMemo(() => {
        if (usage === undefined || usage === null) return undefined;
        const input = Number(usage.uncachedInputTokens ?? 0);
        const cacheRead = Number(usage.cacheReadTokens ?? 0);
        const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
        const output = Number(usage.outputTokens ?? 0);
        const billedInput = input + cacheRead + cacheWrite;
        return {
          input,
          cacheRead,
          cacheWrite,
          output,
          billedInput,
          total: billedInput + output,
          cacheHit: billedInput === 0 ? undefined : (cacheRead / billedInput) * 100,
        };
      }, [usage]);

      useEffect(() => {
        if (!open) return undefined;
        const place = () => setPos(anchored(rootRef.current, panelRef.current));
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        const onPointerDown = (event) => {
          if (rootRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      if (totals === undefined) return null;

      const label = t('label', { total: formatExact(totals.total) });
      const icon = primitives === undefined ? null : h(primitives.IconDatabaseOutlineRegular, { size: 14 });

      const rows = [
        [t('input'), formatExact(totals.input)],
        [t('cacheRead'), formatExact(totals.cacheRead)],
        [t('cacheWrite'), formatExact(totals.cacheWrite)],
        [t('output'), formatExact(totals.output)],
        [t('total'), formatExact(totals.total)],
      ];

      const contextRow =
        pressure === undefined || pressure === null || pressure.projectedTokens === undefined
          ? null
          : [
              t('context'),
              t('contextValue', {
                used: formatCompact(pressure.projectedTokens),
                window: pressure.contextWindow === undefined ? '—' : formatCompact(pressure.contextWindow),
              }),
            ];

      const panel =
        open && createPortal !== undefined
          ? createPortal(
              h(
                'div',
                {
                  ref: panelRef,
                  className: `${PREFIX}-panel`,
                  role: 'dialog',
                  'aria-label': t('used'),
                  style: pos === undefined ? { visibility: 'hidden', top: 0, left: 0 } : pos,
                },
                h(
                  'div',
                  { className: `${PREFIX}-title` },
                  icon,
                  h('span', { children: t('used') }),
                  h('span', { className: `${PREFIX}-total`, children: formatCompact(totals.total) }),
                ),
                h('div', { className: `${PREFIX}-rule`, 'aria-hidden': true }),
                h(
                  'dl',
                  { className: `${PREFIX}-rows` },
                  rows.map(([name, value]) =>
                    h(Fragment, { key: name }, h('dt', { children: name }), h('dd', { children: value })),
                  ),
                ),
                contextRow === null
                  ? null
                  : h(
                      Fragment,
                      null,
                      h('div', { className: `${PREFIX}-rule`, 'aria-hidden': true }),
                      h(
                        'dl',
                        { className: `${PREFIX}-rows` },
                        h('dt', { children: contextRow[0] }),
                        h('dd', { children: contextRow[1] }),
                      ),
                    ),
                totals.cacheHit === undefined
                  ? null
                  : h(
                      Fragment,
                      null,
                      h('div', { className: `${PREFIX}-rule`, 'aria-hidden': true }),
                      h(
                        'dl',
                        { className: `${PREFIX}-rows` },
                        h('dt', { children: t('cacheHit') }),
                        h('dd', { children: `${Math.round(totals.cacheHit)}%` }),
                      ),
                    ),
                h('div', { className: `${PREFIX}-note`, children: t('note') }),
              ),
              document.body,
            )
          : null;

      const trigger = h(
        'button',
        {
          type: 'button',
          className: `${PREFIX}-trigger`,
          'aria-label': label,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
        h('span', { className: `${PREFIX}-icon`, 'aria-hidden': true, children: icon }),
        h('span', { className: `${PREFIX}-value`, children: formatCompact(totals.total) }),
        h('span', { children: t('short') }),
      );

      return h(
        'span',
        { ref: rootRef, className: `${PREFIX}-root` },
        primitives !== undefined && primitives.Tooltip !== undefined
          ? h(primitives.Tooltip, { label, side: 'top', delayMs: 300, disabled: open, portal: true, children: trigger })
          : trigger,
        panel,
      );
    }

    /**
     * Fold one session's `tokenUsage` value into the four billing buckets.
     * @param usage - the projection value, or undefined while it is absent.
     * @returns bucket totals, or undefined when the bucket shape is unusable.
     */
    function bucketsOf(usage) {
      if (usage === undefined || usage === null || typeof usage !== 'object') return undefined;
      const input = Number(usage.uncachedInputTokens ?? 0);
      const cacheRead = Number(usage.cacheReadTokens ?? 0);
      const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
      const output = Number(usage.outputTokens ?? 0);
      if (![input, cacheRead, cacheWrite, output].every(Number.isFinite)) return undefined;
      const billedInput = input + cacheRead + cacheWrite;
      return { input, cacheRead, cacheWrite, output, billedInput, total: billedInput + output };
    }

    /** Human date for a session row; empty when the row reports no activity. */
    function formatWhen(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return '';
      const date = new Date(n);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * Today's calendar day in this browser's time zone, as `YYYY-MM-DD`. The
     * Host folds day buckets with the same local-date shape, so the two agree
     * whenever both run in the same zone — which is the normal desktop case.
     * @param now - epoch milliseconds, defaulting to the current clock.
     * @returns the local day key.
     */
    function todayKey(now) {
      const date = new Date(now === undefined ? Date.now() : now);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /**
     * The last `count` local day keys, oldest first, ending on `now`'s day. The
     * trend line always spans a fixed number of days, so its shape stays
     * comparable between visits instead of rescaling to whatever happens to be
     * present in the projection.
     * @param now - epoch milliseconds; defaults to the clock.
     * @param count - how many days to emit.
     * @returns day keys shaped `YYYY-MM-DD`.
     */
    function recentDayKeys(now, count) {
      const base = new Date(now === undefined ? Date.now() : now);
      const keys = [];
      if (Number.isNaN(base.getTime())) return keys;
      for (let offset = count - 1; offset >= 0; offset -= 1) {
        // Noon keeps a DST transition from pushing the local date over midnight.
        const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset, 12);
        keys.push(todayKey(day.getTime()));
      }
      return keys;
    }

    /**
     * Compact elapsed time: 45s, 12m, 1h 20m, 2d 3h. Deliberately coarse —
     * the number answers "how much time did this cost me", not a stopwatch.
     * @param ms - elapsed milliseconds.
     * @returns the formatted duration, or an em dash when unusable.
     */
    function formatDuration(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return '—';
      const seconds = Math.round(n / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
      const days = Math.floor(hours / 24);
      const restHours = hours % 24;
      return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
    }

    /**
     * Fold one session's `usageAmountDaily` value into today's buckets plus the
     * accumulated task time. That projection is registered by this plugin's
     * host half; it publishes `{ days, activeMs, turns }` per conversation.
     * @param daily - the projection value, or undefined while it is absent.
     * @param day - the local day key to read out of `days`.
     * @returns today's buckets and task time, or undefined when the shape is unusable.
     */
    function dailyOf(daily, day) {
      if (daily === undefined || daily === null || typeof daily !== 'object') return undefined;
      const days = daily.days !== null && typeof daily.days === 'object' ? daily.days : {};
      // A conversation with no usage today still reports the projection, which
      // is how the section knows the host half is installed at all.
      const buckets = bucketsOf(days[day]) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, billedInput: 0, total: 0 };
      const activeMs = Number(daily.activeMs ?? 0);
      const turns = Number(daily.turns ?? 0);
      if (!Number.isFinite(activeMs) || !Number.isFinite(turns)) return undefined;
      return { buckets, activeMs: activeMs > 0 ? activeMs : 0, turns: turns > 0 ? turns : 0 };
    }

    /** How many days the sparkline behind the total card spans. */
    const TREND_DAYS = 10;

    /**
     * Roll the session list's per-session projection values into one total plus
     * rows. The list snapshot already carries every row's `projectionValues`
     * (`tokenUsage` is a summary key, so the Host includes it per conversation),
     * which lets settings aggregate from the root scope without mounting a
     * session-scoped provider for each conversation.
     * @param list - `useSessions` snapshot (`{ ids, byId, phase }`).
     * @param now - epoch milliseconds used to pick "today"; defaults to the clock.
     * @returns rows sorted by usage, plus the grand total; undefined while the list has no snapshot.
     */
    function aggregateSessions(list, now) {
      if (list === undefined || list === null || typeof list.byId !== 'object' || list.byId === null) return undefined;
      const ids = Array.isArray(list.ids) ? list.ids : Object.keys(list.byId);
      const day = todayKey(now);
      const rows = [];
      const grand = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, billedInput: 0, total: 0 };
      const today = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, billedInput: 0, total: 0 };
      // Sum every conversation's day buckets together before the trend line is
      // drawn: the card answers "how much did the whole installation use on
      // that day", not "how much did one conversation use".
      const byDay = {};
      let activeMs = 0;
      let turns = 0;
      let unreadable = 0;
      let daily = false;
      for (const id of ids) {
        const summary = list.byId[id];
        if (summary === undefined || summary === null) continue;
        const usage = summary.projectionValues?.tokenUsage;
        const buckets = bucketsOf(usage);
        if (buckets === undefined) unreadable += 1;
        else for (const key of Object.keys(grand)) grand[key] += buckets[key];

        const dailyValue = summary.projectionValues?.usageAmountDaily;
        const todayRow = dailyOf(dailyValue, day);
        if (todayRow !== undefined) {
          daily = true;
          for (const key of Object.keys(today)) today[key] += todayRow.buckets[key];
          activeMs += todayRow.activeMs;
          turns += todayRow.turns;
        }
        const days = dailyValue !== null && typeof dailyValue === 'object' ? dailyValue.days : undefined;
        if (days !== null && typeof days === 'object') {
          for (const key of Object.keys(days)) {
            const dayBuckets = bucketsOf(days[key]);
            if (dayBuckets === undefined) continue;
            const target = byDay[key] ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, billedInput: 0, total: 0 };
            for (const field of Object.keys(target)) target[field] += dayBuckets[field];
            byDay[key] = target;
          }
        }

        rows.push({
          id,
          title: summary.displayTitle ?? summary.title ?? id,
          parentId: summary.parentId,
          updatedAt: summary.updatedAt,
          running: summary.running === true,
          buckets,
          today: todayRow === undefined ? undefined : todayRow.buckets,
          activeMs: todayRow === undefined ? undefined : todayRow.activeMs,
        });
      }
      rows.sort((left, right) => {
        const delta = (right.buckets?.total ?? -1) - (left.buckets?.total ?? -1);
        return delta !== 0 ? delta : (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      });
      const trend = recentDayKeys(now, TREND_DAYS).map((key) => ({
        day: key,
        total: byDay[key]?.total ?? 0,
        buckets: byDay[key],
      }));
      return {
        rows,
        grand,
        today,
        trend,
        activeMs,
        turns,
        daily,
        day,
        unreadable,
        cacheHit: grand.billedInput === 0 ? undefined : (grand.cacheRead / grand.billedInput) * 100,
      };
    }

    /** Segment metadata shared by the stacked bar, the legend and the per-session bars. */
    const SEGMENTS = [
      { key: 'cacheRead', tone: 'cache', label: 'cacheReadShort' },
      { key: 'input', tone: 'input', label: 'inputShort' },
      { key: 'cacheWrite', tone: 'write', label: 'cacheWriteShort' },
      { key: 'output', tone: 'output', label: 'outputShort' },
    ];

    /**
     * One horizontal stack of the four billing buckets.
     * @param props - `buckets` (already folded), `t`, and an optional explicit scale.
     * @returns the stacked bar element.
     */
    function StackBar({ buckets, t, scale }) {
      const total = scale ?? buckets.total;
      const denominator = total <= 0 ? 1 : total;
      return h(
        'span',
        { className: `${PREFIX}-barFill`, role: 'img', 'aria-label': t('chartTitle') },
        SEGMENTS.map((segment) => {
          const value = buckets[segment.key];
          if (value <= 0) return null;
          return h('span', {
            key: segment.key,
            className: `${PREFIX}-seg ${PREFIX}-seg-${segment.tone}`,
            style: { width: `${(value / denominator) * 100}%` },
            title: `${t(segment.label)}: ${formatExact(value)}`,
          });
        }),
      );
    }

    /**
     * Settings chart: the overall bucket mix plus the busiest conversations,
     * each drawn as its own proportionally scaled bar.
     * @param props - aggregation summary and the translation seat.
     * @returns the chart block, or a hint when there is nothing to draw.
     */
    function UsageChart({ summary, t }) {
      const { rows, grand } = summary;
      const drawable = rows.filter((row) => row.buckets !== undefined && row.buckets.total > 0);

      if (drawable.length === 0) {
        return h(
          'div',
          { className: `${PREFIX}-chart` },
          h('p', { className: `${PREFIX}-hint`, children: t('chartEmpty') }),
        );
      }

      // Every conversation gets a bar: capping the list made the chart look
      // truncated against the table below it, which lists them all.
      const shown = drawable;
      const peak = shown.reduce((max, row) => Math.max(max, row.buckets.total), 0) || 1;

      const legend = h(
        'div',
        { className: `${PREFIX}-legend` },
        SEGMENTS.map((segment) =>
          h(
            'span',
            { key: segment.key, className: `${PREFIX}-legendItem` },
            h('span', { className: `${PREFIX}-dot ${PREFIX}-dot-${segment.tone}`, 'aria-hidden': true }),
            h('span', null, t(segment.label)),
            h('span', { className: `${PREFIX}-legendValue`, children: formatCompact(grand[segment.key]) }),
          ),
        ),
      );

      return h(
        'div',
        { className: `${PREFIX}-chart` },
        h(
          'div',
          { className: `${PREFIX}-chartHead` },
          h('span', { className: `${PREFIX}-chartTitle`, children: t('chartTitle') }),
          h('span', { className: `${PREFIX}-chartMeta`, children: formatExact(grand.total) }),
        ),
        h('span', { className: `${PREFIX}-stack` }, h(StackBar, { buckets: grand, t })),
        legend,
        h(
          'div',
          { className: `${PREFIX}-bars` },
          shown.map((row) =>
            h(
              'div',
              { key: row.id, className: `${PREFIX}-barRow` },
              h(
                'div',
                { className: `${PREFIX}-barHead` },
                h('span', { className: `${PREFIX}-barTitle`, title: row.title, children: row.title }),
                h('span', { className: `${PREFIX}-barValue`, children: formatExact(row.buckets.total) }),
              ),
              h(
                'span',
                { className: `${PREFIX}-barTrack` },
                // Bars share one scale (the busiest conversation) so relative
                // sizes stay comparable; the stack above is absolute.
                h(StackBar, { buckets: row.buckets, t, scale: peak }),
              ),
            ),
          ),
        ),
        h('p', { className: `${PREFIX}-hint`, children: t('chartHint') }),
      );
    }

    /**
     * A smoothed path through `points`, as cubic Bézier segments.
     *
     * Uses a monotone cubic Hermite spline (Fritsch–Carlson): the tangents are
     * limited so the curve never overshoots the data. That matters here because
     * a plain Catmull-Rom would bow *below* the baseline between two quiet days
     * and above the peak day's value — a chart that claims usage where there was
     * none. Where a run of days sits flat on zero the tangents collapse to zero
     * and the curve stays a straight line.
     * @param points - `[x, y]` pairs, oldest first.
     * @returns the `d` attribute of the path.
     */
    function smoothPath(points) {
      const round = (value) => Math.round(value * 100) / 100;
      if (points.length === 0) return '';
      if (points.length === 1) return `M${round(points[0][0])},${round(points[0][1])}`;
      if (points.length === 2) {
        const [[x0, y0], [x1, y1]] = points;
        return `M${round(x0)},${round(y0)} L${round(x1)},${round(y1)}`;
      }

      const count = points.length;
      const secants = [];
      for (let index = 0; index < count - 1; index += 1) {
        const dx = points[index + 1][0] - points[index][0];
        secants.push(dx === 0 ? 0 : (points[index + 1][1] - points[index][1]) / dx);
      }

      const tangents = new Array(count);
      tangents[0] = secants[0];
      tangents[count - 1] = secants[count - 2];
      for (let index = 1; index < count - 1; index += 1) {
        const before = secants[index - 1];
        const after = secants[index];
        if (before * after <= 0) {
          // A local peak or a flat run: a non-zero tangent here would bow the
          // curve away from the data on both sides.
          tangents[index] = 0;
        } else {
          const average = (before + after) / 2;
          // Fritsch–Carlson limiter: keep the tangent inside 3x the smaller
          // secant so a segment cannot overshoot its own endpoints.
          const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
          tangents[index] = Math.sign(average) * Math.min(Math.abs(average), limit);
        }
      }

      let path = `M${round(points[0][0])},${round(points[0][1])}`;
      for (let index = 0; index < count - 1; index += 1) {
        const [x0, y0] = points[index];
        const [x1, y1] = points[index + 1];
        const dx = (x1 - x0) / 3;
        path +=
          ` C${round(x0 + dx)},${round(y0 + tangents[index] * dx)}` +
          ` ${round(x1 - dx)},${round(y1 - tangents[index + 1] * dx)}` +
          ` ${round(x1)},${round(y1)}`;
      }
      return path;
    }

    /**
     * Ten-day usage sparkline. Drawn as an area plus a line inside a fixed
     * 0..100 box with `preserveAspectRatio="none"`, so the same markup fills any
     * card width; `vector-effect` keeps the stroke from being stretched with it.
     * Rendered as the wide card's background: CSS pins it to the right two
     * thirds and the numbers sit above it on the left third.
     * @param props - `trend` (oldest first) and `t`.
     * @returns the chart element, or null when there is no history to draw.
     */
    function TrendLine({ trend, t }) {
      if (!Array.isArray(trend) || trend.length === 0) return null;
      const peak = trend.reduce((max, point) => Math.max(max, point.total), 0);
      const scale = peak <= 0 ? 1 : peak;
      const step = trend.length === 1 ? 0 : 100 / (trend.length - 1);
      // Leave headroom at the top so the busiest day's peak is not clipped by
      // the card edge, and keep a zero day pinned to the baseline.
      const coords = trend.map((point, index) => [
        Math.round(index * step * 100) / 100,
        Math.round((100 - (point.total / scale) * 88) * 100) / 100,
      ]);
      const line = smoothPath(coords);
      const area = `${line} L100,100 L0,100 Z`;
      const last = coords[coords.length - 1];
      const label = t('trendLabel', { days: trend.length, peak: formatCompact(peak) });
      const gradientId = `${PREFIX}-trendFade`;

      return h(
        'span',
        { className: `${PREFIX}-trend`, 'aria-hidden': 'false' },
        h(
          'svg',
          {
            className: `${PREFIX}-trendSvg`,
            viewBox: '0 0 100 100',
            preserveAspectRatio: 'none',
            role: 'img',
            'aria-label': label,
          },
          h('title', null, label),
          h(
            'defs',
            null,
            // The box is stretched vertically, so the gradient must not follow
            // the shape: objectBoundingBox would smear it along the curve. User
            // space with a fixed 0..100 box keeps the fade anchored to the plot.
            h(
              'linearGradient',
              { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 100, gradientUnits: 'userSpaceOnUse' },
              h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-state-business-primary)', stopOpacity: 0.22 }),
              h('stop', { offset: '70%', stopColor: 'var(--dsw-alias-state-business-primary)', stopOpacity: 0.05 }),
              h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-state-business-primary)', stopOpacity: 0 }),
            ),
          ),
          [25, 50, 75].map((y) =>
            h('line', {
              key: `grid-${y}`,
              className: `${PREFIX}-trendGrid`,
              x1: 0,
              x2: 100,
              y1: y,
              y2: y,
              'vector-effect': 'non-scaling-stroke',
            }),
          ),
          h('path', { className: `${PREFIX}-trendArea`, d: area }),
          h('line', {
            className: `${PREFIX}-trendBase`,
            x1: 0,
            x2: 100,
            y1: 100,
            y2: 100,
            'vector-effect': 'non-scaling-stroke',
          }),
          h('path', {
            className: `${PREFIX}-trendLine`,
            d: line,
            'vector-effect': 'non-scaling-stroke',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
        ),
        // Positioned in CSS rather than drawn in the svg: the viewBox is stretched
        // non-uniformly, which would turn a circle into a flat ellipse.
        h('span', {
          className: `${PREFIX}-trendDot`,
          style: { left: `${last[0]}%`, top: `${last[1]}%` },
        }),
      );
    }

    /** The Settings → UsageAmount section: grand total on top, then one row per conversation. */
    function UsageAmountSection(props) {
      const { useSessions, t } = props;
      const list = useSessions === undefined ? undefined : useSessions((state) => state);
      const summary = useMemo(() => aggregateSessions(list), [list]);

      if (summary === undefined) {
        return h(
          'div',
          { className: `${PREFIX}-section` },
          h('h2', { className: `${PREFIX}-heading`, children: t('title') }),
          h('p', { className: `${PREFIX}-intro`, children: t('intro') }),
          h('p', { className: `${PREFIX}-hint`, children: t('loading') }),
        );
      }

      const { rows, grand, today, trend, activeMs, turns, daily, day, cacheHit, unreadable } = summary;

      // Three tiles in one row: the whole-history total, today's slice of it, and
      // how much wall time the finished tasks cost. `today` and the time need the
      // plugin's host projection, so both degrade to a dash when it is missing.
      const tiles = [
        {
          key: 'total',
          label: t('cardTotal'),
          value: formatExact(grand.total),
          foot: t('cardTotalFoot', { count: rows.length }),
          wide: true,
        },
        {
          key: 'today',
          label: t('cardToday'),
          value: daily ? formatExact(today.total) : '—',
          foot: daily ? t('cardTodayFoot', { date: day }) : t('cardTodayEmpty'),
        },
        {
          key: 'time',
          label: t('cardTime'),
          // Zero closed turns means there is no measured time yet — a literal
          // "0s" would read as a measurement rather than an absence.
          value: turns > 0 ? formatDuration(activeMs) : '—',
          foot: turns > 0 ? t('cardTimeFoot', { count: turns }) : t('cardTimeEmpty'),
        },
      ];

      const summaryCard = h(
        'div',
        { className: `${PREFIX}-tiles` },
        tiles.map((tile) =>
          h(
            'div',
            { key: tile.key, className: tile.wide === true ? `${PREFIX}-tile ${PREFIX}-tileWide` : `${PREFIX}-tile` },
            h(
              'span',
              { className: `${PREFIX}-tileBody` },
              h('span', { className: `${PREFIX}-tileLabel`, children: tile.label }),
              h('span', { className: `${PREFIX}-tileValue`, children: tile.value }),
              h('span', { className: `${PREFIX}-tileFoot`, children: tile.foot }),
            ),
            // The trend sits in the right two thirds of the wide card, behind
            // the numbers rather than beside them in a separate block.
            tile.wide === true && daily ? h(TrendLine, { trend, t }) : null,
          ),
        ),
      );

      const summaryFoot = h(
        'div',
        { className: `${PREFIX}-summaryFoot` },
        h('span', null, `${t('uncached')} `, h('b', null, formatExact(grand.input))),
        h('span', null, `${t('cacheRead')} `, h('b', null, formatExact(grand.cacheRead))),
        h('span', null, `${t('cacheWrite')} `, h('b', null, formatExact(grand.cacheWrite))),
        h('span', null, `${t('output')} `, h('b', null, formatExact(grand.output))),
        cacheHit === undefined
          ? null
          : h('span', null, `${t('grandCacheHit')} `, h('b', null, `${Math.round(cacheHit)}%`)),
        h('span', null, t('sessionCount', { count: rows.length })),
      );

      const table =
        rows.length === 0
          ? h('p', { className: `${PREFIX}-hint`, children: t('empty') })
          : h(
              'div',
              { className: `${PREFIX}-tableWrap` },
              h(
                'table',
                { className: `${PREFIX}-table` },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'title', children: t('session') }),
                    h('th', { className: 'num', children: t('input') }),
                    h('th', { className: 'num', children: t('cacheRead') }),
                    h('th', { className: 'num', children: t('output') }),
                    h('th', { className: 'num', children: t('total') }),
                    h('th', { className: 'num', children: t('updated') }),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((row) =>
                    h(
                      'tr',
                      { key: row.id },
                      h(
                        'td',
                        { className: 'title' },
                        h('span', { className: `${PREFIX}-sessionTitle`, title: row.title, children: row.title }),
                      ),
                      h('td', { className: 'num', 'data-label': t('input'), children: row.buckets === undefined ? '—' : formatExact(row.buckets.input) }),
                      h('td', { className: 'num', 'data-label': t('cacheRead'), children: row.buckets === undefined ? '—' : formatExact(row.buckets.cacheRead) }),
                      h('td', { className: 'num', 'data-label': t('output'), children: row.buckets === undefined ? '—' : formatExact(row.buckets.output) }),
                      h('td', { className: 'num', 'data-label': t('total'), children: row.buckets === undefined ? '—' : formatExact(row.buckets.total) }),
                      h('td', { className: `num ${PREFIX}-muted`, 'data-label': t('updated'), children: formatWhen(row.updatedAt) || '—' }),
                    ),
                  ),
                ),
              ),
            );

      return h(
        'div',
        { className: `${PREFIX}-section` },
        h('h2', { className: `${PREFIX}-heading`, children: t('title') }),
        h('p', { className: `${PREFIX}-intro`, children: t('intro') }),
        summaryCard,
        summaryFoot,
        h(UsageChart, { summary, t }),
        table,
        unreadable > 0 ? h('p', { className: `${PREFIX}-hint`, children: t('unreadable') }) : null,
        daily ? h('p', { className: `${PREFIX}-hint`, children: t('todayHint') }) : h('p', { className: `${PREFIX}-hint`, children: t('noDailyHint') }),
        h('p', { className: `${PREFIX}-hint`, children: t('breakdownHint') }),
      );
    }

    // ---- settings navigation icon ---------------------------------------------
    // The "UA" wordmark from src/icon.png, traced to a single path (see
    // src/icon-glyph.svg and the tracer notes in README). Inlined rather than
    // shipped as a file because the client bundle is served as one script and
    // `currentColor` lets the nav tint it for the active/inactive state.
    const GLYPH_VIEWBOX = '0 0 1103.5 872.11';
    const GLYPH_PATH =
      'M691.48,54.68L722.04,56.45 741.7,64.81 756.04,82.79 783.91,145.44 1047.02,787.41 1048.82,808 ' +
      '1040.46,813.28 1023.24,815.3 941.67,815.26 919.6,811.47 906.72,798.49 869.97,718.86 860.5,711.09 ' +
      '844.2,707.99 669.99,707.74 644.93,710.7 628.64,724.57 575.71,803.11 564.54,811.34 548.66,814.86 ' +
      '346.75,817.43 285.21,812.24 231.03,797.46 165.46,761.73 123.69,723.76 94.16,682.17 73.95,642.04 ' +
      '58.14,584.57 54.68,532 54.69,90.28 56.84,68.72 65.59,58.07 86.02,54.8 176.12,54.95 192.48,57.99 ' +
      '200.07,65.49 203.32,92.41 203.43,523.33 207.81,562.06 226.73,612.1 257.8,647.84 296.47,669.52 ' +
      '348.91,679.36 400.03,670.54 439.59,649.75 474.31,611.19 490.55,569.24 496.32,525.44 496.49,90.27 ' +
      '500.47,64.08 508.83,57.35 523.67,54.95Z' +
      'M646.39,184.45L653.99,189.7 666.46,213.32 787.61,501.65 814.53,568.79 815,578.27 808.83,584.38 ' +
      '659.38,586.78 644.72,584.33 637.8,577.37 642.87,510.36 642.87,199.1Z';

    /**
     * Navigation icon for the settings section. `settings.section.icon` is an
     * inline list slot: the shell renders it in a 14px flex box and passes
     * `{size, active}`, so this returns the bare glyph and takes its colour
     * from the surrounding text (`currentColor`).
     */
    function SectionIcon(props) {
      const size = props.size === undefined ? 16 : props.size;
      return h(
        'svg',
        {
          className: `${PREFIX}-icon`,
          viewBox: GLYPH_VIEWBOX,
          width: size,
          height: size,
          fill: 'currentColor',
          fillRule: 'evenodd',
          role: 'img',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', opacity: props.active === false ? 0.7 : 1 },
        },
        h('path', { d: GLYPH_PATH }),
      );
    }

    const name = 'dsh-show-usage-amount';
    // `slots` and `locale` are the only services this plugin touches.
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'dsh-show-usage-amount: styles');
      ctx.effect(
        () => ctx.locale.register(NS, { zh: dicts.zh, en: dicts.en }),
        'dsh-show-usage-amount: dictionaries',
      );

      const t = makeT(ctx);
      // `conversation.composer.dock` is the composer's bottom dock (a `list`
      // slot under the input card). Order 2 keeps this badge beside the
      // built-in statistics pills (activity 0, usage 1) without displacing them.
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'show-usage-amount', order: 2 },
          (props) => h(UsageBadge, { ...props, t }),
        ),
      );

      // Settings → UsageAmount. `settings.section` is a root-scope list owned by
      // ui-settings-general; the entry supplies the navigation label, and
      // `useSessions` (a root standard hook from ui-session) carries every
      // conversation's tokenUsage projection. Order 20 keeps it after the
      // built-in sections (general 0, models 10, plugins 15).
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'show-usage-amount', order: 20, label: () => t('nav') },
          (props) => h(UsageAmountSection, { ...props, t }),
        ),
      );

      // The nav icon for that section. The shell looks the icon up by the SAME
      // id as the section entry and silently falls back to a gear when nothing
      // matches, so this id must stay in sync with the registration above.
      // Registered under its own `inject` because the host may not declare the
      // slot at all (older builds); the settings page must still work then.
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register(
          { name: 'settings.section.icon', id: 'show-usage-amount', locale: NS },
          (props) => h(SectionIcon, props),
        ),
      );
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
