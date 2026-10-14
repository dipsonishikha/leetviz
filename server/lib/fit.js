// Growth-model fitting. A line-for-line port of fit() / space_class() in engine/tracer.py so
// server-measured languages are classified exactly like the in-browser Python engine.

const lgamma = (x) => (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x);

const MODELS = [
  ['O(1)', 0, () => 0],
  ['O(log n)', 1, (n) => Math.log(Math.log2(n) + 1)],
  ['O(√n)', 2, (n) => 0.5 * Math.log(n)],
  ['O(n)', 3, (n) => Math.log(n)],
  ['O(n log n)', 4, (n) => Math.log(n) + Math.log(Math.log2(n))],
  ['O(n²)', 5, (n) => 2 * Math.log(n)],
  ['O(n² log n)', 6, (n) => 2 * Math.log(n) + Math.log(Math.log2(n))],
  ['O(n³)', 7, (n) => 3 * Math.log(n)],
  ['O(2ⁿ)', 8, (n) => n * Math.log(2)],
  ['O(n!)', 9, (n) => lgamma(n + 1)],
];

export function fit(points, minY = 0) {
  let pts = points.filter(([n, y]) => y > minY && n >= 4);
  if (pts.length > 6) pts = pts.slice(-6);
  if (pts.length < 3) return null;
  const slopes = pts.slice(1).map(([n2, y2], i) => Math.log(y2 / pts[i][1]) / Math.log(n2 / pts[i][0]));
  if (slopes.at(-1) > 3.5 && slopes.at(-1) > slopes.at(-2) + 1) {
    const [[n1, y1], [n2, y2]] = pts.slice(-2);
    const base = (y2 / y1) ** (1 / (n2 - n1));
    const label = base >= 1.9 ? 'O(2ⁿ)' : `O(${base.toFixed(2)}ⁿ)`;
    return { label, rank: 8, base, logc: Math.log(y2) - n2 * Math.log(base), confidence: 'medium' };
  }
  const scored = [];
  for (const [label, rank, logf] of MODELS) {
    const diffs = pts.map(([n, y]) => Math.log(y) - logf(n));
    if (diffs.some((d) => !Number.isFinite(d))) continue;
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const std = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / diffs.length);
    scored.push({ std, rank, label, mean });
  }
  const best = Math.min(...scored.map((s) => s.std));
  const pick = scored.filter((s) => s.std <= best + 0.04).sort((a, b) => a.rank - b.rank)[0];
  return { label: pick.label, rank: pick.rank, logc: pick.mean, confidence: pick.std < 0.1 ? 'high' : pick.std < 0.25 ? 'medium' : 'low' };
}

export function spaceClass(res) {
  const mem = res.mem;
  let heap = null;
  if (mem.length) {
    if (Math.max(...mem.map(([, b]) => b)) < 2048) heap = { label: 'O(1)', rank: 0, logc: 0, confidence: 'medium' };
    else heap = fit(mem, 1024) || fit(mem, 0);
  }
  const stack = res.depth.length && Math.max(...res.depth.map(([, d]) => d)) > 8 ? fit(res.depth, 2) : null;
  if (stack && (!heap || stack.rank > heap.rank)) return { ...stack, via: 'recursion depth' };
  return heap ? { ...heap, via: res.memVia || 'heap' } : null;
}
