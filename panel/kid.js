// "Simple" view: explains each step with pictures and plain words, so a beginner (or a
// five-year-old) can follow along. Arrays are blocks, index variables are markers that hop
// between blocks, hashmaps are notebooks, stacks are piles of plates, linked lists are
// trains, and recursive calls are "helpers" waiting for an answer.
import { h, s, summarize, INDEX_NAME, GRID_PAIRS, pointsInto } from './viz.js';

const CELL = 58; // block width + gap, used to slide markers between blocks

/** A pointer marker: the variable's name on a tag with a caret pointing down at its block. */
function marker(name, extra = {}) {
  return h('div', { class: `kid-marker${extra.hop ? ' hop' : ''}`, 'data-var': name, style: extra.style || {}, title: extra.title || name },
    h('span', { class: 'kid-marker-name' }, name), h('span', { class: 'kid-marker-caret' }));
}

// ------------------------------------------------------------------ words

const KID_O = {
  'O(1)': 'does the same amount of work, no matter how big the puzzle is',
  'O(log n)': 'cuts the puzzle in half again and again',
  'O(√n)': 'grows slowly',
  'O(n)': 'looks at each item once',
  'O(n log n)': 'sorts things first, then looks smartly',
  'O(n²)': 'checks every item against every other item',
  'O(n² log n)': 'checks every pair, and then some',
  'O(n³)': 'checks every group of three items',
  'O(n!)': 'tries every possible order',
};
/** What a complexity class means, in plain words. */
export function kidO(cls) {
  if (!cls) return 'is not measured yet';
  if (cls.base) return 'multiplies its work with every new item';
  return KID_O[cls.label] || cls.label;
}

const pretty = (code) => String(code)
  .replace(/\s\/\/\s/g, ' ÷ ').replace(/\s\*\s/g, ' × ').replace(/\s>=\s/g, ' ≥ ').replace(/\s<=\s/g, ' ≤ ')
  .replace(/\s!=\s/g, ' ≠ ').replace(/\s==\s/g, ' = ')
  .replace(/\bnot ([A-Za-z_]\w*)\b(?!\s*(?:in\b|\(|\[|\.))/g, '$1 is empty').replace(/\bTrue\b/g, 'True').replace(/\bNone\b/g, 'nothing');

// Values from every language: Python says None/True/False, the others null/nil/true/false
// (their tracers tag them with k: 'null' | 'bool').
const isNull = (v) => v?.t === 'prim' && (v.k === 'null' || v.v === 'None');
const isTrue = (v) => v?.t === 'prim' && (v.v === 'True' || (v.k === 'bool' && v.v === 'true'));
const isFalse = (v) => v?.t === 'prim' && (v.v === 'False' || (v.k === 'bool' && v.v === 'false'));

const plainValue = (v) => {
  if (!v) return '?';
  if (v.t === 'prim') return isNull(v) ? 'nothing' : isTrue(v) ? 'True ✅' : isFalse(v) ? 'False ❌' : v.v;
  return summarize(v, 40);
};

const code = (text) => h('code', { class: 'kid-code' }, pretty(text));
const big = (text) => h('b', { class: 'kid-val' }, text);

function frameOf(step) {
  return step.stack[step.stack.length - 1];
}

/** Locals of the same frame one step earlier (null when the frame just started). */
export function previousLocals(t, i) {
  const cur = t.steps[i];
  const prev = t.steps[i - 1];
  const d = cur.stack.length - 1;
  if (!prev || !prev.stack[d] || prev.stack[d].fn !== cur.stack[d].fn) return null;
  if (cur.event === 'call') return null;
  return prev.stack[d].locals || null;
}

/** The step whose line "just ran" to produce step i (what the simple view talks about). */
export function actionStep(t, i) {
  return i > 0 ? t.steps[i - 1] : null;
}

function friendlyError(cur, prev) {
  const exc = cur.exc || '';
  const locals = frameOf(cur).locals || {};
  if (/^IndexError|out of range|IndexOutOfBounds|index out of bounds|ArgumentOutOfRange|RangeError/i.test(exc)) {
    for (const [name, idx] of prev?.info?.looks || []) {
      const v = locals[name];
      const len = v?.len ?? (v?.t === 'str' ? v.v.length : null);
      if (len !== null && len !== undefined && typeof idx === 'number' && (idx >= len || idx < -len)) {
        return [`Oops! We tried to open box `, big(`#${idx}`), ` of `, code(name), `, but it only has `,
          len ? ['boxes ', big(`#0`), ' to ', big(`#${len - 1}`)] : 'no boxes at all', '.'];
      }
    }
    return ['Oops! We tried to open a box that doesn’t exist.'];
  }
  if (/Segmentation fault|invalid memory/i.test(exc)) return ['Oops! We reached for something that isn’t there — maybe a box past the end, or the next train car after the last one.'];
  if (exc.startsWith('KeyError')) return ['Oops! We looked in the notebook for ', big(exc.replace(/^KeyError:\s*/, '')), ', but that page is empty.'];
  if (/^ZeroDivisionError|ArithmeticException|DivideByZero|division by zero/i.test(exc)) return ['Oops! We tried to divide by zero — nobody can do that!'];
  if (/^RecursionError|StackOverflow|stack overflow/i.test(exc)) return ['The helpers kept calling more helpers forever and never finished!'];
  if (/NoneType|NullPointer|NullReference|null pointer|nil/i.test(exc)) return ['Oops! We tried to use something that is empty (nothing / None) — like going to the next train car after the last one.'];
  return ['Oops! ', exc];
}

/**
 * Plain-language description of what just happened at step i.
 * @returns {tone: 'info'|'yes'|'no'|'done'|'error'|'call', parts: Node[]}
 */
export function narrate(t, i) {
  const cur = t.steps[i];
  const prev = t.steps[i - 1];
  const f = frameOf(cur);
  const argList = (locals) => Object.entries(locals || {})
    .filter(([, v]) => !(v.t === 'prim' && v.v.startsWith('<function')))
    .slice(0, 3).map(([k, v]) => `${k} = ${summarize(v, 22)}`).join(', ');

  if (i === 0) return { tone: 'info', parts: ['Let’s start! We were given ', code(argList(f.locals))] };
  if (cur.event === 'exception') return { tone: 'error', parts: friendlyError(cur, prev) };
  if (cur.event === 'call') {
    return { tone: 'call', parts: ['Ask a helper to solve a smaller piece: ', code(`${f.fn}(${argList(f.locals)})`), ' — and wait for its answer.'] };
  }
  if (prev.event === 'return' && cur.stack.length < prev.stack.length) {
    return { tone: 'call', parts: ['The helper came back with the answer ', big(plainValue(prev.ret)), '.'] };
  }
  if (prev.event === 'call') {
    return cur.stack.length > 1
      ? { tone: 'call', parts: ['The helper starts working on ', code(`${f.fn}(${argList(f.locals)})`)] }
      : { tone: 'info', parts: ['Ready! Press ', big('▶|'), ' to run the first line.'] };
  }
  if (prev.event === 'line' && prev.info) {
    const said = describe(prev, cur);
    if (said) return said;
  }
  const line = (t.code.split('\n')[(prev?.line || cur.line) - 1] || '').trim();
  if (prev.event === 'line' && !prev.info) {
    const said = describeChanges(prev, cur, line);
    if (said) return said;
  }
  return { tone: 'info', parts: ['Ran ', code(line)] };
}

/**
 * Language-independent narration from what changed between two steps (used when the engine
 * has no per-line `info`, i.e. every language except Python).
 */
function describeChanges(prev, cur, line) {
  if (cur.stack.length !== prev.stack.length) return null;
  const before = frameOf(prev).locals || {};
  const after = frameOf(cur).locals || {};
  const said = [];
  for (const [k, v] of Object.entries(after)) {
    const o = before[k];
    if (o && JSON.stringify(o) === JSON.stringify(v)) continue;
    const part = describeChange(k, o, v);
    if (part) said.push(part);
  }
  if (said.length) {
    return { tone: 'info', parts: said.slice(0, 2).flatMap((p, i) => (i ? ['; ', ...p] : p)).concat(said.length > 2 ? [` (and ${said.length - 2} more)`] : []) };
  }
  // Nothing changed: a test that decided where to go next.
  const test = line.match(/^(?:\}\s*)?(if|else if|elif|while|for)\b\s*\(?(.*?)\)?\s*(?:\{|:|then|do)?\s*$/);
  if (test && test[1] !== 'for') {
    const inside = cur.line > prev.line && cur.line <= prev.line + 1;
    return { tone: inside ? 'yes' : 'no', parts: [test[1] === 'while' ? 'Keep going? ' : 'Is ', code(test[2] || line), '?', ' ', big(inside ? 'Yes ✅' : 'No ❌')] };
  }
  return null;
}

function describeChange(k, o, v) {
  if (!o) {
    if (v.t === 'prim') return [code(k), ' = ', big(plainValue(v))];
    if ((v.t === 'list' || v.t === 'dict' || v.t === 'set') && v.len === 0) {
      return [v.t === 'dict' ? 'Open a new empty notebook called ' : v.t === 'set' ? 'Get an empty bag called ' : 'Make an empty list called ', code(k)];
    }
    return [code(k), ' = ', big(summarize(v, 30))];
  }
  if (v.t === 'prim' && o.t === 'prim') {
    if (typeof v.num === 'number' && typeof o.num === 'number' && v.num - o.num === 1) return [code(k), ' goes up by 1: ', big(`${o.v} → ${v.v}`)];
    if (typeof v.num === 'number' && typeof o.num === 'number' && o.num - v.num === 1) return [code(k), ' goes down by 1: ', big(`${o.v} → ${v.v}`)];
    return [code(k), ' becomes ', big(plainValue(v)), ` (was ${plainValue(o)})`];
  }
  if (v.t === 'dict' && o.t === 'dict') {
    const old = new Map(o.entries.map(([key, x]) => [key, JSON.stringify(x)]));
    const hit = v.entries.find(([key, x]) => old.get(key) !== JSON.stringify(x));
    if (hit) return ['Write in the notebook ', code(k), ': ', big(`${hit[0]} ➜ ${summarize(hit[1], 20)}`)];
    if (v.len < o.len) return ['Tear a page out of the notebook ', code(k)];
  }
  if (v.t === 'set' && o.t === 'set') {
    const old = new Set(o.items.map((x) => JSON.stringify(x)));
    const added = v.items.find((x) => !old.has(JSON.stringify(x)));
    if (added && v.len > o.len) return ['Put ', big(summarize(added, 16)), ' into the bag ', code(k)];
    if (v.len < o.len) return ['Take something out of the bag ', code(k)];
  }
  if (v.t === 'list' && o.t === 'list') {
    if (v.len === o.len + 1) {
      const first = JSON.stringify(v.items[0]) !== JSON.stringify(o.items[0]) && v.items.length > 1 && JSON.stringify(v.items[1]) === JSON.stringify(o.items[0]);
      return first ? ['Put ', big(summarize(v.items[0], 16)), ' at the front of ', code(k)] : ['Put ', big(summarize(v.items[v.items.length - 1], 16)), ' at the end of ', code(k)];
    }
    if (v.len === o.len - 1) {
      const fromFront = o.items.length > 1 && JSON.stringify(v.items[0]) === JSON.stringify(o.items[1]);
      return fromFront ? ['Take the first item out of ', code(k)] : ['Take the last item off ', code(k)];
    }
    if (v.len === o.len) {
      const j = v.items.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(o.items[i]));
      if (j >= 0) return ['Put ', big(summarize(v.items[j], 16)), ' into box ', big(`#${j}`), ' of ', code(k)];
    }
    return [code(k), ` now has ${v.len} item${v.len === 1 ? '' : 's'}`];
  }
  if (v.t === 'str' && o.t === 'str') return [code(k), ' becomes ', big(`“${v.v.slice(0, 30)}”`)];
  if (v.t === 'llist' || v.t === 'tree') return [code(k), ' now points to node ', big(v.t === 'llist' ? (v.nodes[0]?.val ?? 'nothing') : v.nodes[v.root]?.val)];
  if (isNull(v)) return [code(k), ' now points to nothing'];
  return [code(k), ' changed'];
}

function describe(prev, cur) {
  const info = prev.info;
  const before = frameOf(prev).locals || {};
  const after = cur.stack.length === prev.stack.length ? frameOf(cur).locals || {} : {};
  const sameFrame = cur.stack.length === prev.stack.length;

  switch (info.kind) {
    case 'If':
    case 'While': {
      const q = info.subst ?? info.test;
      const sides = info.sides ? pretty(info.sides.join(' ')) : null;
      const showSides = sides && pretty(q) !== sides;
      const ask = [/ is empty/.test(pretty(q)) ? 'Check: ' : 'Is ', code(q), '?', showSides ? [' That’s ', code(sides), '.'] : ''];
      if (info.value === undefined) return { tone: 'info', parts: ['Checking: ', code(info.test)] };
      if (info.kind === 'While') {
        return info.value
          ? { tone: 'yes', parts: ['Keep going? ', ...ask, ' ', big('Yes ✅'), ' → go around the loop again.'] }
          : { tone: 'no', parts: ['Keep going? ', ...ask, ' ', big('No ❌'), ' → the loop stops.'] };
      }
      return info.value
        ? { tone: 'yes', parts: [...ask, ' ', big('Yes ✅')] }
        : { tone: 'no', parts: [...ask, ' ', big('No ❌'), ' → skip it.'] };
    }
    case 'For': {
      const [first, last] = info.body || [0, 0];
      const inBody = sameFrame && cur.line >= first && cur.line <= last;
      if (!inBody) return { tone: 'done', parts: [`We’ve gone through every ${before[info.iter]?.t === 'str' ? 'letter' : 'item'} in `, code(info.iter), '.'] };
      const names = info.target.replace(/[()]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
      const vals = names.map((n) => `${n} = ${plainValue(after[n])}`).join(', ');
      const en = info.iter.match(/^enumerate\((\w+)\)$/);
      if (en && names.length === 2) {
        return { tone: 'info', parts: ['Next box of ', code(en[1]), ': box ', big(`#${plainValue(after[names[0]])}`), ' holds ', big(plainValue(after[names[1]])), ` (${vals})`] };
      }
      if (names.length === 1 && before[info.iter]?.t === 'str') return { tone: 'info', parts: ['Next letter of ', code(info.iter), ': ', big(plainValue(after[names[0]]))] };
      if (/^range\(/.test(info.iter)) return { tone: 'info', parts: ['Count to the next number: ', big(vals)] };
      return { tone: 'info', parts: ['Next item from ', code(info.iter), ': ', big(vals)] };
    }
    case 'Assign':
    case 'AnnAssign': {
      const target = info.target.replace(/^\(|\)$/g, '');
      const sub = target.match(/^(\w+)\[(.+)\]$/);
      if (sub) {
        const obj = after[sub[1]];
        const key = (info.looks || []).find((l) => l[0] === sub[1])?.[1];
        if (obj?.t === 'dict') {
          const entry = obj.entries.find(([k]) => k === JSON.stringify(key) || k === String(key) || k === `'${key}'`);
          return { tone: 'info', parts: ['Write in the notebook ', code(sub[1]), ': ', big(`${key ?? sub[2]} ➜ ${entry ? summarize(entry[1], 20) : pretty(info.subst ?? info.expr)}`)] };
        }
        return { tone: 'info', parts: ['Put ', big(pretty(info.subst ?? info.expr)), ' into box ', big(`#${key ?? sub[2]}`), ' of ', code(sub[1])] };
      }
      const names = target.split(',').map((x) => x.trim());
      if (names.length === 1) {
        const v = after[names[0]];
        if (v && (v.t === 'list' || v.t === 'dict' || v.t === 'set') && (v.len === 0)) {
          const what = v.t === 'dict' ? 'Open a new empty notebook called ' : v.t === 'set' ? 'Get an empty bag called ' : 'Make an empty list called ';
          return { tone: 'info', parts: [what, code(names[0])] };
        }
        if (v && (v.t === 'list' || v.t === 'dict' || v.t === 'set')) {
          const what = v.t === 'dict' ? ['Fill a notebook called ', ` with ${v.len} page${v.len === 1 ? '' : 's'}`] : v.t === 'set' ? ['Fill a bag called ', ` with ${v.len} item${v.len === 1 ? '' : 's'}`] : ['Make a list called ', ` with ${v.len} item${v.len === 1 ? '' : 's'}`];
          return { tone: 'info', parts: [what[0], code(names[0]), what[1]] };
        }
        const val = plainValue(v);
        const expr = pretty(info.subst ?? info.expr);
        const showMath = expr !== val && !/^[\w.]+$/.test(info.expr);
        return { tone: 'info', parts: [code(names[0]), ' becomes ', showMath ? [code(expr), ' = '] : '', big(val),
          / ÷ /.test(expr) ? ' (divide and round down)' : ''] };
      }
      return { tone: 'info', parts: names.map((n, k) => [k ? ', ' : '', code(n), ' = ', big(plainValue(after[n]))]) };
    }
    case 'AugAssign': {
      const n = info.target;
      const was = plainValue(before[n]);
      const now = plainValue(after[n]);
      const by = pretty(info.subst ?? info.expr);
      if (info.op === 'Add') return { tone: 'info', parts: [code(n), ' goes up by ', big(by), ': ', big(`${was} → ${now}`)] };
      if (info.op === 'Sub') return { tone: 'info', parts: [code(n), ' goes down by ', big(by), ': ', big(`${was} → ${now}`)] };
      return { tone: 'info', parts: [code(n), ' changes: ', big(`${was} → ${now}`)] };
    }
    case 'Return': {
      const val = cur.event === 'return' ? plainValue(cur.ret) : pretty(info.subst ?? info.expr);
      return prev.stack.length === 1
        ? { tone: 'done', parts: ['All done! The answer is ', big(val)] }
        : { tone: 'call', parts: ['This helper is finished and hands back ', big(val)] };
    }
    case 'Expr': {
      const obj = info.obj ? code(info.obj) : null;
      const arg = info.args?.[0] !== undefined ? big(pretty(info.args[0])) : null;
      switch (info.method) {
        case 'append': return { tone: 'info', parts: ['Put ', arg, ' at the end of ', obj] };
        case 'appendleft': return { tone: 'info', parts: ['Put ', arg, ' at the front of ', obj] };
        case 'pop': return { tone: 'info', parts: ['Take the last item off ', obj] };
        case 'popleft': return { tone: 'info', parts: ['Take the first item out of ', obj] };
        case 'sort': return { tone: 'info', parts: ['Line up ', obj, ' from smallest to biggest'] };
        case 'reverse': return { tone: 'info', parts: ['Flip ', obj, ' backwards'] };
        case 'add': return { tone: 'info', parts: ['Put ', arg, ' into the bag ', obj] };
        case 'remove': case 'discard': return { tone: 'info', parts: ['Take ', arg, ' out of ', obj] };
        case 'extend': return { tone: 'info', parts: ['Add more items to the end of ', obj] };
        default: break;
      }
      if (/^heappush\(/.test(info.expr)) return { tone: 'info', parts: ['Drop a new item into the heap (the smallest always floats to the top)'] };
      return null;
    }
    case 'Break': return { tone: 'info', parts: ['Jump out of the loop (break)'] };
    case 'Continue': return { tone: 'info', parts: ['Skip to the next round of the loop (continue)'] };
    default: return null;
  }
}

/** Plain text of a narration, for the inline hint inside LeetCode's editor. */
export function narrationText(n) {
  const div = h('div', {}, n.parts);
  return div.textContent.replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ the picture

/**
 * @param opts.watch  variable whose history is open (drawn with a ring)
 * @param opts.onPick called with a variable name when the learner clicks it
 */
export function renderKidStep(t, i, opts = {}) {
  const cur = t.steps[i];
  const n = narrate(t, i);
  const action = actionStep(t, i);
  const looks = action?.info?.looks || [];
  const root = h('div', { class: 'kid' });
  root.append(h('div', { class: `kid-say tone-${n.tone}` }, h('div', { class: 'kid-say-text' }, n.parts)));
  if (cur.stack.length > 1) root.append(renderHelpers(cur));
  const f = frameOf(cur);
  if (f.locals) root.append(renderScene(f.locals, previousLocals(t, i), looks, cur.stack, opts));
  if (cur.event === 'return' && cur.stack.length === 1) {
    root.append(h('div', { class: 'kid-gift' }, h('div', { class: 'kid-small' }, 'The answer'), h('div', { class: 'kid-gift-val' }, plainValue(cur.ret))));
  }
  return root;
}

function renderHelpers(step) {
  const frames = step.stack;
  const shown = frames.slice(-6);
  const hidden = frames.length - shown.length;
  return h('div', { class: 'kid-helpers' },
    h('div', { class: 'kid-small' }, `${frames.length} helpers stacked up — each one waits for the one above it`),
    h('div', { class: 'kid-tower' },
      [...shown].reverse().map((fr, k) => {
        const working = k === 0;
        const args = Object.entries(fr.locals || {}).filter(([, v]) => !(v.t === 'prim' && v.v.startsWith('<function'))).slice(0, 2)
          .map(([name, v]) => `${name}=${summarize(v, 14)}`).join(', ');
        return h('div', { class: `kid-helper${working ? ' working' : ''}` },
          h('code', {}, `${fr.fn}(${args})`), h('span', { class: 'kid-small' }, working ? 'working now' : 'waiting'));
      }),
      hidden ? h('div', { class: 'kid-small' }, `…and ${hidden} more below`) : null));
}

/** Click/keyboard props that make a variable pickable (opens its history). */
function pickable(k, opts, cls) {
  if (!opts.onPick) return { class: cls };
  return { class: `${cls} pickable${opts.watch === k ? ' watched' : ''}`, 'data-var': k, tabindex: 0, role: 'button',
    title: `Click to see every value ${k} had`,
    onclick: (e) => { e.stopPropagation(); opts.onPick(k); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); opts.onPick(k); } } };
}

function renderScene(locals, prev, looks, stack, opts = {}) {
  const scene = h('div', { class: 'kid-scene' });
  const names = Object.keys(locals).filter((k) => !(locals[k].t === 'prim' && locals[k].v.startsWith('<function')));
  const ints = {};
  for (const k of names) if (locals[k].t === 'prim' && typeof locals[k].num === 'number') ints[k] = locals[k].num;

  // Numbers and words: bubbles (pointer variables wear their character).
  const bubbles = names.filter((k) => locals[k].t === 'prim' || (locals[k].t === 'str' && locals[k].v.length <= 3 && !hasPointer(k, locals[k].v.length)));
  if (bubbles.length) {
    scene.append(h('div', { class: 'kid-bubbles' }, bubbles.map((k) => {
      const v = locals[k];
      const o = prev?.[k];
      const changed = prev && (!o || JSON.stringify(o) !== JSON.stringify(v));
      const isPtr = INDEX_NAME.test(k) && ints[k] !== undefined;
      let shown = v.t === 'str' ? `“${v.v}”` : v.v;
      if (isTrue(v)) shown = 'yes ✅';
      if (isFalse(v)) shown = 'no ❌';
      if (isNull(v)) shown = '∅';
      return h('div', pickable(k, opts, `kid-bubble${changed ? ' changed' : ''}${isPtr ? ' ptr' : ''}`),
        h('div', { class: 'kid-bubble-name' }, k),
        h('div', { class: 'kid-bubble-val' }, shown),
        changed && o && o.t === 'prim' ? h('div', { class: 'kid-small' }, `was ${o.v}`) : null);
    })));
  }

  function hasPointer(arrName, len) {
    return Object.entries(ints).some(([n, x]) => n !== arrName && INDEX_NAME.test(n) && x >= 0 && x <= len && pointsInto(n, arrName));
  }

  // Linked-list / tree variables that point into a bigger structure ride on it as characters.
  const llOwner = {};
  const lls = names.filter((k) => locals[k].t === 'llist').sort((a, b) => locals[b].nodes.length - locals[a].nodes.length);
  for (const k of lls) {
    const first = locals[k].nodes[0]?.id;
    const owner = lls.find((o) => o !== k && !llOwner[o] && locals[o].nodes.length > locals[k].nodes.length && locals[o].nodes.some((x) => x.id === first));
    if (owner) llOwner[k] = owner;
  }

  let bigTree = null;
  for (const fr of stack) for (const v of Object.values(fr.locals || {})) {
    if (v.t === 'tree' && (!bigTree || Object.keys(v.nodes).length > Object.keys(bigTree.nodes).length)) bigTree = v;
  }

  for (const k of names) {
    const v = locals[k];
    const o = prev?.[k];
    const isNew = prev && !o;
    if (v.t === 'prim' || bubbles.includes(k) || llOwner[k]) continue;
    let body = null;
    let title = null;
    if (v.t === 'list' || v.t === 'str') {
      const items = v.t === 'str' ? [...v.v].map((c) => ({ t: 'prim', v: c })) : v.items;
      const oldItems = o?.t === 'list' ? o.items : o?.t === 'str' ? [...o.v].map((c) => ({ t: 'prim', v: c })) : null;
      const len = v.t === 'str' ? v.v.length : v.len;
      if (v.t === 'list' && items.length && items.every((x) => x.t === 'list')) {
        title = `${k} — a grid`;
        body = renderTiles(v, o, ints, looks.filter((l) => l[0] === k));
      } else if (v.t === 'list' && (v.kind === 'stack' || /^(stack|stk|st|stack\d)$/i.test(k))) {
        title = `${k} — a pile of plates (we add and take from the top)`;
        body = renderPlates(items, oldItems);
      } else if (v.kind === 'deque' || /^(q|queue|dq|bfs)$/i.test(k)) {
        title = `${k} — a line (in at the back, out at the front)`;
        body = renderBlocks(k, items, len, oldItems, ints, prev, looks, { queue: true, pick: opts });
      } else {
        title = v.t === 'str' ? `${k} — letter tiles` : `${k} — ${len} block${len === 1 ? '' : 's'}`;
        body = renderBlocks(k, items, len, oldItems, ints, prev, looks, { letters: v.t === 'str', pick: opts });
      }
    } else if (v.t === 'dict') {
      title = `${k} — notebook (${v.len} page${v.len === 1 ? '' : 's'})`;
      body = renderNotebook(v, o, looks.filter((l) => l[0] === k).map((l) => l[1]), k, opts);
    } else if (v.t === 'set') {
      title = `${k} — bag (${v.len} item${v.len === 1 ? '' : 's'})`;
      body = renderBag(v, o);
    } else if (v.t === 'llist') {
      title = `${k} — a train${v.cycle !== null ? ' that loops back!' : ''}`;
      body = renderTrain(k, v, locals, prev);
    } else if (v.t === 'tree') {
      const tree = bigTree && bigTree.nodes[v.root] && Object.keys(bigTree.nodes).length > Object.keys(v.nodes).length ? bigTree : v;
      title = tree === v ? `${k} — a tree` : `${k} is this spot in the tree`;
      body = renderKidTree(k, tree, locals, tree === v ? null : v.root);
    } else if (v.t === 'obj') {
      title = `${k} (${v.cls})`;
      body = h('div', { class: 'kid-small' }, summarize(v, 120));
    }
    if (!body) continue;
    scene.append(h('div', { class: `kid-thing${isNew ? ' is-new' : ''}${opts.watch === k ? ' watched' : ''}` },
      h('div', pickable(k, opts, 'kid-thing-title'), title, isNew ? h('span', { class: 'kid-new' }, 'new') : null,
        opts.onPick ? h('span', { class: 'kid-pick-hint' }, 'history') : null), body));
  }
  return scene;
}

function shade(items) {
  const nums = items.map((x) => (x.t === 'prim' && x.num !== undefined && x.num !== null ? x.num : null));
  const valid = nums.filter((x) => x !== null);
  if (!valid.length) return () => 30;
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  return (k) => (nums[k] === null ? 20 : hi === lo ? 40 : 18 + ((nums[k] - lo) / (hi - lo)) * 52);
}

function renderBlocks(name, items, len, oldItems, ints, prev, looks, opts = {}) {
  const shown = items.slice(0, 40);
  const tone = shade(shown);
  const lookAt = new Set(looks.filter((l) => l[0] === name && typeof l[1] === 'number').map((l) => (l[1] < 0 ? len + l[1] : l[1])));
  const pointers = {};
  for (const [n, x] of Object.entries(ints)) {
    if (n === name || !INDEX_NAME.test(n) || x < 0 || x > len || !pointsInto(n, name)) continue;
    (pointers[x] ||= []).push(n);
  }
  const cols = shown.length + (pointers[len] ? 1 : 0) + (len > shown.length ? 1 : 0);
  const grid = h('div', { class: 'kid-blocks', style: { gridTemplateColumns: `repeat(${Math.max(cols, 1)}, ${CELL - 6}px)` } });
  // Row 1: pointer markers above their block, sliding from where they were last step.
  for (const [idx, who] of Object.entries(pointers)) {
    grid.append(h('div', { class: 'kid-markers', style: { gridColumn: `${+idx + 1}`, gridRow: '1' } },
      who.map((n) => {
        const was = prev?.[n]?.num;
        const dx = typeof was === 'number' && was !== +idx && was >= 0 && was <= len ? (was - +idx) * CELL : 0;
        return marker(n, { hop: !!dx, style: { '--dx': `${dx}px` }, title: `${n} = ${idx}` });
      })));
  }
  shown.forEach((it, k) => {
    const changed = oldItems && (k >= oldItems.length || JSON.stringify(oldItems[k]) !== JSON.stringify(it));
    const label = it.t === 'prim' || it.t === 'str' ? (it.t === 'str' ? it.v : it.v) : summarize(it, 10);
    const cls = `kid-block${changed ? ' pop' : ''}${lookAt.has(k) ? ' look' : ''}${opts.letters ? ' letter' : ''}`;
    const pick = opts.pick?.onPick && !opts.letters ? pickable(`${name}[${k}]`, opts.pick, cls) : { class: cls };
    grid.append(h('div', { ...pick, style: { gridColumn: `${k + 1}`, gridRow: '2', '--fill': `${tone(k)}%` }, title: pick.title ? `box #${k} — click to see what this box held over time` : `box #${k}` },
      h('span', { class: 'kid-block-val' }, label)));
    grid.append(h('div', { class: 'kid-block-idx', style: { gridColumn: `${k + 1}`, gridRow: '3' } }, `#${k}`));
  });
  if (len > shown.length) grid.append(h('div', { class: 'kid-block more', style: { gridColumn: `${shown.length + 1}`, gridRow: '2' } }, `+${len - shown.length}`));
  if (pointers[len]) {
    grid.append(h('div', { class: 'kid-block ghost', style: { gridColumn: `${len + 1}`, gridRow: '2' }, title: 'There is no box here' }));
    grid.append(h('div', { class: 'kid-block-idx', style: { gridColumn: `${len + 1}`, gridRow: '3' } }, 'no box'));
  }
  if (!shown.length && !pointers[len]) return h('div', { class: 'kid-empty' }, opts.letters ? 'no letters yet' : 'empty — nothing here yet');
  const wrap = h('div', { class: 'kid-scroll' }, grid);
  if (opts.queue) return h('div', {}, h('div', { class: 'kid-queue-labels' }, h('span', {}, 'front'), h('span', {}, 'back')), wrap);
  return wrap;
}

function renderPlates(items, oldItems) {
  if (!items.length) return h('div', { class: 'kid-empty' }, 'no plates yet');
  return h('div', { class: 'kid-plates' }, [...items].reverse().map((it, k) => {
    const idx = items.length - 1 - k;
    const changed = oldItems && (idx >= oldItems.length || JSON.stringify(oldItems[idx]) !== JSON.stringify(it));
    return h('div', { class: `kid-plate${changed ? ' pop' : ''}` }, summarize(it, 16), k === 0 ? h('span', { class: 'kid-small' }, ' ← top') : null);
  }));
}

function renderTiles(v, old, ints, looks) {
  const values = [...new Set(v.items.flatMap((row) => row.items.map((c) => (c.t === 'str' ? c.v : c.v))))];
  const palette = values.length <= 4 ? Object.fromEntries(values.map((x, k) => [x, k + 1])) : null;
  const marks = new Set();
  for (const [a, b] of GRID_PAIRS) if (ints[a] !== undefined && ints[b] !== undefined) marks.add(`${ints[a]},${ints[b]}`);
  for (const [, rc] of looks) if (Array.isArray(rc)) marks.add(`${rc[0]},${rc[1]}`);
  return h('div', { class: 'kid-scroll' }, h('div', { class: 'kid-tiles' }, v.items.map((row, r) => h('div', { class: 'kid-tile-row' },
    row.items.map((c, col) => {
      const val = c.t === 'str' ? c.v : c.v;
      const was = old?.items?.[r]?.items?.[col];
      const changed = old && JSON.stringify(was) !== JSON.stringify(c);
      const here = marks.has(`${r},${col}`);
      return h('div', { class: `kid-tile${changed ? ' pop' : ''}${here ? ' here' : ''}`, style: palette ? { '--tile': `var(--series-${palette[val]})` } : {}, title: `row ${r}, column ${col}` },
        val);
    })))));
}

function renderNotebook(v, old, lookKeys, name, opts = {}) {
  if (!v.entries.length) return h('div', { class: 'kid-notebook' }, h('div', { class: 'kid-empty' }, 'blank pages — nothing written yet'));
  const before = new Map(old?.t === 'dict' ? old.entries : []);
  const looking = new Set(lookKeys.map((k) => (typeof k === 'string' ? `'${k}'` : String(k))));
  return h('div', { class: 'kid-notebook' }, v.entries.map(([k, x]) => {
    const isNew = old && !before.has(k);
    const changed = old && !isNew && JSON.stringify(before.get(k)) !== JSON.stringify(x);
    const cls = `kid-page${isNew ? ' new' : ''}${changed ? ' pop' : ''}${looking.has(k) ? ' look' : ''}`;
    return h('div', name && opts.onPick ? pickable(`${name}[${k}]`, opts, cls) : { class: cls },
      h('span', { class: 'kid-page-key' }, k), h('span', { class: 'kid-page-arrow' }, '➜'), h('span', { class: 'kid-page-val' }, summarize(x, 30)));
  }), v.len > v.entries.length ? h('div', { class: 'kid-small' }, `+${v.len - v.entries.length} more pages`) : null);
}

function renderBag(v, old) {
  if (!v.items.length) return h('div', { class: 'kid-bag' }, h('div', { class: 'kid-empty' }, 'empty bag'));
  const before = new Set(old?.t === 'set' ? old.items.map((x) => summarize(x)) : []);
  return h('div', { class: 'kid-bag' }, v.items.map((x) => {
    const label = summarize(x, 12);
    return h('span', { class: `kid-marble${old && !before.has(summarize(x)) ? ' pop' : ''}` }, label);
  }));
}

function renderTrain(name, v, locals, prev) {
  const riders = {};
  for (const [n, other] of Object.entries(locals)) {
    if (other.t === 'llist' && other.nodes[0]) (riders[other.nodes[0].id] ||= []).push(n);
  }
  const cars = [];
  v.nodes.forEach((node, k) => {
    if (k) cars.push(h('span', { class: 'kid-hitch' }, '—'));
    const who = riders[node.id] || [];
    cars.push(h('div', { class: 'kid-car-wrap' },
      h('div', { class: 'kid-markers' }, who.map((n) => marker(n))),
      h('div', { class: `kid-car${who.some((n) => n !== name) ? ' look' : ''}` }, node.val),
      h('div', { class: 'kid-wheels' }, h('span', {}), h('span', {}))));
  });
  if (v.cycle !== null) cars.push(h('span', { class: 'kid-hitch warn' }, `↺ back to car #${v.cycle}`));
  else cars.push(h('span', { class: 'kid-hitch' }, '—'), h('span', { class: 'kid-end' }, v.more ? '…' : 'end'));
  return h('div', { class: 'kid-scroll' }, h('div', { class: 'kid-train' }, cars));
}

function renderKidTree(name, v, locals, highlightRoot) {
  const riders = {};
  if (highlightRoot) riders[highlightRoot] = [name];
  else for (const [n, other] of Object.entries(locals)) if (other.t === 'tree' && n !== name) (riders[other.root] ||= []).push(n);
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
  const W = 46;
  const H = 62;
  const cx = (id) => pos[id].x * W + W / 2 + 6;
  const cy = (id) => pos[id].d * H + 34;
  const parts = [];
  for (const id of Object.keys(pos)) {
    const n = v.nodes[id];
    for (const c of [n.l, n.r]) if (c && pos[c]) parts.push(s('line', { x1: cx(id), y1: cy(id), x2: cx(c), y2: cy(c), class: 'kid-branch' }));
  }
  for (const id of Object.keys(pos)) {
    const n = v.nodes[id];
    const who = riders[id];
    parts.push(s('g', { class: `kid-leaf${who ? ' look' : ''}` },
      s('circle', { cx: cx(id), cy: cy(id), r: 18 }),
      s('text', { x: cx(id), y: cy(id) + 5, 'text-anchor': 'middle', class: 'kid-leaf-val' }, String(n.val).slice(0, 4)),
      who ? s('text', { x: cx(id), y: cy(id) - 24, 'text-anchor': 'middle', class: 'kid-leaf-marker' }, `${who.join(', ')} ▾`) : null));
  }
  return h('div', { class: 'kid-scroll' }, s('svg', { width: Math.max(x * W + 12, 80), height: (maxDepth + 1) * H + 20, class: 'kid-tree' }, parts));
}

// ------------------------------------------------------------------ compare: race + dots


export function renderRace(results, N, slotOf, fmtSeconds) {
  const ok = results.filter((r) => r.sec);
  if (!ok.length) return null;
  const fastest = Math.min(...ok.map((r) => r.sec));
  const box = h('div', { class: 'kid-race' });
  const draw = () => {
    box.replaceChildren(
      h('div', { class: 'kid-race-title' }, `The race: who finishes a puzzle with ${N.toLocaleString('en-US')} items first?`),
      ...[...ok].sort((a, b) => a.sec - b.sec).map((r) => {
        const frac = Math.min(1, fastest / r.sec);
        const done = frac >= 0.999;
        return h('div', { class: 'kid-lane' },
          h('div', { class: 'kid-lane-name' }, h('span', { class: 'swatch', style: { background: `var(--series-${slotOf(r.id)})` } }), r.name),
          h('div', { class: 'kid-track' },
            h('div', { class: 'kid-trail', style: { '--to': `${frac * 100}%`, background: `var(--series-${slotOf(r.id)})` } }),
            h('div', { class: 'kid-racer', style: { '--to': `${frac * 100}%`, background: `var(--series-${slotOf(r.id)})` } }),
            h('div', { class: 'kid-flag', title: 'finish' })),
          h('div', { class: 'kid-lane-result' }, done ? `finished in ${fmtSeconds(r.sec)}` : `still going… needs ${fmtSeconds(r.sec)} (only ${(frac * 100).toPrecision(frac < 0.01 ? 1 : 2)}% done)`));
      }),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: draw }, 'Race again')));
  };
  draw();
  return box;
}

function workCount(cls, n) {
  if (!cls) return null;
  if (cls.base) return Math.round(cls.base ** n);
  const lg = Math.max(1, Math.round(Math.log2(n)));
  switch (cls.label) {
    case 'O(1)': return { rows: 1, cols: 1, text: '1' };
    case 'O(log n)': return { rows: 1, cols: lg, text: `${lg}` };
    case 'O(√n)': return { rows: 1, cols: Math.round(Math.sqrt(n)), text: `${Math.round(Math.sqrt(n))}` };
    case 'O(n)': return { rows: 1, cols: n, text: `${n}` };
    case 'O(n log n)': return { rows: lg, cols: n, text: `${n} × ${lg} = ${n * lg}` };
    case 'O(n²)': return { rows: n, cols: n, text: `${n} × ${n} = ${n * n}` };
    case 'O(n² log n)': return { rows: n * lg, cols: n, text: `${n} × ${n} × ${lg} = ${n * n * lg}` };
    case 'O(n³)': return { rows: n * n, cols: n, text: `${n} × ${n} × ${n} = ${n ** 3}` };
    case 'O(n!)': { let f = 1; for (let k = 2; k <= n; k++) f *= k; return f; }
    default: return null;
  }
}

export function renderDots(results, slotOf, state, rerender) {
  const ok = results.filter((r) => r.timeClass);
  if (!ok.length) return null;
  const n = state.dotsN || 8;
  const box = h('div', { class: 'kid-dots' });
  box.append(h('div', { class: 'kid-race-title' }, 'How many checks does each one need?'),
    h('div', { class: 'row' }, h('span', { class: 'kid-small' }, 'Puzzle size:'),
      h('div', { class: 'seg' }, [4, 8, 16, 32].map((m) => h('button', { class: m === n ? 'on' : '', onclick: () => { state.dotsN = m; rerender(); } }, `${m} items`)))));
  const panels = h('div', { class: 'kid-dot-panels' });
  for (const r of [...ok].sort((a, b) => b.timeClass.rank - a.timeClass.rank)) {
    const w = workCount(r.timeClass, n);
    const color = `var(--series-${slotOf(r.id)})`;
    let total;
    let pic;
    let text;
    if (typeof w === 'number' || w === null) {
      total = w ?? 0;
      text = w === null ? '?' : w.toLocaleString('en-US');
      pic = total <= 1024
        ? h('div', { class: 'kid-dotgrid', style: { gridTemplateColumns: `repeat(${Math.min(32, Math.max(1, total))}, 8px)` } }, Array.from({ length: total }, () => h('span', { style: { background: color } })))
        : h('div', { class: 'kid-boom' }, `${text} checks — too many to draw!`);
    } else {
      total = w.rows * w.cols;
      text = w.text;
      pic = total <= 1024
        ? h('div', { class: 'kid-dotgrid', style: { gridTemplateColumns: `repeat(${w.cols}, 8px)` } }, Array.from({ length: total }, () => h('span', { style: { background: color } })))
        : h('div', { class: 'kid-boom' }, `${total.toLocaleString('en-US')} checks — too many to draw!`);
    }
    const words = kidO(r.timeClass);
    panels.append(h('div', { class: 'kid-dot-panel', style: { '--slot': color } },
      h('div', { class: 'kid-dot-head' }, r.name),
      h('div', { class: 'kid-small' }, `It ${words}.`),
      h('div', { class: 'kid-dot-count' }, `${text} checks`),
      pic));
  }
  box.append(panels);
  const growth = ok.map((r) => {
    const a = workCount(r.timeClass, 16);
    const b = workCount(r.timeClass, 32);
    const va = typeof a === 'number' ? a : a ? a.rows * a.cols : null;
    const vb = typeof b === 'number' ? b : b ? b.rows * b.cols : null;
    return va && vb ? `${r.name} ×${(vb / va) >= 100 ? Math.round(vb / va).toLocaleString('en-US') : (vb / va).toFixed(1).replace(/\.0$/, '')}` : null;
  }).filter(Boolean);
  if (growth.length) box.append(h('div', { class: 'kid-small', style: { marginTop: '8px' } }, `When the puzzle gets 2× bigger, the work grows: ${growth.join(' · ')}`));
  return box;
}

/** Draw a puzzle's input (for the bug finder) as blocks. */
export function renderPuzzle(params, args) {
  return h('div', { class: 'kid-scene' }, params.map((p, k) => {
    const v = args[k];
    if (Array.isArray(v) && v.every((x) => !Array.isArray(x) && (x === null || typeof x !== 'object'))) {
      const items = v.map((x) => ({ t: 'prim', v: x === null ? '∅' : String(x), num: typeof x === 'number' ? x : undefined }));
      return h('div', { class: 'kid-thing' }, h('div', { class: 'kid-thing-title' }, p.name), renderBlocks(p.name, items, items.length, null, {}, null, []));
    }
    return h('div', { class: 'kid-thing' }, h('div', { class: 'kid-thing-title' }, p.name), h('div', { class: 'kid-bubble-val' }, JSON.stringify(v)));
  }));
}
