import { Engine } from './engine.js';
import { h, renderLocals, summarize, analyzePointers, setPointerMap } from './viz.js';
import { lineChart, fmtNum, sup } from './chart.js';
import { inferGenerator, paramType } from './gen.js';
import { DEMO } from './demo.js';
import { renderKidStep, narrate, narrationText, actionStep, renderRace, renderDots, renderPuzzle, kidO } from './kid.js';

const embedded = window.parent !== window;
const PARENT_ORIGIN = location.ancestorOrigins?.[0] || '*';
const MAX_APPROACHES = 4; // chart palette slots validated for adjacent-series contrast

let kidPref = true;
try { kidPref = localStorage.getItem('leetviz:mode') !== 'detailed'; } catch {}

const S = {
  tab: 'step',
  kid: kidPref,        // "Simple" picture view (default) vs "Detailed"
  dotsN: 8,
  ctx: null,
  sig: null,           // {method, params:[{name, annotation, type}]}
  approaches: [],      // [{id, name, code, editor?}]
  stepApproach: 'editor',
  exampleIdx: 0,
  inputs: [],          // JSON text per parameter
  trace: null,
  step: 0,
  playing: false,
  speed: 450,
  collapsed: {},       // frame depth -> collapsed?
  gen: '',
  genEdited: false,
  ignoreOrder: false,
  measure: null,
  metric: 'time',
  stress: null,
  stressA: 'editor',
  stressB: null,
  trials: 300,
  maxN: 8,
  progress: '',
  error: null,
};

// ------------------------------------------------------------------ engine

const statusEl = document.getElementById('status');
const engine = new Engine((state, detail) => {
  statusEl.className = `pill ${state === 'busy' || state === 'loading' ? 'busy' : state === 'error' ? 'err' : ''}`;
  statusEl.textContent = { loading: 'Loading Python…', ready: 'Python ready', busy: 'Running…', error: 'Engine error' }[state];
  if (detail) statusEl.title = detail;
  if (state === 'ready' && !S.progress) render();
});

// ------------------------------------------------------------------ LeetCode bridge

let reqSeq = 0;
const requests = new Map();

function parentCall(type, data = {}) {
  if (!embedded) return Promise.resolve(null);
  const id = ++reqSeq;
  window.parent.postMessage({ lv: true, id, type, ...data }, PARENT_ORIGIN);
  return new Promise((resolve) => {
    requests.set(id, resolve);
    setTimeout(() => { if (requests.delete(id)) resolve(null); }, 5000);
  });
}

function parentSend(type, data = {}) {
  if (embedded) window.parent.postMessage({ lv: true, type, ...data }, PARENT_ORIGIN);
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent || !ev.data?.lv) return;
  const d = ev.data;
  if (d.id && requests.has(d.id)) {
    requests.get(d.id)(d.result);
    requests.delete(d.id);
  } else if (d.type === 'navigated') {
    loadContext();
  }
});

// ------------------------------------------------------------------ state helpers

const storeKey = () => `leetviz:${S.ctx?.slug || 'none'}`;

function save() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify({
      approaches: S.approaches.filter((a) => !a.editor).map(({ id, name, code }) => ({ id, name, code })),
      gen: S.genEdited ? S.gen : null,
      ignoreOrder: S.ignoreOrder,
    }));
  } catch {}
}

function restore() {
  try { return JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch { return null; }
}

const approach = (id) => S.approaches.find((a) => a.id === id) || S.approaches[0];
const slotOf = (id) => S.approaches.findIndex((a) => a.id === id) % MAX_APPROACHES + 1;
const params = () => S.sig?.params || [];
const meta = () => S.ctx?.meta || null;

function typesPayload() {
  const out = {};
  for (const p of params()) if (p.type) out[p.name] = p.type;
  return out;
}

function enginePayload(extra) {
  return { method: S.sig?.method, types: typesPayload(), voidReturn: meta()?.return?.type === 'void', ...extra };
}

function banner(text) {
  document.getElementById('banner').textContent = text || '';
}

async function loadContext() {
  const ctx = embedded ? await parentCall('context') : DEMO.context;
  if (!ctx) {
    banner('Could not reach the LeetCode page — try reloading the tab.');
    return;
  }
  document.documentElement.dataset.theme = ctx.dark ? 'dark' : 'light';
  const changedProblem = S.ctx?.slug !== ctx.slug;
  S.ctx = ctx;
  document.getElementById('problem').textContent = ctx.title || '';

  if (changedProblem) {
    const saved = restore();
    S.trace = null; S.measure = null; S.stress = null; S.step = 0; S.exampleIdx = 0;
    S.approaches = [{ id: 'editor', name: 'Your editor code', code: ctx.code || '', editor: true }];
    const extra = saved?.approaches ?? (embedded ? [] : DEMO.approaches);
    S.approaches.push(...extra);
    S.gen = saved?.gen || '';
    S.genEdited = !!saved?.gen;
    S.ignoreOrder = saved?.ignoreOrder ?? false;
    S.stepApproach = 'editor';
    S.stressA = 'editor';
    S.stressB = S.approaches[1]?.id || null;
  } else {
    S.approaches[0].code = ctx.code ?? S.approaches[0].code;
  }

  const warnings = [];
  if (embedded && !ctx.hasMonaco) warnings.push('Couldn’t find LeetCode’s code editor yet — click ⟳ once the page has loaded.');
  else if (ctx.lang && !/python/i.test(ctx.lang)) warnings.push(`LeetViz runs Python 3 — your editor is set to ${ctx.lang}. Switch the language to Python3, or paste Python approaches in Compare.`);
  banner(warnings.join(' '));

  await refreshSignature();
  if (changedProblem) setExample(0);
  if (!S.genEdited) S.gen = inferGenerator(params(), ctx.examples || []);
  render();
}

async function refreshSignature() {
  const code = approach('editor').code || S.approaches.find((a) => a.code.trim())?.code || '';
  let sig = null;
  if (code.trim()) {
    try { sig = await engine.call('signature', { code, method: meta()?.name }); } catch {}
  }
  const mp = meta()?.params || [];
  if (sig && !sig.error) {
    sig.params = sig.params.map((p, i) => ({ ...p, type: mp[i]?.type || paramType(p) }));
    S.sig = sig;
  } else if (mp.length) {
    S.sig = { method: meta().name, params: mp.map((p) => ({ name: p.name, type: p.type, annotation: '' })) };
  } else {
    S.sig = null;
  }
}

/** Refresh just the editor code (cheap) before every run, so runs always use what's on screen. */
async function syncCode() {
  if (!embedded) return;
  const ctx = await parentCall('context');
  if (!ctx) return;
  if (ctx.slug !== S.ctx?.slug) return loadContext();
  S.ctx = ctx;
  S.approaches[0].code = ctx.code ?? S.approaches[0].code;
  const before = JSON.stringify(S.sig?.params?.map((p) => p.name));
  await refreshSignature();
  if (JSON.stringify(S.sig?.params?.map((p) => p.name)) !== before) setExample(S.exampleIdx);
}

function setExample(i) {
  S.exampleIdx = i;
  const ex = S.ctx?.examples?.[i];
  S.inputs = params().map((p, j) => (ex && ex[j] !== undefined ? JSON.stringify(ex[j]) : S.inputs[j] ?? ''));
}

function parseInput(text) {
  try { return JSON.parse(text); } catch {}
  // Accept Python-style literals too.
  const fixed = text.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/'/g, '"');
  return JSON.parse(fixed);
}

// ------------------------------------------------------------------ rendering

const main = document.getElementById('main');

function render() {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === S.tab);
  const keepScroll = main.scrollTop;
  main.replaceChildren(S.tab === 'step' ? renderStepTab() : S.tab === 'compare' ? renderCompareTab() : renderStressTab());
  main.scrollTop = keepScroll;
  if (S.tab === 'step') {
    main.querySelector('.code-line.cur, .code-line.err')?.scrollIntoView({ block: 'nearest' });
    mirrorToEditor();
  }
}

function approachSelect(value, onChange, { allowNone = false } = {}) {
  return h('select', { onchange: (e) => onChange(e.target.value) },
    allowNone ? h('option', { value: '' }, '— choose —') : null,
    S.approaches.map((a) => h('option', { value: a.id, selected: a.id === value }, a.name)));
}

// ---------- Step tab

function renderStepTab() {
  const root = h('div', {});
  const ex = S.ctx?.examples || [];
  root.append(h('div', { class: 'row' },
    h('span', { class: 'hint' }, 'Code'), approachSelect(S.stepApproach, (v) => { S.stepApproach = v; S.trace = null; render(); }),
    ex.length ? h('span', { class: 'hint' }, 'Input') : null,
    ex.length ? h('select', { onchange: (e) => { setExample(+e.target.value); render(); } },
      ex.map((_, i) => h('option', { value: i, selected: i === S.exampleIdx }, `Example ${i + 1}`))) : null));

  if (!params().length) {
    root.append(h('div', { class: 'empty-state' }, S.engineError || 'Write a `class Solution` method in the editor, then press ⟳.'));
    return root;
  }
  const inputs = h('div', { class: 'row', style: { marginTop: '8px', alignItems: 'flex-end' } },
    params().map((p, i) => h('label', { class: 'field' }, h('span', {}, `${p.name}${p.type && p.type !== 'unknown' ? ` · ${p.type}` : ''}`),
      h('input', { type: 'text', class: 'mono', value: S.inputs[i] ?? '', spellcheck: 'false',
        oninput: (e) => { S.inputs[i] = e.target.value; e.target.classList.remove('invalid'); },
        onkeydown: (e) => { if (e.key === 'Enter') runTrace(); } }))),
    h('button', { class: 'btn primary', onclick: runTrace, disabled: engine.busy }, '▶ Visualize'));
  root.append(inputs);

  if (S.error) root.append(h('div', { class: 'error-box', style: { marginTop: '10px' } }, S.error));
  if (!S.trace) {
    root.append(h('div', { class: 'empty-state' },
      h('p', {}, 'Press ', h('b', {}, 'Visualize'), ' to run the code line by line.'),
      h('p', { class: 'small' }, 'You’ll see every variable change, arrays with their pointers (i, j, left, right…), hashmaps filling up, the call stack for recursion, and how often each line runs.'),
      h('p', { class: 'small' }, h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' step · ', h('kbd', {}, 'Space'), ' play/pause · ', h('kbd', {}, 'Alt'), '+', h('kbd', {}, 'V'), ' toggle panel')));
    return root;
  }
  if (!S.trace.steps.length) {
    root.append(h('div', { class: 'error-box', style: { marginTop: '10px' } }, S.trace.error || 'Nothing ran.'));
    return root;
  }
  S.trace.pointerMap ||= analyzePointers(S.trace.code);
  setPointerMap(S.trace.pointerMap);
  if (S.kid) {
    root.append(renderPlayer(), renderKidStep(S.trace, S.step));
    const last = S.step === S.trace.steps.length - 1;
    if (last && (S.trace.error || S.trace.truncated)) root.append(renderResult());
    root.append(h('details', { class: 'kid-codebox', open: !embedded || undefined, style: { marginTop: '12px' } },
      h('summary', {}, 'Show the code (the line that just ran is highlighted)'), renderCode(kidLine())));
    return root;
  }
  root.append(renderPlayer(), renderNarration());
  root.append(h('div', { class: 'split' }, renderCode(), renderState()));
  return root;
}

function renderPlayer() {
  const n = S.trace.steps.length;
  const go = (i) => { S.step = Math.max(0, Math.min(n - 1, i)); render(); };
  return h('div', { class: `player${S.kid ? ' big' : ''}` }, h('div', { class: 'row' },
    h('button', { class: 'btn small', title: 'First step', onclick: () => go(0) }, '⏮'),
    h('button', { class: 'btn small', title: 'Back (←)', onclick: () => go(S.step - 1) }, '◀'),
    h('button', { class: 'btn small primary', title: 'Play / pause (Space)', onclick: togglePlay }, S.playing ? '❚❚' : '▶'),
    h('button', { class: 'btn small', title: 'Forward (→)', onclick: () => go(S.step + 1) }, '▶|'),
    h('button', { class: 'btn small', title: 'Last step', onclick: () => go(n - 1) }, '⏭'),
    h('input', { type: 'range', min: 0, max: n - 1, value: S.step, oninput: (e) => go(+e.target.value) }),
    h('span', { class: 'step-count' }, `${S.step + 1} / ${n}`),
    h('select', { title: 'Speed', onchange: (e) => { S.speed = +e.target.value; if (S.playing) { togglePlay(); togglePlay(); } } },
      [[900, '0.5×'], [450, '1×'], [180, '2×'], [50, '5×']].map(([v, l]) => h('option', { value: v, selected: v === S.speed }, l)))));
}

function togglePlay() {
  S.playing = !S.playing;
  clearInterval(S.timer);
  if (S.playing) {
    if (S.step >= S.trace.steps.length - 1) S.step = 0;
    S.timer = setInterval(() => {
      if (!S.trace || S.step >= S.trace.steps.length - 1) { S.playing = false; clearInterval(S.timer); render(); return; }
      S.step++;
      render();
    }, S.speed);
  }
  render();
}

const innermost = (step) => step.stack[step.stack.length - 1];

function prevFrameLocals(depth) {
  const prev = S.trace.steps[S.step - 1];
  const cur = S.trace.steps[S.step];
  if (!prev || !prev.stack[depth] || prev.stack[depth].fn !== cur.stack[depth].fn) return null;
  // A fresh call at this depth has nothing to diff against.
  if (cur.event === 'call' && depth === cur.stack.length - 1) return null;
  return prev.stack[depth].locals || null;
}

function changeList(depth) {
  const cur = S.trace.steps[S.step].stack[depth]?.locals;
  const prev = prevFrameLocals(depth);
  if (!cur || !prev) return [];
  const out = [];
  for (const [k, v] of Object.entries(cur)) {
    const o = prev[k];
    if (o && JSON.stringify(o) === JSON.stringify(v)) continue;
    if (!o) out.push(h('span', {}, h('code', {}, k), ` = ${summarize(v, 30)}`));
    else if (v.t === 'prim' && o.t === 'prim') out.push(h('span', {}, h('code', {}, k), `: ${o.v} → ${v.v}`));
    else if (v.t === 'llist' || v.t === 'tree') out.push(h('span', {}, h('code', {}, k), ` now points to node ${v.t === 'llist' ? v.nodes[0]?.val : v.nodes[v.root]?.val}`));
    else if (v.len !== undefined && o.len !== undefined && v.len !== o.len) out.push(h('span', {}, h('code', {}, k), ` ${v.len > o.len ? 'grew' : 'shrank'} to ${v.len}`));
    else out.push(h('span', {}, h('code', {}, k), ' changed'));
  }
  return out;
}

function renderNarration() {
  const step = S.trace.steps[S.step];
  const lines = S.trace.code.split('\n');
  const frame = innermost(step);
  const src = (lines[step.line - 1] || '').trim();
  let what;
  if (step.event === 'call') {
    const args = Object.entries(frame.locals || {}).filter(([, v]) => !/^<function/.test(v.v || '')).map(([k, v]) => `${k}=${summarize(v, 24)}`).join(', ');
    what = [`Calling `, h('code', {}, `${frame.fn}(${args})`), step.stack.length > 1 ? ` — recursion depth ${step.stack.length}` : ''];
  } else if (step.event === 'return') {
    what = [h('code', {}, frame.fn), ' returns ', h('code', {}, summarize(step.ret, 60))];
  } else if (step.event === 'exception') {
    what = [`${step.exc} on line ${step.line}: `, h('code', {}, src)];
  } else {
    what = [`About to run line ${step.line}: `, h('code', {}, src)];
  }
  const changes = changeList(step.stack.length - 1);
  return h('div', { class: `narration${step.event === 'exception' ? ' exc' : ''}` },
    h('div', { class: 'what' }, what),
    changes.length ? h('div', { class: 'changes' }, 'Previous line changed: ', changes.flatMap((c, i) => (i ? [', ', c] : [c]))) : null);
}

/** In the simple view each step talks about the line that just ran. */
function kidLine() {
  const a = actionStep(S.trace, S.step);
  return a && a.event === 'line' ? a.line : S.trace.steps[S.step].line;
}

function renderCode(highlight = null) {
  const t = S.trace;
  const step = { ...t.steps[S.step], line: highlight ?? t.steps[S.step].line };
  const hits = {};
  for (let i = 0; i <= S.step; i++) if (t.steps[i].event === 'line') hits[t.steps[i].line] = (hits[t.steps[i].line] || 0) + 1;
  const maxHits = Math.max(1, ...Object.values(hits));
  const prevLine = S.step > 0 && highlight === null ? t.steps[S.step - 1].line : null;
  const atEnd = S.step === t.steps.length - 1;
  const errLine = atEnd && t.errorLine ? t.errorLine : step.event === 'exception' ? step.line : null;
  return h('div', {},
    h('div', { class: 'code', title: 'Number = times the line has run so far' },
      t.code.split('\n').map((src, i) => {
        const ln = i + 1;
        const cls = ln === errLine ? 'err' : ln === step.line ? 'cur' : ln === prevLine ? 'prev' : '';
        return h('div', { class: `code-line ${cls}` }, h('span', { class: 'ln' }, ln),
          h('span', { class: 'hits' }, hits[ln] ? [h('span', { class: 'bar', style: { width: `${(hits[ln] / maxHits) * 36}px` } }), `${hits[ln]}×`] : ''),
          h('span', { class: 'src' }, src || ' '));
      })),
    h('div', { class: 'hint', style: { marginTop: '4px' } }, 'Orange bar = how many times each line has run. Hot lines are where the time goes.'));
}

function renderState() {
  const t = S.trace;
  const step = t.steps[S.step];
  const root = h('div', { class: 'stack' });
  const depth = step.stack.length;
  t.pointerMap ||= analyzePointers(t.code);
  setPointerMap(t.pointerMap);
  if (depth > 1) {
    root.append(h('div', { class: 'callstack' }, 'Call stack:',
      step.stack.map((f, i) => h('span', { class: 'chip', onclick: () => { S.collapsed[i] = !S.collapsed[i]; render(); } }, `${f.fn}:${f.line}`))
        .flatMap((c, i) => (i ? [h('span', {}, '›'), c] : [c]))));
  }
  let bigTree = null;
  for (const f of step.stack) for (const v of Object.values(f.locals || {})) {
    if (v.t === 'tree' && (!bigTree || Object.keys(v.nodes).length > Object.keys(bigTree.nodes).length)) bigTree = v;
  }
  // Innermost frame first; outer frames start collapsed.
  for (let d = depth - 1; d >= 0; d--) {
    const f = step.stack[d];
    const isCur = d === depth - 1;
    const collapsed = S.collapsed[d] ?? !isCur;
    root.append(h('div', { class: `frame${isCur ? ' current' : ''}${collapsed ? ' collapsed' : ''}` },
      h('div', { class: 'frame-head', onclick: () => { S.collapsed[d] = !collapsed; render(); } },
        h('span', {}, collapsed ? '▸' : '▾'), h('b', {}, `${f.fn}()`), h('span', { class: 'depth' }, `line ${f.line}${depth > 1 ? ` · depth ${d + 1}` : ''}`)),
      h('div', { class: 'frame-body' }, f.locals ? renderLocals(f.locals, prevFrameLocals(d), bigTree) : h('div', { class: 'muted small' }, 'locals not recorded for deep frames'))));
  }
  if (step.event === 'return') root.append(h('div', { class: 'card' }, '↩ ', h('b', {}, `${innermost(step).fn}`), ' returns ', h('code', {}, summarize(step.ret, 200))));
  if (S.step === t.steps.length - 1) root.append(renderResult());
  const out = t.stdout ? t.stdout.slice(0, step.out) : '';
  if (out) root.append(h('div', {}, h('h3', {}, 'print() output'), h('div', { class: 'stdout' }, out)));
  return root;
}

function renderResult() {
  const t = S.trace;
  if (t.truncated) {
    const hits = {};
    for (const st of t.steps) if (st.event === 'line') hits[st.line] = (hits[st.line] || 0) + 1;
    const [hot] = Object.entries(hits).sort((a, b) => b[1] - a[1]);
    return h('div', { class: 'card result bad' }, h('b', {}, `Stopped after ${t.steps.length.toLocaleString()} steps.`),
      h('p', { class: 'small' }, 'This may be an infinite loop (a pointer that never moves, a missing break, or a loop condition that never becomes false) — or just a big input. ',
        hot ? ['Line ', h('b', {}, hot[0]), ` ran ${hot[1]} times — check what should change there.`] : ''));
  }
  if (t.error) {
    return h('div', { class: 'card result bad' }, h('b', { class: 'fail' }, 'Error'), h('div', { class: 'error-box', style: { marginTop: '6px' } }, t.error + (t.errorLine ? `  (line ${t.errorLine})` : '')),
      /IndexError/.test(t.error) ? h('p', { class: 'small' }, 'An index went past the end (or before the start) of a list. Step back a few steps and watch the pointer labels — a red dashed cell marks an out-of-range position.') : null,
      /RecursionError/.test(t.error) ? h('p', { class: 'small' }, 'The recursion never reached a base case. Look at the call stack: the arguments should shrink toward the base case on every call.') : null,
      /KeyError/.test(t.error) ? h('p', { class: 'small' }, 'A dictionary lookup used a missing key. Use `.get(key, default)` or check `key in d` first.') : null);
  }
  return h('div', { class: 'card result ok' }, h('b', { class: 'pass' }, 'Returned '), h('code', {}, t.returnPlain ?? summarize(t.returnValue, 300)),
    h('span', { class: 'hint' }, `  ·  ${t.steps.filter((x) => x.event === 'line').length} lines executed`));
}

function mirrorToEditor() {
  const t = S.trace;
  if (!embedded) return;
  if (!t || t.approachId !== 'editor' || t.code !== S.ctx?.code || !t.steps.length) {
    parentSend('decorate', { line: null });
    return;
  }
  const step = t.steps[S.step];
  const frame = innermost(step);
  const isErr = step.event === 'exception';
  if (S.kid) {
    parentSend('decorate', { line: isErr ? step.line : kidLine(), inline: narrationText(narrate(t, S.step)).slice(0, 110), error: isErr });
    return;
  }
  let inline;
  if (isErr) inline = step.exc;
  else if (step.event === 'return') inline = `↩ ${summarize(step.ret, 50)}`;
  else {
    const scalars = Object.entries(frame.locals || {}).filter(([, v]) => v.t === 'prim' && !v.v.startsWith('<function')).slice(0, 5);
    inline = scalars.map(([k, v]) => `${k} = ${v.v}`).join(' · ');
  }
  parentSend('decorate', { line: step.line, inline, error: isErr });
}

async function runTrace() {
  S.error = null;
  if (S.playing) togglePlay();
  await syncCode();
  const appr = approach(S.stepApproach);
  let args;
  try {
    args = S.inputs.map((txt, i) => {
      try { return parseInput(txt); } catch { throw new Error(`Couldn’t read the value for “${params()[i].name}”. Use LeetCode format, e.g. [1,2,3] or "abc".`); }
    });
  } catch (e) {
    S.error = e.message;
    return render();
  }
  try {
    const r = await engine.call('trace', enginePayload({ code: appr.code, args, maxSteps: 5000 }));
    S.trace = { ...r, code: appr.code, approachId: appr.id };
    S.collapsed = {};
    // Start at the beginning, or jump straight to the crash so the bug is in view.
    S.step = r.error && r.steps.length ? r.steps.length - 1 : 0;
  } catch (e) {
    S.error = e.message;
  }
  render();
}

// ---------- Compare tab

function renderCompareTab() {
  const root = h('div', {});
  root.append(h('p', { class: 'hint' },
    'Add each approach (brute → better → optimal). LeetViz runs them on inputs that double in size and measures how the time, lines executed and extra memory grow. That growth rate is the Big-O.'));

  S.approaches.forEach((a, i) => {
    const card = h('div', { class: 'card approach', style: { '--slot': i < MAX_APPROACHES ? `var(--series-${slotOf(a.id)})` : 'var(--border)' } },
      h('div', { class: 'approach-head' },
        h('input', { type: 'text', value: a.name, oninput: (e) => { a.name = e.target.value; save(); } }),
        a.editor ? h('span', { class: 'hint' }, embedded ? 'live from the editor' : 'demo') : null,
        !a.editor ? h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { S.approaches = S.approaches.filter((x) => x !== a); save(); render(); } }, '✕') : null),
      a.editor && embedded
        ? h('details', {}, h('summary', { class: 'small' }, `${a.code.split('\n').length} lines — click to view`), h('pre', { class: 'code', style: { padding: '6px 10px', margin: 0 } }, a.code))
        : h('textarea', { rows: Math.min(14, Math.max(6, a.code.split('\n').length + 1)), spellcheck: 'false', placeholder: 'Paste a complete `class Solution:` here',
            oninput: (e) => { a.code = e.target.value; save(); } }, a.code));
    root.append(card);
  });

  root.append(h('div', { class: 'row', style: { marginTop: '10px' } },
    h('button', { class: 'btn', disabled: S.approaches.length >= MAX_APPROACHES || !embedded, title: 'Save the code currently in the LeetCode editor as a separate approach',
      onclick: async () => { await syncCode(); addApproach(S.approaches[0].code); } }, 'Snapshot editor code'),
    h('button', { class: 'btn', disabled: S.approaches.length >= MAX_APPROACHES, onclick: () => addApproach('') }, '+ Paste an approach'),
    S.approaches.length >= MAX_APPROACHES ? h('span', { class: 'hint' }, `max ${MAX_APPROACHES}`) : null));

  root.append(renderGeneratorEditor());

  const runnable = S.approaches.filter((a) => a.code.trim()).length;
  root.append(h('div', { class: 'row', style: { marginTop: '12px' } },
    h('button', { class: 'btn primary', disabled: engine.busy || !runnable || !S.sig, onclick: runMeasure }, '▶ Measure & compare'),
    engine.busy ? h('button', { class: 'btn', onclick: () => engine.stop() }, '■ Stop') : null,
    h('span', { class: 'progress' }, S.progress)));
  if (S.error && S.tab === 'compare') root.append(h('div', { class: 'error-box', style: { marginTop: '8px' } }, S.error));
  if (S.measure) root.append(renderMeasure());
  return root;
}

function addApproach(code) {
  const k = S.approaches.length;
  const names = ['Brute force', 'Better', 'Optimal'];
  S.approaches.push({ id: `a${Date.now().toString(36)}`, name: names[k - 1] || `Approach ${k + 1}`, code });
  if (!S.stressB) S.stressB = S.approaches[S.approaches.length - 1].id;
  save();
  render();
}

function renderGeneratorEditor() {
  return h('details', { style: { marginTop: '12px' }, open: S.genEdited || undefined },
    h('summary', {}, 'Input generator ', h('span', { class: 'hint' }, S.genEdited ? '(edited)' : '(auto from examples)')),
    h('p', { class: 'hint' }, 'gen(n) builds random arguments of size n. Measurements are only as good as these inputs — make them match the constraints (e.g. sorted, distinct, worst case).'),
    h('textarea', { rows: Math.min(16, S.gen.split('\n').length + 1), spellcheck: 'false', oninput: (e) => { S.gen = e.target.value; S.genEdited = true; save(); } }, S.gen),
    h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'btn small', onclick: () => { S.genEdited = false; S.gen = inferGenerator(params(), S.ctx?.examples || []); save(); render(); } }, 'Reset to auto'),
      h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: S.ignoreOrder, onchange: (e) => { S.ignoreOrder = e.target.checked; save(); } }),
        ' Answer order doesn’t matter (“return in any order”)')));
}

const STAGE = { ops: 'counting lines', time: 'timing', mem: 'measuring memory' };

async function runMeasure() {
  S.error = null;
  await syncCode();
  const list = S.approaches.filter((a) => a.code.trim()).slice(0, MAX_APPROACHES);
  S.progress = 'Starting…';
  render();
  try {
    const results = await engine.call('measure', enginePayload({
      approaches: list.map((a) => ({ name: a.name, code: a.code })), gen: S.gen, ignoreOrder: S.ignoreOrder,
    }), (p) => {
      S.progress = `${list[p.approach]?.name}: ${STAGE[p.stage]} at n = ${fmtNum(p.n)}`;
      const el = main.querySelector('.progress');
      if (el) el.textContent = S.progress;
    });
    S.measure = { results: results.map((r, i) => ({ ...r, id: list[i].id, code: list[i].code })), N: S.ctx?.constraintN || 1e5 };
  } catch (e) {
    S.error = e.message === 'Stopped' ? 'Stopped.' : e.message;
  }
  S.progress = '';
  render();
}

// Same models as engine/tracer.py MODELS, for extrapolating to the problem's real n.
const LOGF = {
  'O(1)': () => 0,
  'O(log n)': (n) => Math.log(Math.log2(n) + 1),
  'O(√n)': (n) => 0.5 * Math.log(n),
  'O(n)': (n) => Math.log(n),
  'O(n log n)': (n) => Math.log(n) + Math.log(Math.log2(n)),
  'O(n²)': (n) => 2 * Math.log(n),
  'O(n² log n)': (n) => 2 * Math.log(n) + Math.log(Math.log2(n)),
  'O(n³)': (n) => 3 * Math.log(n),
  'O(2ⁿ)': (n) => n * Math.log(2),
  'O(n!)': (n) => lgamma(n + 1),
};

function lgamma(x) { // Stirling's approximation is plenty for extrapolation
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x);
}

function predict(cls, n) {
  if (!cls) return null;
  const logf = cls.base ? (m) => m * Math.log(cls.base) : LOGF[cls.label];
  return Math.exp(cls.logc + logf(n));
}

const DOUBLING = ['stays the same', 'adds a constant', 'grows ×1.4', 'doubles', 'a bit more than doubles', 'grows ×4', 'grows ×4+', 'grows ×8', 'squares (!)', 'explodes'];

function secondsAt(r, N) {
  if (r.timeSource === 'time') return predict(r.timeClass, N);
  // Classified from line counts: convert lines to seconds with this approach's own speed.
  const common = r.time.filter(([n]) => r.ops.some(([m]) => m === n));
  if (!common.length) return null;
  const [n, t] = common[common.length - 1];
  const ops = r.ops.find(([m]) => m === n)[1];
  return predict(r.timeClass, N) * (t / ops);
}

function fmtSeconds(sec) {
  if (sec === null || sec === undefined) return '—';
  if (!isFinite(sec) || sec > 3.15e9) return 'longer than the universe has existed';
  if (sec >= 86400 * 365) return `${fmtNum(sec / (86400 * 365))} years`;
  if (sec >= 86400) return `${fmtNum(sec / 86400)} days`;
  if (sec >= 3600) return `${fmtNum(sec / 3600)} hours`;
  if (sec >= 60) return `${fmtNum(sec / 60)} min`;
  if (sec >= 1) return `${sec.toFixed(1)} s`;
  if (sec >= 1e-3) return `${(sec * 1e3).toFixed(1)} ms`;
  return `${(sec * 1e6).toFixed(0)} µs`;
}

function verdictAt(sec) {
  if (sec === null) return null;
  if (sec > 2) return h('span', { class: 'status tle' }, '✖ likely TLE');
  if (sec > 0.5) return h('span', { class: 'status risky' }, '▲ risky');
  return h('span', { class: 'status ok' }, '✔ fast enough');
}

function fmtPow10(N) {
  const e = Math.log10(N);
  return Number.isInteger(e) ? `10${sup(e)}` : fmtNum(N);
}

function renderMeasure() {
  const { results, N } = S.measure;
  const root = h('div', {});
  const ok = results.filter((r) => r.timeClass);
  const ranks = [...new Set(ok.map((r) => r.timeClass.rank))].sort((a, b) => a - b);
  const badgeOf = (r) => {
    if (!r.timeClass || ranks.length < 2) return ranks.length === 1 && ok.length > 1 ? ['same', 'same class'] : null;
    if (r.timeClass.rank === ranks[0]) return ['optimal', 'Optimal'];
    if (r.timeClass.rank === ranks[ranks.length - 1]) return ['brute', 'Brute force'];
    return ['better', 'Better'];
  };
  for (const r of results) {
    r.badge = badgeOf(r);
    r.sec = r.timeClass ? secondsAt(r, N) : null;
  }

  // Story: worst vs best at the problem's real input size (the simple view tells it with pictures).
  if (ok.length >= 2 && !S.kid) {
    const sorted = [...ok].sort((a, b) => b.timeClass.rank - a.timeClass.rank || (b.sec ?? 0) - (a.sec ?? 0));
    const worst = sorted[0];
    const best = sorted[sorted.length - 1];
    const ratio = worst.sec && best.sec ? worst.sec / best.sec : null;
    root.append(h('h3', {}, 'Why one is brute force and another is optimal'), h('div', { class: 'card story' },
      h('p', {}, `When n doubles, “${worst.name}” `, h('b', {}, worst.timeClass.label), ` ${DOUBLING[worst.timeClass.rank] || 'grows'}, while “${best.name}” `, h('b', {}, best.timeClass.label), ` ${DOUBLING[best.timeClass.rank] || 'grows'}.`),
      h('p', {}, `At n = ${fmtPow10(N)} ${S.ctx?.constraintN ? '(the limit in this problem’s constraints)' : '(a typical LeetCode limit)'}: “${worst.name}” ≈ `, h('b', {}, fmtSeconds(worst.sec)), ` vs “${best.name}” ≈ `, h('b', {}, fmtSeconds(best.sec)),
        ratio && ratio > 1.5 ? ` — about ${fmtNum(ratio)}× slower.` : '.'),
      ok.length > 2 || worst.timeClass.rank !== best.timeClass.rank
        ? h('p', { class: 'hint' }, 'Estimates extrapolate the measured curve; LeetCode’s Python limit is roughly 1–3 s per test file.') : null));
  }

  if (S.kid) {
    root.append(renderKidCards(results));
    const race = renderRace(results, N, slotOf, fmtSeconds);
    if (race) root.append(race);
    const dots = renderDots(results, slotOf, S, render);
    if (dots) root.append(dots);
    const details = h('details', { style: { marginTop: '14px' } }, h('summary', {}, 'Details: Big-O, measurements and charts'));
    root.append(details);
    details.append(...renderMeasureDetails(results, N).childNodes);
    return root;
  }
  root.append(...renderMeasureDetails(results, N).childNodes);
  return root;
}

function renderKidCards(results) {
  const box = h('div', { class: 'kid-cards' });
  for (const r of [...results].sort((a, b) => (b.timeClass?.rank ?? -1) - (a.timeClass?.rank ?? -1))) {
    box.append(h('div', { class: 'kid-card', style: { '--slot': `var(--series-${slotOf(r.id)})` } },
      h('div', { class: 'kid-card-head' }, h('span', { class: 'swatch', style: { background: `var(--series-${slotOf(r.id)})` } }), h('span', {}, r.name),
        r.badge ? h('span', { class: `badge ${r.badge[0]}` }, r.badge[1]) : null),
      r.error ? h('div', { class: 'error-box' }, r.error)
        : [h('div', { class: 'kid-card-says' }, `It ${kidO(r.timeClass)}.`),
          r.sec ? h('div', { class: 'kid-card-says' }, r.sec > 2 ? 'Too slow for LeetCode’s big tests.' : r.sec > 0.5 ? 'Just barely fast enough.' : 'Fast enough for LeetCode.') : null,
          h('div', { class: 'kid-card-o' }, `Time ${r.timeClass?.label || '?'} · Space ${r.spaceClass?.label || '?'}`)]));
  }
  return box;
}

function renderMeasureDetails(results, N) {
  const root = h('div', {});
  root.append(h('h3', {}, 'Results'));
  const cards = h('div', { class: 'verdicts' });
  for (const r of [...results].sort((a, b) => (b.timeClass?.rank ?? -1) - (a.timeClass?.rank ?? -1))) cards.append(renderVerdict(r, N));
  root.append(cards);

  const metrics = { time: 'Time', ops: 'Lines executed', mem: 'Extra memory' };
  root.append(h('div', { class: 'row', style: { marginTop: '16px' } }, h('h3', { style: { margin: 0 } }, 'Growth'), h('span', { class: 'spacer' }),
    h('div', { class: 'seg' }, Object.entries(metrics).map(([k, l]) => h('button', { class: S.metric === k ? 'on' : '', onclick: () => { S.metric = k; render(); } }, l)))));
  const fmt = { time: (v) => fmtSeconds(v), ops: (v) => fmtNum(v), mem: (v) => (v >= 1024 * 1024 ? `${(v / 1048576).toFixed(1)} MB` : v >= 1024 ? `${(v / 1024).toFixed(0)} KB` : `${Math.round(v)} B`) }[S.metric];
  const clsKey = { time: 'timeClass', ops: 'opsClass', mem: 'spaceClass' }[S.metric];
  root.append(lineChart(results.map((r) => ({ name: r.name, slot: slotOf(r.id), points: r[S.metric], label: r[clsKey]?.label || '' })), { yLabel: metrics[S.metric], format: fmt }));
  root.append(h('p', { class: 'hint' }, 'Both axes are logarithmic, so each polynomial is a straight line and a steeper slope is a bigger exponent: O(n) has slope 1 and O(n²) has slope 2. Hover to compare values.'));
  return root;
}

function renderVerdict(r, N) {
  const card = h('div', { class: 'verdict', style: { '--slot': `var(--series-${slotOf(r.id)})` } },
    h('div', { class: 'verdict-name' }, h('span', { class: 'swatch', style: { background: `var(--series-${slotOf(r.id)})` } }), r.name,
      r.badge ? h('span', { class: `badge ${r.badge[0]}` }, r.badge[1]) : null));
  if (r.error) {
    card.append(h('div', { class: 'error-box' }, r.error));
    return card;
  }
  card.append(h('div', { class: 'bigO' },
    h('span', { class: 'k' }, 'Time'), h('span', { class: 'v' }, r.timeClass?.label || '?', ' ', h('small', {}, r.timeClass ? `${r.timeClass.confidence} confidence` : 'not enough data')),
    h('span', { class: 'k' }, 'Space'), h('span', { class: 'v' }, r.spaceClass?.label || '?', ' ', h('small', {}, r.spaceClass ? (r.spaceClass.via === 'recursion depth' ? 'call stack' : 'extra') : ''))));
  if (r.sec !== null && r.sec !== undefined) {
    card.append(h('div', { class: 'estimate' }, `At n = ${fmtPow10(N)}: ≈ ${fmtSeconds(r.sec)} `, verdictAt(r.sec)));
  }
  // Hidden work: line counts grow slower than time => one "line" is doing a loop's worth of work.
  if (r.timeSource === 'time' && r.opsClass && r.timeClass && r.timeClass.rank - r.opsClass.rank >= 2) {
    const hot = hottest(r, 1)[0];
    card.append(h('div', { class: 'insight bad' }, '⚠ Hidden work: the number of lines executed grows like ', h('b', {}, r.opsClass.label), ' but the time grows like ', h('b', {}, r.timeClass.label), '. ',
      hot ? ['A single line is doing a loop’s worth of work — probably line ', h('b', {}, hot.line), ': ', h('code', {}, hot.src.trim()), '. '] : '',
      'Built-ins like ', h('code', {}, 'x in list'), ', slicing, ', h('code', {}, '.index()'), ', ', h('code', {}, 'sum()'), ', ', h('code', {}, 'sorted()'), ' or string concatenation cost O(n), not O(1).'));
  }
  if (r.spaceClass?.via === 'recursion depth') {
    card.append(h('div', { class: 'note' }, `Recursion goes up to ${r.depth[r.depth.length - 1]?.[1]} calls deep at n = ${fmtNum(r.depth[r.depth.length - 1]?.[0])}; each pending call takes stack space.`));
  }
  const hot = hottest(r, 4);
  if (hot.length) {
    const max = hot[0].share;
    card.append(h('details', { class: 'heat' }, h('summary', { class: 'small' }, `Where the time goes (n = ${fmtNum(r.hitsN)})`),
      hot.map((x) => h('div', { class: 'heat-row', title: `${x.hits.toLocaleString()} executions` }, h('span', { class: 'pct' }, `L${x.line}`),
        h('span', { class: 'pct' }, `${Math.round(x.share * 100)}%`),
        h('div', {}, h('div', { class: 'hbar', style: { width: `${(x.share / max) * 100}%` } }), h('div', { class: 'src' }, x.src.trim()))))));
  }
  for (const n of r.notes || []) card.append(h('div', { class: 'note' }, n));
  return card;
}

function hottest(r, k) {
  const lines = (r.code || '').split('\n');
  const entries = Object.entries(r.hits || {}).map(([l, c]) => [+l, c]);
  const total = entries.reduce((a, [, c]) => a + c, 0) || 1;
  return entries.sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([line, hits]) => ({ line, hits, share: hits / total, src: lines[line - 1] || '' }));
}

// ---------- Stress tab

function renderStressTab() {
  const root = h('div', {});
  root.append(h('p', { class: 'hint' },
    'Runs two approaches on hundreds of small random inputs and stops at the first input where they disagree (or one crashes / loops forever). Use a simple brute force you trust as the reference — then step through the failing input to see where yours goes wrong.'));
  if (S.approaches.length < 2) {
    root.append(h('div', { class: 'card' }, h('p', {}, 'You need a second approach to compare against.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { addApproach(''); S.tab = 'compare'; render(); } }, '+ Add a brute-force reference'))));
    return root;
  }
  if (!S.stressB || !S.approaches.some((a) => a.id === S.stressB)) S.stressB = S.approaches.find((a) => a.id !== S.stressA)?.id;
  root.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'hint', style: { width: '80px' } }, 'Check'), approachSelect(S.stressA, (v) => { S.stressA = v; })),
    h('div', { class: 'row' }, h('span', { class: 'hint', style: { width: '80px' } }, 'against'), approachSelect(S.stressB, (v) => { S.stressB = v; })),
    h('div', { class: 'row' },
      h('label', { class: 'small' }, 'Tests ', h('input', { type: 'number', min: 10, max: 5000, value: S.trials, style: { width: '80px' }, oninput: (e) => { S.trials = +e.target.value || 300; } })),
      h('label', { class: 'small' }, 'Max n ', h('input', { type: 'number', min: 1, max: 200, value: S.maxN, style: { width: '64px' }, oninput: (e) => { S.maxN = +e.target.value || 8; } })),
      h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: S.ignoreOrder, onchange: (e) => { S.ignoreOrder = e.target.checked; save(); } }), ' any order'))));
  root.append(renderGeneratorEditor());
  root.append(h('div', { class: 'row', style: { marginTop: '12px' } },
    h('button', { class: 'btn primary', disabled: engine.busy || S.stressA === S.stressB, onclick: runStress }, '▶ Hunt for a failing input'),
    engine.busy ? h('button', { class: 'btn', onclick: () => engine.stop() }, '■ Stop') : null,
    h('span', { class: 'progress' }, S.progress)));
  if (S.error && S.tab === 'stress') root.append(h('div', { class: 'error-box', style: { marginTop: '8px' } }, S.error));
  if (S.stress) root.append(renderStressResult());
  return root;
}

async function runStress() {
  S.error = null;
  await syncCode();
  const a = approach(S.stressA);
  const b = approach(S.stressB);
  S.progress = 'Starting…';
  render();
  try {
    const r = await engine.call('stress', enginePayload({ a: { code: a.code }, b: { code: b.code }, gen: S.gen, ignoreOrder: S.ignoreOrder, trials: S.trials, maxN: S.maxN }),
      (p) => { const el = main.querySelector('.progress'); if (el) el.textContent = `test ${p.trial} / ${p.trials}`; });
    S.stress = { ...r, a: a.id, b: b.id };
  } catch (e) {
    S.error = e.message === 'Stopped' ? 'Stopped.' : e.message;
  }
  S.progress = '';
  render();
}

function renderStressResult() {
  const r = S.stress;
  const a = approach(r.a);
  const b = approach(r.b);
  if (r.error) return h('div', { class: 'error-box', style: { marginTop: '10px' } }, r.error);
  if (!r.mismatch) {
    return h('div', { class: 'card result ok', style: { marginTop: '12px' } }, h('span', { class: 'pass' }, S.kid ? `Both approaches gave the same answer on all ${r.trials} puzzles.` : `✔ All ${r.trials} random tests agree.`),
      h('p', { class: 'hint' }, 'No difference found for these input sizes. Try a larger max n, or edit the generator to hit edge cases (duplicates, negatives, empty, all-equal).'));
  }
  const m = r.mismatch;
  const showOut = (res) => (res.ok ? h('span', {}, res.value) : h('span', { class: 'fail' }, res.value));
  const crashed = !m.a.ok ? a : !m.b.ok ? b : null;
  return h('div', { class: 'card result bad', style: { marginTop: '12px' } },
    h('div', { class: 'fail' }, S.kid ? `${r.passed ? `After ${r.passed} puzzles where they agreed, the` : 'The'} two approaches give different answers for this puzzle:` : `✖ Found a failing input after ${r.passed} passing tests (n = ${m.n})`),
    S.kid ? renderPuzzle(params(), m.args) : null,
    S.kid ? h('div', { class: 'kid-cards' }, [[a, m.a], [b, m.b]].map(([ap, res]) => h('div', { class: 'kid-card', style: { '--slot': `var(--series-${slotOf(ap.id)})` } },
      h('div', { class: 'kid-card-head' }, ap.name), h('div', { class: `kid-gift-val${res.ok ? '' : ' fail'}` }, res.value)))) : null,
    S.kid ? null : h('table', { class: 'mismatch-table', style: { marginTop: '8px' } },
      params().map((p, i) => h('tr', {}, h('td', {}, p.name), h('td', {}, JSON.stringify(m.args[i])))),
      h('tr', {}, h('td', {}, a.name), h('td', {}, showOut(m.a))),
      h('tr', {}, h('td', {}, b.name), h('td', {}, showOut(m.b)))),
    crashed ? h('p', { class: 'small' }, `“${crashed.name}” crashed — step through it to see the exact line.`)
      : h('p', { class: 'small' }, 'If both answers are valid (the problem allows any order or any valid answer), tick “any order”. Otherwise one of them has a bug — step through and watch where they diverge.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => stepWith(a.id, m.args) }, `Step through “${a.name}”`),
      h('button', { class: 'btn', onclick: () => stepWith(b.id, m.args) }, `Step through “${b.name}”`)));
}

function stepWith(id, args) {
  S.stepApproach = id;
  S.inputs = args.map((v) => JSON.stringify(v));
  S.tab = 'step';
  runTrace();
}

// ------------------------------------------------------------------ wiring

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { S.tab = b.dataset.tab; S.error = null; render(); });
}
document.getElementById('sync').addEventListener('click', loadContext);
const modeBtn = document.getElementById('mode');
const showMode = () => {
  modeBtn.textContent = S.kid ? 'Simple view' : 'Detailed view';
  modeBtn.title = S.kid ? 'Switch to the detailed view' : 'Switch to the simple picture view';
};
showMode();
modeBtn.addEventListener('click', () => {
  S.kid = !S.kid;
  try { localStorage.setItem('leetviz:mode', S.kid ? 'simple' : 'detailed'); } catch {}
  showMode();
  render();
});
document.getElementById('close').addEventListener('click', () => parentSend('close'));
if (!embedded) document.getElementById('close').hidden = true;

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || S.tab !== 'step' || !S.trace?.steps.length) return;
  const n = S.trace.steps.length;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    S.step = Math.max(0, Math.min(n - 1, S.step + (e.key === 'ArrowRight' ? 1 : -1)));
    render();
  } else if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  }
});

loadContext();
