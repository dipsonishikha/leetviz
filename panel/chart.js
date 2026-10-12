// Log-log line chart of a metric vs input size n, one line per approach.
// On log-log axes every polynomial is a straight line whose slope is its exponent,
// so O(n) and O(n²) separate visibly into different angles.
import { h, s } from './viz.js';

const M = { top: 14, right: 74, bottom: 34, left: 58 };

function ticks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) out.push(10 ** e);
  return out.filter((t) => t >= lo / 1.0001 && t <= hi * 1.0001);
}

export function fmtNum(v) {
  if (v === null || v === undefined || !isFinite(v)) return '∞';
  if (v >= 1e6 || (v > 0 && v < 1e-2)) {
    const e = Math.floor(Math.log10(v));
    return `${(v / 10 ** e).toFixed(1)}×10${sup(e)}`;
  }
  if (v >= 1000) return Math.round(v).toLocaleString('en-US');
  if (Number.isInteger(v)) return String(v);
  return v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
export const sup = (e) => String(e).split('').map((c) => SUP[c]).join('');

/**
 * @param series [{name, slot, points:[[n,y]], label}]  slot = categorical color slot 1..4
 * @param opts   {yLabel, format(y) -> string}
 */
export function lineChart(series, opts) {
  const live = series.filter((sr) => sr.points.length);
  const wrap = h('div', { class: 'chart' });
  if (!live.length) {
    wrap.append(h('div', { class: 'muted small chart-empty' }, 'No measurements for this metric.'));
    return wrap;
  }
  const W = 560;
  const H = 250;
  const all = live.flatMap((sr) => sr.points);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]).filter((y) => y > 0);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys) / 1.5;
  const y1 = Math.max(...ys) * 1.5;
  const X = (n) => M.left + (Math.log(n / x0) / Math.log(x1 / x0 || 2)) * (W - M.left - M.right);
  const Y = (y) => H - M.bottom - (Math.log(Math.max(y, y0) / y0) / Math.log(y1 / y0)) * (H - M.top - M.bottom);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${opts.yLabel} vs n, log-log` });
  for (const t of ticks(y0, y1)) {
    svg.append(s('line', { x1: M.left, x2: W - M.right, y1: Y(t), y2: Y(t), class: 'grid-line' }),
      s('text', { x: M.left - 6, y: Y(t) + 3, 'text-anchor': 'end', class: 'axis-text' }, opts.format(t)));
  }
  const xt = [...new Set(xs)].sort((a, b) => a - b);
  const step = Math.ceil(xt.length / 8);
  xt.forEach((n, i) => {
    if (i % step) return;
    svg.append(s('text', { x: X(n), y: H - M.bottom + 15, 'text-anchor': 'middle', class: 'axis-text' }, fmtNum(n)));
  });
  svg.append(s('line', { x1: M.left, x2: W - M.right, y1: H - M.bottom, y2: H - M.bottom, class: 'axis-line' }),
    s('text', { x: (M.left + W - M.right) / 2, y: H - 4, 'text-anchor': 'middle', class: 'axis-title' }, 'input size n (log scale)'));

  const ends = [];
  for (const sr of live) {
    const pts = sr.points.filter((p) => p[1] > 0);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    svg.append(s('path', { d, class: 'series-line', style: `stroke: var(--series-${sr.slot})` }));
    for (const p of pts) svg.append(s('circle', { cx: X(p[0]), cy: Y(p[1]), r: 3, class: 'series-dot', style: `fill: var(--series-${sr.slot})` }));
    const last = pts[pts.length - 1];
    ends.push({ x: X(last[0]) + 6, y: Y(last[1]) + 3, label: sr.label });
  }
  // Direct labels at each line's end, top to bottom, pushed down just enough not to overlap.
  ends.sort((a, b) => a.y - b.y);
  let prevY = -Infinity;
  for (const e of ends) {
    const y = Math.max(e.y, prevY + 12);
    prevY = y;
    svg.append(s('text', { x: e.x, y, class: 'direct-label' }, e.label));
  }

  // Hover layer: crosshair at the nearest measured n, tooltip listing every series there.
  const cross = s('line', { y1: M.top, y2: H - M.bottom, class: 'crosshair', visibility: 'hidden' });
  const hover = s('rect', { x: M.left, y: M.top, width: W - M.left - M.right, height: H - M.top - M.bottom, fill: 'transparent' });
  svg.append(cross, hover);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  hover.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const n = xt.reduce((best, v) => (Math.abs(X(v) - px) < Math.abs(X(best) - px) ? v : best), xt[0]);
    cross.setAttribute('x1', X(n));
    cross.setAttribute('x2', X(n));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', { class: 'tip-head' }, `n = ${fmtNum(n)}`),
      ...live.map((sr) => {
        const p = sr.points.find((q) => q[0] === n);
        return h('div', { class: 'tip-row' }, h('span', { class: 'swatch', style: { background: `var(--series-${sr.slot})` } }),
          h('span', {}, sr.name), h('span', { class: 'tip-val' }, p ? opts.format(p[1]) : '—'));
      }));
    tip.hidden = false;
    const left = (X(n) / W) * rect.width;
    tip.style.left = `${Math.min(left + 12, rect.width - 170)}px`;
    tip.style.top = '8px';
  });
  hover.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });

  const legend = h('div', { class: 'legend' }, live.map((sr) =>
    h('span', { class: 'legend-item' }, h('span', { class: 'swatch', style: { background: `var(--series-${sr.slot})` } }), sr.name)));
  wrap.append(legend, h('div', { class: 'chart-box' }, svg, tip));
  return wrap;
}
