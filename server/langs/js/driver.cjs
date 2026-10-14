// LeetViz driver for JavaScript and TypeScript solutions (see lib/runner.js for the protocol).
//
//   node driver.cjs trace|serve <solution file> <function name> <param types...> -> <void|value>
'use strict';
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const readline = require('readline');

// ------------------------------------------------------------------ LeetCode's globals

function ListNode(val, next) {
  this.val = val === undefined ? 0 : val;
  this.next = next === undefined ? null : next;
}
function TreeNode(val, left, right) {
  this.val = val === undefined ? 0 : val;
  this.left = left === undefined ? null : left;
  this.right = right === undefined ? null : right;
}
globalThis.ListNode = ListNode;
globalThis.TreeNode = TreeNode;
try { Object.assign(globalThis, require('@datastructures-js/priority-queue')); } catch {}
try { globalThis.Queue = require('@datastructures-js/queue').Queue; } catch {}
try { globalThis.Deque = require('@datastructures-js/deque').Deque; } catch {}
try { globalThis._ = require('lodash'); } catch {}

// ------------------------------------------------------------------ values for the tracer
// The tracer evaluates __lvSnap(...) inside each paused frame, so every local is serialized in
// one round trip. Output matches ser() in engine/tracer.py.

const MAX_ITEMS = 120;
const MAX_DEPTH = 3;
const ids = new WeakMap();
let nextId = 1;
const idOf = (o) => { if (!ids.has(o)) ids.set(o, nextId++); return ids.get(o); };
const short = (s) => (s.length <= 80 ? s : s.slice(0, 77) + '...');

function text(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v !== 'object' && typeof v !== 'function') return String(v);
  if (Array.isArray(v)) return short(`[${v.slice(0, 10).map(text).join(', ')}${v.length > 10 ? ', …' : ''}]`);
  return v.constructor?.name || 'Object';
}

function ser(v, depth = 0) {
  if (v === null) return { t: 'prim', v: 'null', k: 'null' };
  if (v === undefined) return { t: 'prim', v: 'undefined', k: 'null' };
  switch (typeof v) {
    case 'boolean': return { t: 'prim', v: String(v), k: 'bool' };
    case 'number': return { t: 'prim', v: String(v), k: 'num', num: Number.isSafeInteger(v) ? v : undefined };
    case 'bigint': return { t: 'prim', v: `${v}n`, k: 'num' };
    case 'string': return { t: 'str', v: v.slice(0, 300), more: v.length > 300 };
    case 'function': return { t: 'prim', v: `<function ${v.name || 'anonymous'}>` };
    case 'symbol': return { t: 'prim', v: String(v) };
    default: break;
  }
  if (v instanceof ListNode || (v.constructor?.name === 'ListNode' && 'next' in v)) {
    const nodes = []; const seen = new Map(); let cur = v; let cycle = null;
    while (cur && nodes.length < 60) {
      if (seen.has(cur)) { cycle = seen.get(cur); break; }
      seen.set(cur, nodes.length);
      nodes.push({ id: idOf(cur), val: text(cur.val) });
      cur = cur.next;
    }
    return { t: 'llist', nodes, cycle, more: !!cur && cycle === null };
  }
  if (v instanceof TreeNode || (v.constructor?.name === 'TreeNode' && 'left' in v)) {
    const nodes = {}; const queue = [v];
    for (const n of queue) {
      if (Object.keys(nodes).length >= 63) break;
      nodes[idOf(n)] = { val: text(n.val), l: n.left ? String(idOf(n.left)) : null, r: n.right ? String(idOf(n.right)) : null };
      for (const c of [n.left, n.right]) if (c && !(idOf(c) in nodes)) queue.push(c);
    }
    return { t: 'tree', root: String(idOf(v)), nodes };
  }
  if (depth >= MAX_DEPTH) return { t: 'prim', v: text(v) };
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    return { t: 'list', kind: Array.isArray(v) ? 'array' : v.constructor.name, id: idOf(v), len: v.length, items: Array.from(v.slice(0, MAX_ITEMS), (x) => ser(x, depth + 1)) };
  }
  if (v instanceof Map) {
    return { t: 'dict', kind: 'Map', len: v.size, entries: [...v].slice(0, MAX_ITEMS).map(([k, x]) => [typeof k === 'string' ? k : text(k), ser(x, depth + 1)]) };
  }
  if (v instanceof Set) return { t: 'set', len: v.size, items: [...v].slice(0, MAX_ITEMS).map((x) => ser(x, depth + 1)) };
  const cls = v.constructor?.name || 'Object';
  if (/PriorityQueue$/.test(cls) && typeof v.toArray === 'function') {
    // v5 queues hold {priority, element}; show just the element when the priority is the element.
    const items = v.toArray().map((x) => (x && typeof x === 'object' && 'element' in x && 'priority' in x
      ? (x.priority === x.element ? x.element : [x.priority, x.element]) : x));
    return { t: 'list', kind: 'heap', id: idOf(v), len: items.length, items: items.slice(0, MAX_ITEMS).map((x) => ser(x, depth + 1)) };
  }
  if ((cls === 'Queue' || cls === 'Deque') && typeof v.toArray === 'function') {
    const items = v.toArray();
    return { t: 'list', kind: 'deque', id: idOf(v), len: items.length, items: items.slice(0, MAX_ITEMS).map((x) => ser(x, depth + 1)) };
  }
  if (cls === 'Object' || cls === undefined) {
    // Plain objects are LeetCode JavaScript's usual hashmap.
    const keys = Object.keys(v);
    return { t: 'dict', kind: 'object', len: keys.length, entries: keys.slice(0, MAX_ITEMS).map((k) => [k, ser(v[k], depth + 1)]) };
  }
  const fields = {};
  for (const k of Object.keys(v).slice(0, 30)) fields[k] = ser(v[k], depth + 1);
  return { t: 'obj', cls, fields };
}

/** [[name, () => value], ...] -> JSON of {name: serialized}; skips names still in their TDZ. */
globalThis.__lvSnap = (pairs) => {
  const out = {};
  for (const [name, get] of pairs) {
    let v;
    try { v = get(); } catch { continue; }
    if (typeof v === 'function') continue;
    try { out[name] = ser(v); } catch { out[name] = { t: 'prim', v: '?' }; }
  }
  return JSON.stringify(out);
};
globalThis.__lvSer = (v) => JSON.stringify(ser(v));

// ------------------------------------------------------------------ reading tokens / writing JSON

const parseType = (s) => {
  if (s.endsWith('[]')) return { k: 'array', of: parseType(s.slice(0, -2)) };
  const m = s.match(/^list<(.*)>$/);
  if (m) return { k: 'array', of: parseType(m[1]) };
  return { k: s };
};

function unpct(t) {
  const bytes = [];
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '%' && i + 2 < t.length) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(t.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

function reader(tokens) {
  let pos = 0;
  const tok = () => tokens[pos++];
  const read = (t) => {
    switch (t.k) {
      case 'integer': case 'long': case 'double': return Number(tok());
      case 'boolean': return tok() === '1';
      case 'string': case 'character': return unpct(tok());
      case 'ListNode': {
        const n = +tok(); const head = new ListNode(); let cur = head;
        for (let i = 0; i < n; i++) { cur.next = new ListNode(Number(tok())); cur = cur.next; }
        return head.next;
      }
      case 'TreeNode': {
        const n = +tok(); const t2 = []; for (let i = 0; i < n; i++) t2.push(tok());
        if (!n || t2[0] === '#') return null;
        const root = new TreeNode(Number(t2[0])); const q = [root]; let i = 1;
        for (let h = 0; h < q.length && i < n; h++) {
          const node = q[h];
          if (i < n && t2[i] !== '#') { node.left = new TreeNode(Number(t2[i])); q.push(node.left); } i++;
          if (i < n && t2[i] !== '#') { node.right = new TreeNode(Number(t2[i])); q.push(node.right); } i++;
        }
        return root;
      }
      case 'array': { const n = +tok(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = read(t.of); return a; }
      default: throw new Error(`unsupported type ${t.k}`);
    }
  };
  return { read, skip: (k) => { pos += k; } };
}

function plain(v) {
  if (v instanceof ListNode || (v && v.constructor?.name === 'ListNode')) {
    const out = []; for (let c = v; c && out.length < 100000; c = c.next) out.push(plain(c.val)); return out;
  }
  if (v instanceof TreeNode || (v && v.constructor?.name === 'TreeNode')) {
    const out = []; const q = [v];
    for (let i = 0; i < q.length && q.length < 400000; i++) {
      if (q[i]) { out.push(plain(q[i].val)); q.push(q[i].left, q[i].right); } else out.push(null);
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, plain);
  if (v instanceof Set) return [...v].map(plain);
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (v === undefined) return null;
  return v;
}

// ------------------------------------------------------------------ main

const [mode, file, method, ...rest] = process.argv.slice(2);
const arrow = rest.indexOf('->');
const ptypes = rest.slice(0, arrow).map(parseType);
const isVoid = rest[arrow + 1] === 'void';
const proto = (s) => fs.writeSync(1, `\u0001LV ${s}\n`);

let fn;
try {
  const mod = require(path.resolve(file));
  fn = typeof mod === 'function' ? mod : mod && typeof mod[method] === 'function' ? mod[method].bind(mod) : null;
  if (!fn) throw new Error(`Couldn't find the function ${method} in your code.`);
} catch (e) {
  proto(JSON.stringify({ err: `${e.name || 'Error'}: ${e.message}` }));
  process.exit(0);
}

const errText = (e) => (e instanceof RangeError && /call stack/.test(e.message)
  ? 'RangeError: Maximum call stack size exceeded (recursion too deep — missing base case?)'
  : e && e.name ? `${e.name}: ${e.message}` : `Error: ${String(e)}`);

if (mode === 'trace') {
  // The tracer runs as a worker attached to this thread's inspector (see tracer-worker.cjs).
  const { Worker } = require('worker_threads');
  const cfg = JSON.parse(process.env.LV_TRACE || '{}');
  const sab = new SharedArrayBuffer(8);
  const flag = new Int32Array(sab);
  const worker = new Worker(path.join(__dirname, 'tracer-worker.cjs'), { workerData: { ...cfg, solution: path.resolve(file), sab } });
  Atomics.wait(flag, 0, 0, 10000); // until the worker has attached
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    Atomics.add(flag, 1, Buffer.byteLength(chunk));
    return write(chunk, ...rest);
  };
  const line = fs.readFileSync(0, 'utf8').split('\n')[0];
  const args = ptypes.map(reader(line.trim() ? line.trim().split(/ +/) : []).read);
  const call = require('./lvcall.cjs');
  const r = call(fn, args); // uncaught errors surface to the tracer as exceptions
  worker.postMessage('finished');
  Atomics.wait(flag, 0, 1, 10000); // until the trace is saved
  fs.writeSync(1, '\n');
  proto(JSON.stringify(plain(isVoid ? args[0] : r)));
  process.exit(0);
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const once = (tokens) => {
    const args = ptypes.map(reader(tokens).read);
    if (global.gc) global.gc();
    const h0 = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    const r = fn(...args);
    const t1 = process.hrtime.bigint();
    const mem = Math.max(0, process.memoryUsage().heapUsed - h0);
    return { secs: Number(t1 - t0) / 1e9, out: isVoid ? args[0] : r, mem };
  };
  rl.on('line', (line) => {
    const parts = line.trim().split(/ +/);
    const minTime = +parts[0];
    const maxRuns = +parts[1];
    const tokens = parts.slice(3);
    try {
      let first = once(tokens);
      let total = first.secs;
      let runs = 1;
      const mem = first.mem;
      if (maxRuns > 1 && total < 0.05) {
        // Warm up the JIT before timing, as LeetCode's many test cases would.
        const warm = process.hrtime.bigint();
        while (Number(process.hrtime.bigint() - warm) < 150e6) once(tokens);
        total = 0; runs = 0;
      }
      let last = first;
      while (runs < maxRuns && (runs === 0 || total < minTime)) { last = once(tokens); total += last.secs; runs++; }
      proto(`{"t":${total / runs},"runs":${runs},"mem":${mem},"depth":-1,"out":${JSON.stringify(plain(last.out))}}`);
    } catch (e) {
      proto(JSON.stringify({ err: errText(e) }));
    }
  });
}
