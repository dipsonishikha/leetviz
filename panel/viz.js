// Renders serialized Python values (see ser() in engine/tracer.py) as visual structures.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of children.flat(Infinity)) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Variables whose int value is probably an index into a sibling array/string.
export const INDEX_NAME = /^(i|j|k|l|r|lo|hi|low|high|left|right|mid|start|end|begin|p|q|p\d|ptr\w*|idx|index|slow|fast|cur|curr|pos|top|bottom|row|col|read|write|insert\w*|anchor)\d*$|_(i|idx|index|ptr|pos)$|^(i|j|k)_/i;
// var -> Set of array names it indexes, from analyzePointers(); unknown vars point at every array.
let pointerMap = {};
export function setPointerMap(m) { pointerMap = m || {}; }
export const pointsInto = (v, arr) => !pointerMap[v] || pointerMap[v].has(arr);

const PY_WORDS = new Set(['len', 'range', 'enumerate', 'and', 'or', 'not', 'in', 'is', 'if', 'else', 'for', 'while', 'return', 'None', 'True', 'False', 'self', 'min', 'max', 'abs', 'int', 'sum', 'sorted', 'reversed', 'zip']);

/**
 * Works out which arrays each variable is used to index, so `lo` is drawn under `potions`
 * and not under every array in the frame. Regex-level and best-effort:
 *   arr[i + 1]                  -> i indexes arr
 *   for i, x in enumerate(arr)  -> i indexes arr
 *   x = len(arr) / range(len(arr))
 *   mid = (lo + hi) // 2        -> links spread across assignments until nothing changes
 */
export function analyzePointers(code, lang = 'python3') {
  const links = {};
  const add = (v, arr) => {
    if (v === arr || PY_WORDS.has(v) || /^\d/.test(v)) return false;
    links[v] ||= new Set();
    if (links[v].has(arr)) return false;
    links[v].add(arr);
    return true;
  };
  const ids = (text) => (text.match(/[A-Za-z_]\w*/g) || []).filter((w) => !PY_WORDS.has(w));
  const comment = lang === 'python3' || lang === 'python' || lang === 'ruby' || lang === 'elixir' ? /#.*$/ : lang === 'erlang' ? /%.*$/ : lang === 'racket' ? /;.*$/ : /\/\/.*$/;
  const lines = code.split('\n').map((l) => l.replace(comment, ''));
  const assigns = [];
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z_]\w*)\s*\[([^\[\]]+)\]/g)) for (const v of ids(m[2])) add(v, m[1]);
    const en = line.match(/for\s+([A-Za-z_]\w*)\s*,.*\bin\s+enumerate\(\s*([A-Za-z_]\w*)/);
    if (en) add(en[1], en[2]);
    const rng = line.match(/for\s+([A-Za-z_]\w*)\s+in\s+range\((.*)\)/);
    if (rng) for (const m of rng[2].matchAll(/len\(\s*([A-Za-z_]\w*)\s*\)/g)) add(rng[1], m[1]);
    const asg = line.match(/^\s*([A-Za-z_][\w\s,]*?)\s*(?:[-+*\/%]|\/\/)?=(?!=)\s*(.+)$/);
    if (asg) {
      const targets = ids(asg[1]);
      const lens = [...asg[2].matchAll(/len\(\s*([A-Za-z_]\w*)\s*\)/g)].map((m) => m[1]);
      for (const t of targets) for (const arr of lens) add(t, arr);
      assigns.push([targets, ids(asg[2].replace(/len\(\s*[A-Za-z_]\w*\s*\)/g, ''))]);
    }
  }
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (const [targets, sources] of assigns) {
      const group = [...targets, ...sources];
      const arrs = new Set(group.flatMap((v) => [...(links[v] || [])]));
      for (const v of group) for (const arr of arrs) if (!(v in links) || links[v].size) changed = add(v, arr) || changed;
    }
  }
  return links;
}

export const GRID_PAIRS = [['i', 'j'], ['r', 'c'], ['row', 'col'], ['x', 'y'], ['i', 'k'], ['nr', 'nc'], ['ni', 'nj']];

export function summarize(v, max = 60) {
  if (!v) return '';
  let out;
  switch (v.t) {
    case 'prim': out = v.v; break;
    case 'str': out = JSON.stringify(v.v); break;
    case 'list': out = `[${v.items.map((x) => summarize(x, 20)).join(', ')}${v.len > v.items.length ? ', …' : ''}]`; break;
    case 'set': out = v.len ? `{${v.items.map((x) => summarize(x, 20)).join(', ')}}` : 'set()'; break;
    case 'dict': out = `{${v.entries.map(([k, x]) => `${k}: ${summarize(x, 20)}`).join(', ')}}`; break;
    case 'llist': out = v.nodes.map((n) => n.val).join(' → ') + (v.cycle !== null ? ' ↺' : v.more ? ' → …' : ' → None'); break;
    case 'tree': out = `TreeNode(${v.nodes[v.root]?.val})`; break;
    case 'obj': out = `${v.cls}(…)`; break;
    default: out = '?';
  }
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Render one stack frame's locals.
 * @param locals   {name: serialized}
 * @param prev     the same frame's locals at the previous step (for change highlighting) or null
 * @param bigTree  the largest tree anywhere on the call stack, so recursive frames can show
 *                 where their subtree sits inside the whole tree
 */
export function renderLocals(locals, prev, bigTree = null) {
  const names = Object.keys(locals);
  if (!names.length) return h('div', { class: 'muted small' }, 'no local variables yet');

  const ints = {};
  for (const n of names) if (locals[n].t === 'prim' && locals[n].num !== undefined && locals[n].num !== null) ints[n] = locals[n].num;

  // Linked-list / tree variables that point into another variable's structure render as chips.
  const nodeOwner = {};
  const llists = names.filter((n) => locals[n].t === 'llist').sort((a, b) => locals[b].nodes.length - locals[a].nodes.length);
  for (const n of llists) {
    const first = locals[n].nodes[0]?.id;
    const owner = llists.find((o) => o !== n && !nodeOwner[o] && locals[o].nodes.length > locals[n].nodes.length &&
      locals[o].nodes.some((x) => x.id === first));
    if (owner) nodeOwner[n] = owner;
  }
  const trees = names.filter((n) => locals[n].t === 'tree').sort((a, b) => Object.keys(locals[b].nodes).length - Object.keys(locals[a].nodes).length);
  for (const n of trees) {
    const owner = trees.find((o) => o !== n && !nodeOwner[o] && locals[o].nodes[locals[n].root] &&
      Object.keys(locals[o].nodes).length > Object.keys(locals[n].nodes).length);
    if (owner) nodeOwner[n] = owner;
  }

  const scalars = [];
  const structures = [];
  for (const name of names) {
    const v = locals[name];
    const old = prev ? prev[name] : undefined;
    const changed = prev && (old === undefined || !sameJSON(old, v));
    const isNew = prev && old === undefined;
    if (nodeOwner[name]) {
      const val = v.t === 'llist' ? v.nodes[0]?.val : v.nodes[v.root]?.val;
      scalars.push(scalarRow(name, h('span', { class: 'chip ptr' }, `→ node ${val} in ${nodeOwner[name]}`), changed, isNew));
    } else if (v.t === 'prim' || (v.t === 'str' && v.v.length > 60 && !hasPointers(name, v.v.length))) {
      scalars.push(scalarRow(name, h('span', { class: `val ${v.t}` }, v.t === 'str' ? JSON.stringify(v.v) : v.v,
        changed && old && old.t === v.t && old.t === 'prim' ? h('span', { class: 'was' }, ` was ${old.v}`) : null), changed, isNew));
    } else {
      structures.push(h('div', { class: `struct${changed ? ' changed' : ''}` },
        h('div', { class: 'struct-head' }, h('span', { class: 'var' }, name), h('span', { class: 'muted small' }, describeType(v)),
          isNew ? h('span', { class: 'tag new' }, 'new') : changed ? h('span', { class: 'tag' }, 'changed') : null),
        v.t === 'tree' && bigTree && bigTree !== v && bigTree.nodes[v.root] && Object.keys(bigTree.nodes).length > Object.keys(v.nodes).length
          ? renderTree(name, bigTree, locals, { [v.root]: [name] })
          : renderStructure(name, v, old, locals, ints)));
    }
  }

  function hasPointers(arrName, len) {
    return Object.entries(ints).some(([n, x]) => n !== arrName && INDEX_NAME.test(n) && x >= 0 && x <= len && pointsInto(n, arrName));
  }

  return h('div', { class: 'locals' },
    scalars.length ? h('div', { class: 'scalars' }, scalars) : null,
    structures);
}

function scalarRow(name, valueEl, changed, isNew) {
  return h('div', { class: `scalar${changed ? ' changed' : ''}${isNew ? ' is-new' : ''}` },
    h('span', { class: 'var' }, name), h('span', { class: 'eq' }, '='), valueEl);
}

function describeType(v) {
  switch (v.t) {
    case 'list': return `${v.kind} · len ${v.len}`;
    case 'str': return `str · len ${v.v.length}${v.more ? '+' : ''}`;
    case 'dict': return `${v.kind} · ${v.len} key${v.len === 1 ? '' : 's'}`;
    case 'set': return `set · ${v.len} item${v.len === 1 ? '' : 's'}`;
    case 'llist': return `linked list${v.cycle !== null ? ' · has cycle!' : ''}`;
    case 'tree': return `tree · ${Object.keys(v.nodes).length} nodes`;
    case 'obj': return v.cls;
    default: return '';
  }
}

function renderStructure(name, v, old, locals, ints) {
  switch (v.t) {
    case 'list': {
      const is2D = v.items.length > 0 && v.items.every((x) => x.t === 'list');
      return is2D ? renderGrid(v, old, ints) : renderArray(name, v.items, v.len, old?.t === 'list' ? old.items : null, ints);
    }
    case 'str': return renderArray(name, [...v.v].map((c) => ({ t: 'prim', v: c })), v.v.length, old?.t === 'str' ? [...old.v].map((c) => ({ t: 'prim', v: c })) : null, ints, true);
    case 'dict': return renderDict(v, old);
    case 'set': return renderSet(v, old);
    case 'llist': return renderLinked(name, v, locals);
    case 'tree': return renderTree(name, v, locals);
    case 'obj': return h('div', { class: 'obj' }, renderLocals(v.fields, old?.t === 'obj' ? old.fields : null));
    default: return h('span', {}, summarize(v));
  }
}

function renderArray(arrName, items, len, oldItems, ints, isString = false) {
  // Pointers: index-like int variables that land in [0, len] (len = one past the end).
  const pointers = {};
  for (const [n, x] of Object.entries(ints)) {
    if (n === arrName || !INDEX_NAME.test(n) || x < -1 || x > len || !pointsInto(n, arrName)) continue;
    (pointers[x] ||= []).push(n);
  }
  const showGhost = pointers[len] || pointers[-1];
  const cells = items.map((it, i) => {
    const changed = oldItems && (i >= oldItems.length || !sameJSON(oldItems[i], it));
    const ptr = pointers[i];
    return h('div', { class: `cell${changed ? ' changed' : ''}${ptr ? ' pointed' : ''}`, title: `${arrName}[${i}] = ${summarize(it, 200)}` },
      h('div', { class: 'cell-idx' }, i),
      h('div', { class: `cell-val${isString ? ' char' : ''}` }, it.t === 'list' || it.t === 'dict' || it.t === 'set' ? summarize(it, 14) : (it.t === 'str' ? JSON.stringify(it.v) : it.v)),
      h('div', { class: 'cell-ptr' }, ptr ? ptr.map((p) => h('span', { class: 'ptr-label' }, p)) : null));
  });
  if (len > items.length) cells.push(h('div', { class: 'cell more' }, h('div', { class: 'cell-idx' }, '…'), h('div', { class: 'cell-val' }, `+${len - items.length}`), h('div', { class: 'cell-ptr' })));
  if (showGhost) {
    for (const idx of [-1, len]) {
      if (!pointers[idx]) continue;
      const ghost = h('div', { class: 'cell ghost', title: `index ${idx} is outside ${arrName} — indexing it would raise IndexError` },
        h('div', { class: 'cell-idx' }, idx), h('div', { class: 'cell-val' }, '∅'),
        h('div', { class: 'cell-ptr' }, pointers[idx].map((p) => h('span', { class: 'ptr-label warn' }, p))));
      idx === -1 ? cells.unshift(ghost) : cells.push(ghost);
    }
  }
  if (!items.length && !showGhost) return h('div', { class: 'muted small' }, isString ? '""' : 'empty');
  return h('div', { class: 'array-wrap' }, h('div', { class: 'array' }, cells));
}

function renderGrid(v, old, ints) {
  // Highlight the cell addressed by a pair of int variables like (i, j) / (r, c).
  const marks = new Map();
  for (const [a, b] of GRID_PAIRS) {
    if (ints[a] === undefined || ints[b] === undefined) continue;
    const key = `${ints[a]},${ints[b]}`;
    marks.set(key, [...(marks.get(key) || []), `(${a},${b})`]);
  }
  const rowPtr = {};
  if (!marks.size) {
    for (const [n, x] of Object.entries(ints)) if (INDEX_NAME.test(n)) (rowPtr[x] ||= []).push(n);
  }
  const rows = v.items.map((row, r) => h('tr', {},
    h('th', {}, r, rowPtr[r] ? h('span', { class: 'ptr-label' }, rowPtr[r].join(',')) : null),
    row.items.map((cell, c) => {
      const oldCell = old?.items?.[r]?.items?.[c];
      const changed = old && !sameJSON(oldCell, cell);
      const mark = marks.get(`${r},${c}`);
      return h('td', { class: `${changed ? 'changed' : ''}${mark ? ' pointed' : ''}`, title: `[${r}][${c}]${mark ? ' ← ' + mark.join(' ') : ''}` },
        cell.t === 'str' ? cell.v : summarize(cell, 8));
    }),
    row.len > row.items.length ? h('td', { class: 'muted' }, '…') : null));
  const width = Math.max(...v.items.map((row) => row.items.length));
  const header = h('tr', {}, h('th', {}), Array.from({ length: width }, (_, c) => h('th', {}, c)));
  return h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' }, header, rows),
    v.len > v.items.length ? h('div', { class: 'muted small' }, `+${v.len - v.items.length} more rows`) : null);
}

function renderDict(v, old) {
  if (!v.entries.length) return h('div', { class: 'muted small' }, 'empty');
  const oldMap = new Map(old?.t === 'dict' ? old.entries.map(([k, x]) => [k, x]) : []);
  return h('table', { class: 'dict' }, v.entries.map(([k, x]) => {
    const isNew = old && !oldMap.has(k);
    const changed = old && !isNew && !sameJSON(oldMap.get(k), x);
    return h('tr', { class: isNew ? 'is-new' : changed ? 'changed' : '' },
      h('td', { class: 'dict-k' }, k), h('td', { class: 'dict-arrow' }, '→'), h('td', { class: 'dict-v' }, summarize(x, 80)));
  }), v.len > v.entries.length ? h('tr', {}, h('td', { class: 'muted', colspan: 3 }, `+${v.len - v.entries.length} more`)) : null);
}

function renderSet(v, old) {
  if (!v.items.length) return h('div', { class: 'muted small' }, 'empty set');
  const before = new Set(old?.t === 'set' ? old.items.map((x) => summarize(x)) : []);
  return h('div', { class: 'chips' }, v.items.map((x) => {
    const label = summarize(x, 30);
    return h('span', { class: `chip${old && !before.has(label) ? ' is-new' : ''}` }, label);
  }));
}

function renderLinked(name, v, locals) {
  const labels = {};
  for (const [n, other] of Object.entries(locals)) {
    if (other.t === 'llist' && other.nodes[0]) (labels[other.nodes[0].id] ||= []).push(n);
  }
  const parts = [];
  v.nodes.forEach((node, i) => {
    if (i) parts.push(h('span', { class: 'arrow' }, '→'));
    parts.push(h('div', { class: `lnode${labels[node.id]?.some((n) => n !== name) ? ' pointed' : ''}` },
      h('div', { class: 'lnode-val' }, node.val),
      h('div', { class: 'cell-ptr' }, (labels[node.id] || []).map((p) => h('span', { class: 'ptr-label' }, p)))));
  });
  if (v.cycle !== null) parts.push(h('span', { class: 'arrow warn' }, `↺ back to #${v.cycle} (${v.nodes[v.cycle].val})`));
  else parts.push(h('span', { class: 'arrow' }, '→'), h('span', { class: 'muted' }, v.more ? '…' : 'None'));
  return h('div', { class: 'array-wrap' }, h('div', { class: 'llist' }, parts));
}

function renderTree(name, v, locals, forced = null) {
  const labels = forced || {};
  if (!forced) for (const [n, other] of Object.entries(locals)) if (other.t === 'tree' && n !== name) (labels[other.root] ||= []).push(n);
  // In-order x position, depth y position.
  const pos = {};
  let x = 0;
  let maxDepth = 0;
  const walk = (id, d) => {
    const node = v.nodes[id];
    if (!node) return;
    walk(node.l, d + 1);
    pos[id] = { x: x++, d };
    maxDepth = Math.max(maxDepth, d);
    walk(node.r, d + 1);
  };
  walk(v.root, 0);
  const W = 34;
  const H = 46;
  const width = Math.max(x * W + 10, 60);
  const height = (maxDepth + 1) * H + 14;
  const cx = (id) => pos[id].x * W + W / 2 + 5;
  const cy = (id) => pos[id].d * H + 18;
  const edges = [];
  const nodes = [];
  for (const id of Object.keys(pos)) {
    const n = v.nodes[id];
    for (const c of [n.l, n.r]) if (c && pos[c]) edges.push(s('line', { x1: cx(id), y1: cy(id), x2: cx(c), y2: cy(c), class: 'tree-edge' }));
    const label = labels[id];
    nodes.push(s('g', { class: `tree-node${label ? ' pointed' : ''}` },
      s('title', {}, label ? `${n.val} ← ${label.join(', ')}` : String(n.val)),
      s('circle', { cx: cx(id), cy: cy(id), r: 13 }),
      s('text', { x: cx(id), y: cy(id) + 4, 'text-anchor': 'middle' }, String(n.val).slice(0, 4)),
      label ? s('text', { x: cx(id), y: cy(id) + 26, 'text-anchor': 'middle', class: 'tree-ptr' }, label.join(',')) : null));
  }
  return h('div', { class: 'array-wrap' }, s('svg', { width, height, class: 'tree' }, edges, nodes));
}
