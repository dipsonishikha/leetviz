// Go: a reflection-based driver (go/driver.go.txt) built together with the solution, traced
// with Delve over its JSON-RPC API.
import { writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, kill } from '../lib/proc.js';
import { cached, compileError, scratch, CompileError } from '../lib/build.js';
import { encodeArgs } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'go');

// LeetCode's Go environment imports packages for you; Go rejects unused imports, so add exactly
// the ones the code mentions (on line 1, so line numbers don't move).
const PACKAGES = {
  sort: 'sort', strings: 'strings', strconv: 'strconv', math: 'math', bits: 'math/bits', rand: 'math/rand',
  heap: 'container/heap', list: 'container/list', ring: 'container/ring', unicode: 'unicode', bytes: 'bytes',
  fmt: 'fmt', slices: 'slices', maps: 'maps', cmp: 'cmp', utf8: 'unicode/utf8', big: 'math/big', regexp: 'regexp',
};

function withImports(code) {
  const stripped = code.replace(/\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|`[^`]*`/gm, '');
  const declared = new Set([...stripped.matchAll(/^\s*import\s+(?:\(\s*([^)]*)\)|("[^"]+"))/gm)].flatMap((m) => (m[1] || m[2]).match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1)));
  const used = Object.entries(PACKAGES).filter(([name, imp]) => !declared.has(imp) && new RegExp(`\\b${name}\\.\\w`).test(stripped)).map(([, imp]) => imp);
  // A user's own `import` block must come right after the package clause, which it still does.
  return `package main; ${used.length ? `import (${used.map((p) => JSON.stringify(p)).join('; ')}); ` : ''}${code}`;
}

async function compile(code, sig, mode) {
  return cached('golang', [code, sig.method, mode, await readFile(path.join(HERE, 'driver.go.txt'), 'utf8')], async (dir) => {
    await writeFile(path.join(dir, 'solution.go'), withImports(code));
    await copyFile(path.join(HERE, 'driver.go.txt'), path.join(dir, 'lv_driver.go'));
    await writeFile(path.join(dir, 'lv_bind.go'), `package main\n\nvar lvFn = ${sig.method}\n`);
    await writeFile(path.join(dir, 'go.mod'), 'module solution\n\ngo 1.22\n');
    const flags = mode === 'trace' ? ['-gcflags=all=-N -l'] : [];
    const r = await run('go', ['build', ...flags, '-o', 'prog', '.'], { cwd: dir, timeout: 180000, env: { CGO_ENABLED: '0' } });
    if (r.code !== 0) {
      const out = r.stderr.replace(/^#.*\n/gm, '');
      if (/declared and not used|imported and not used/.test(out) && !/solution\.go/.test(out)) throw new Error(out.trim());
      throw compileError(out, 'solution.go', { lineRe: /solution\.go:(\d+)/ });
    }
    return { dir, exe: path.join(dir, 'prog') };
  });
}

// ------------------------------------------------------------------ Delve JSON-RPC

class Delve {
  constructor(port) {
    this.sock = net.connect(port, '127.0.0.1');
    this.seq = 0;
    this.pending = new Map();
    let buf = '';
    this.sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error));
        else p?.resolve(msg.result);
      }
    });
    this.ready = new Promise((r, j) => { this.sock.on('connect', r); this.sock.on('error', j); });
  }

  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ method: `RPCServer.${method}`, params: [params], id }) + '\n');
    });
  }

  close() { this.sock.destroy(); }
}

const LOAD = { FollowPointers: true, MaxVariableRecurse: 3, MaxStringLen: 300, MaxArrayValues: 120, MaxStructFields: -1 };
const MAX_ITEMS = 120;
const FULL_FRAMES = 6;

/** Delve variable -> the panel's serialized value. */
function ser(v, depth = 0) {
  if (!v) return { t: 'prim', v: '?' };
  const type = v.type || v.realType || '';
  if (v.unreadable) return { t: 'prim', v: '?' };
  switch (v.kind) {
    case 1: return { t: 'prim', v: v.value, k: 'bool' }; // Bool
    case 2: case 3: case 4: case 5: case 6: case 7: case 8: case 9: case 10: case 11: case 12: { // ints
      const n = Number(v.value);
      if (type === 'uint8' || type === 'byte') return { t: 'str', v: String.fromCharCode(n), char: true };
      if (type === 'int32' || type === 'rune') return { t: 'prim', v: v.value, k: 'num', num: n };
      return { t: 'prim', v: v.value, k: 'num', num: Number.isSafeInteger(n) ? n : undefined };
    }
    case 13: case 14: return { t: 'prim', v: v.value, k: 'num' }; // Float32/64
    case 24: return { t: 'str', v: v.value ?? '', more: (v.len ?? 0) > 300 }; // String
    default: break;
  }
  if (v.kind === 22) { // Ptr
    if (isNil(v)) return { t: 'prim', v: 'nil', k: 'null' };
    if (/ListNode$/.test(type)) return linked(v);
    if (/TreeNode$/.test(type)) return tree(v);
    return ser(v.children[0], depth);
  }
  if (v.kind === 23 || v.kind === 17) { // Slice / Array
    if ((type === '[]uint8' || type === '[]byte') && v.children) return { t: 'str', v: v.children.map((c) => String.fromCharCode(+c.value)).join(''), more: v.len > v.children.length };
    if (depth >= 3) return { t: 'prim', v: `[${v.len} items]` };
    return { t: 'list', kind: 'slice', id: Number(v.base || v.addr || 0), len: v.len, items: (v.children || []).slice(0, MAX_ITEMS).map((c) => ser(c, depth + 1)) };
  }
  if (v.kind === 21) { // Map
    const kids = v.children || [];
    const entries = [];
    for (let i = 0; i + 1 < kids.length && entries.length < MAX_ITEMS; i += 2) entries.push([short(kids[i]), ser(kids[i + 1], depth + 1)]);
    if (/]struct \{\}$/.test(type)) return { t: 'set', len: v.len, items: entries.map(([k]) => ({ t: 'prim', v: k })) };
    if (/]bool$/.test(type) && entries.every(([, x]) => x.v === 'true')) return { t: 'set', len: v.len, items: entries.map(([k]) => ({ t: 'prim', v: k })) };
    return { t: 'dict', kind: 'map', len: v.len, entries };
  }
  if (v.kind === 25) { // Struct
    if (depth >= 3) return { t: 'prim', v: type.replace(/^main\./, '') };
    const fields = {};
    for (const c of (v.children || []).slice(0, 30)) fields[c.name] = ser(c, depth + 1);
    return { t: 'obj', cls: type.replace(/^main\./, ''), fields };
  }
  if (v.kind === 20) { // Interface
    return v.children?.[0] ? ser(v.children[0], depth) : { t: 'prim', v: 'nil', k: 'null' };
  }
  if (v.kind === 19) return { t: 'prim', v: '<func>' };
  return { t: 'prim', v: String(v.value ?? type) };
}

function short(v) {
  if (v.kind === 24) return JSON.stringify(v.value);
  if (v.kind === 25) return `{${(v.children || []).map((c) => short(c)).join(' ')}}`;
  return String(v.value ?? '?');
}

const field = (structVar, name) => structVar?.children?.find((c) => c.name === name);
const isNil = (p) => !p || p.kind !== 22 || !p.children?.length || Number(p.children[0].addr) === 0 || p.value === '0' || p.value === '0x0';

function linked(p) {
  const nodes = [];
  let cur = p;
  const seen = new Map();
  let cycle = null;
  while (!isNil(cur) && nodes.length < 60) {
    const node = cur.children[0];
    if (seen.has(node.addr)) { cycle = seen.get(node.addr); break; }
    seen.set(node.addr, nodes.length);
    nodes.push({ id: node.addr, val: field(node, 'Val')?.value ?? '?' });
    cur = field(node, 'Next');
  }
  return { t: 'llist', nodes, cycle, more: !isNil(cur) && cycle === null };
}

function tree(p) {
  const nodes = {};
  const q = [p];
  for (const ptr of q) {
    if (isNil(ptr) || Object.keys(nodes).length >= 63) continue;
    const n = ptr.children[0];
    const l = field(n, 'Left');
    const r = field(n, 'Right');
    nodes[n.addr] = { val: field(n, 'Val')?.value ?? '?', l: isNil(l) ? null : String(l.children[0].addr), r: isNil(r) ? null : String(r.children[0].addr) };
    q.push(l, r);
  }
  return { t: 'tree', root: String(p.children[0].addr), nodes };
}

async function traceGo({ exe, dir: buildDir }, input, maxSteps, userFile, argv) {
  const dir = await scratch('golang');
  const inFile = path.join(dir, 'in.txt');
  const outFile = path.join(dir, 'out.txt');
  await writeFile(inFile, input);
  const child = spawn('dlv', ['exec', exe, '--headless', '--api-version=2', '--listen=127.0.0.1:0', '--accept-multiclient=false',
    '-r', `stdin:${inFile}`, '-r', `stdout:${outFile}`, '--', ...argv], { cwd: buildDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const steps = [];
  const result = { steps };
  let output = ''; // Delve's own output, plus the program's stderr (where Go prints panics)
  try {
    const port = await new Promise((resolve, reject) => {
      const onData = (d) => { output += d; const m = output.match(/listening at: 127\.0\.0\.1:(\d+)/); if (m) resolve(+m[1]); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', () => reject(new Error(`Delve exited: ${output.trim().split('\n').pop()}`)));
      setTimeout(() => reject(new Error('Delve did not start')), 30000);
    });
    const dlv = new Delve(port);
    await dlv.ready;
    const outLen = async () => (await readFile(outFile).catch(() => Buffer.alloc(0))).length;

    await dlv.call('CreateBreakpoint', { Breakpoint: { functionName: `main.${userFile.method}` } });
    let state = (await dlv.call('Command', { name: 'continue' })).State;
    let lastDepth = 0;
    const userFrames = async () => {
      const { Locations } = await dlv.call('Stacktrace', { Id: state.currentThread.goroutineID ?? -1, Depth: 64, Full: true, Cfg: LOAD });
      return Locations.filter((l) => l.file && path.basename(l.file) === 'solution.go');
    };
    const snapshot = async (frames, event, extra = {}) => {
      if (steps.length >= maxSteps) throw Object.assign(new Error('limit'), { limit: true });
      const stack = [];
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        const entry = { fn: (f.function?.name || '?').replace(/^main\./, '').replace(/\.func\d+.*$/, ' (closure)'), line: f.line };
        if (i < FULL_FRAMES) {
          entry.locals = {};
          for (const v of [...(f.Arguments || []), ...(f.Locals || [])]) {
            if (!v.name || v.name.startsWith('~') || v.name.startsWith('.') || (v.flags & 4)) continue; // ~r0 results, shadowed
            entry.locals[v.name] = ser(v);
          }
        }
        stack.push(entry);
      }
      steps.push({ line: stack[stack.length - 1].line, event, stack, out: await outLen(), ...extra });
    };

    while (state && !state.exited) {
      if (state.currentThread?.breakPoint === null && state.Running) break;
      const th = state.currentThread;
      const file = th?.file ? path.basename(th.file) : '';
      if (file !== 'solution.go') {
        // In the driver or the runtime: done if we came back to the driver, else get out.
        if (steps.length && /lv_driver\.go$|reflect|runtime/.test(th?.file || '')) {
          if (/lv_driver\.go$/.test(th?.file || '')) break;
        }
        state = (await dlv.call('Command', { name: 'stepOut', ReturnInfoLoadConfig: LOAD })).State;
        continue;
      }
      const frames = await userFrames();
      const depth = frames.length;
      await snapshot(frames, depth > lastDepth ? 'call' : 'line');
      lastDepth = depth;
      state = (await dlv.call('Command', { name: 'step', ReturnInfoLoadConfig: LOAD })).State;
      if (state.exited) break;
      const rv = state.currentThread?.ReturnValues;
      if (rv?.length && steps.length) {
        // Stepped out of a user function: Delve hands us its results.
        const prev = steps[steps.length - 1];
        steps.push({ line: prev.line, event: 'return', stack: prev.stack, out: prev.out, ret: ser(rv[0]) });
      }
      // Panics stop at Delve's built-in "unrecovered-panic" breakpoint.
      const bp = state.currentThread?.breakPoint;
      if (bp && bp.name === 'unrecovered-panic') {
        const frames2 = await userFrames().catch(() => []);
        if (frames2.length) await snapshot(frames2, 'exception', { exc: 'panic' });
        result.error = 'panic';
        result.errorLine = frames2[0]?.line ?? null;
        result.panicked = true;
        break;
      }
    }
    // Let the program finish: the driver prints the result, or Go prints the panic to stderr.
    try {
      await dlv.call('ClearBreakpoint', { Id: 1 }).catch(() => {});
      let s = (await dlv.call('Command', { name: 'continue' })).State;
      if (s.currentThread?.breakPoint?.name === 'unrecovered-panic') {
        result.panicked ||= true;
        s = (await dlv.call('Command', { name: 'continue' })).State;
      }
    } catch {}
    dlv.close();
    await new Promise((r) => setTimeout(r, 100));
    if (result.panicked) {
      const m = output.match(/^panic: (.*?)(?: \[recovered\])?$/m);
      const goexit = /goroutine stack exceeds/.test(output);
      const msg = goexit ? 'stack overflow (recursion too deep — missing base case?)' : m ? `panic: ${m[1]}` : 'panic';
      result.error = msg;
      const exc = steps.findLast?.((st) => st.event === 'exception');
      if (exc) exc.exc = msg;
      delete result.panicked;
    }
  } catch (e) {
    if (e.limit) result.truncated = true;
    else throw e;
  } finally {
    kill(child);
  }
  const stdout = await readFile(outFile, 'utf8').catch(() => '');
  await rm(dir, { recursive: true, force: true });
  return { result, stdout };
}

export const golang = {
  id: 'golang',
  name: 'Go',
  requires: ['go', 'dlv'],
  memVia: 'allocations',

  async build(code, sig) {
    const { exe, dir } = await compile(code, sig, 'serve');
    return { cmd: exe, args: ['serve', ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'], cwd: dir };
  },

  async trace({ code, sig, args, maxSteps }) {
    let built;
    try {
      built = await compile(code, sig, 'trace');
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    const input = encodeArgs(args, sig.params.map((p) => p.t)) + '\n';
    const argv = ['trace', ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];
    const { result, stdout } = await traceGo(built, input, maxSteps, { method: sig.method }, argv);
    return finishTrace(result, stdout);
  },
};
