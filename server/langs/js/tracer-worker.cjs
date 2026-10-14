// Step tracer for JavaScript / TypeScript, running as a worker thread inside the traced process.
//
// driver.cjs (trace mode) starts this worker and blocks until it has attached to the main
// thread's inspector (inspector.Session#connectToMainThread: in-process, so each request costs
// microseconds instead of a network round trip). The driver then calls the solution through
// lvcall.cjs, whose `debugger` statement pauses; from there we step into the solution one
// statement at a time. Everything but the solution file is blackboxed, so stepping never enters
// Node internals or libraries. Locals are serialized inside the paused program by __lvSnap
// (driver.cjs). Writes the trace JSON of engine/tracer.py to workerData.out.
'use strict';
const inspector = require('inspector');
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { out, solution, maxSteps, sab } = workerData;
const flag = new Int32Array(sab); // [0] handshake state, [1] stdout bytes written so far
const FULL_FRAMES = 6;
const solutionUrl = pathToFileURL(solution).href;
const HIDDEN = new Set(['exports', 'require', 'module', '__filename', '__dirname', 'arguments']);

const session = new inspector.Session();
session.connectToMainThread();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
});

const scripts = new Map(); // scriptId -> url (call frames' own url field is often empty)
session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
const urlOf = (f) => f.url || scripts.get(f.location.scriptId) || '';
// Type-stripped TypeScript is registered under its plain path rather than a file:// URL.
const isUser = (f) => { const u = urlOf(f); return u === solutionUrl || u === solution; };

const steps = [];
const result = { steps };
let entered = false;
let lastDepth = 0;
let lastLine = -1;
let lastCol = -1;
let done = false;

function save() {
  fs.writeFileSync(out, JSON.stringify(result));
}

function primRemote(r) {
  if (r.type === 'undefined') return { t: 'prim', v: 'undefined', k: 'null' };
  if (r.subtype === 'null') return { t: 'prim', v: 'null', k: 'null' };
  if (r.type === 'boolean') return { t: 'prim', v: String(r.value), k: 'bool' };
  if (r.type === 'number') return { t: 'prim', v: r.unserializableValue || String(r.value), k: 'num', num: Number.isSafeInteger(r.value) ? r.value : undefined };
  if (r.type === 'string') return { t: 'str', v: r.value.slice(0, 300), more: r.value.length > 300 };
  if (r.type === 'bigint') return { t: 'prim', v: r.unserializableValue, k: 'num' };
  return null;
}

async function serRemote(r) {
  const p = primRemote(r);
  if (p) return p;
  if (!r.objectId) return { t: 'prim', v: r.description || '?' };
  const res = await send('Runtime.callFunctionOn', { objectId: r.objectId, functionDeclaration: 'function () { return globalThis.__lvSer(this); }', returnByValue: true });
  return JSON.parse(res.result.value);
}

async function frameLocals(frame) {
  const wanted = frame.scopeChain.filter((sc) => ['local', 'block', 'catch', 'closure'].includes(sc.type));
  const scopes = (await Promise.all(wanted.map((sc) => send('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true }))))
    .map(({ result: props }) => props.filter((p) => !HIDDEN.has(p.name) && /^[A-Za-z_$][\w$]*$/.test(p.name) && p.value?.type !== 'function').map((p) => p.name));
  // Outer scopes first (arguments, then loop variables), like the Python view; inner names win.
  const names = [];
  for (const list of scopes.reverse()) for (const n of list) if (!names.includes(n)) names.push(n);
  if (!names.length) return {};
  const expr = `globalThis.__lvSnap([${names.map((n) => `[${JSON.stringify(n)}, () => ${n}]`).join(',')}])`;
  const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: expr, returnByValue: true, silent: true });
  try { return JSON.parse(r.result.value); } catch { return {}; }
}

class StepLimit extends Error {}

async function snapshot(frames, event, extra = {}) {
  if (steps.length >= maxSteps) throw new StepLimit();
  const user = frames.filter(isUser);
  const locals = await Promise.all(user.map((f, i) => (i < FULL_FRAMES ? frameLocals(f) : null)));
  const stack = [];
  for (let i = user.length - 1; i >= 0; i--) {
    const f = user[i];
    const entry = { fn: f.functionName || 'anonymous', line: f.location.lineNumber + 1 };
    if (locals[i]) entry.locals = locals[i];
    stack.push(entry);
  }
  steps.push({ line: stack[stack.length - 1].line, event, stack, out: Atomics.load(flag, 1), ...extra });
}

/** Stop the traced program for good (it may be stuck in an infinite loop). */
async function abort(frames) {
  save();
  done = true;
  await send('Debugger.evaluateOnCallFrame', { callFrameId: frames[0].callFrameId, expression: 'process.exit(0)' }).catch(() => {});
}

async function onPause({ params: ev }) {
  if (done) return;
  const frames = ev.callFrames;
  const user = frames.filter(isUser);
  try {
    if (ev.reason === 'exception') {
      if (user.length) {
        const msg = (ev.data?.description || String(ev.data?.value ?? 'Error')).split('\n')[0];
        const text = /Maximum call stack/.test(msg) ? 'RangeError: Maximum call stack size exceeded (recursion too deep — missing base case?)' : msg;
        await snapshot(frames, 'exception', { exc: text });
        result.error = text;
        result.errorLine = user[0].location.lineNumber + 1;
      }
      save();
      done = true;
      await send('Debugger.resume');
      return;
    }
    if (!user.length) {
      // In lvcall: before the call, step into the solution; after it returned, let it finish.
      await send(entered ? 'Debugger.resume' : 'Debugger.stepInto');
      return;
    }
    entered = true;
    if (!isUser(frames[0])) {
      await send('Debugger.stepOut');
      return;
    }
    const top = frames[0];
    const depth = user.length;
    const line = top.location.lineNumber;
    const col = top.location.columnNumber;
    if (top.returnValue) {
      await snapshot(frames, 'return', { ret: await serRemote(top.returnValue) });
      lastDepth = depth - 1;
    } else if (depth > lastDepth) {
      await snapshot(frames, 'call');
      lastDepth = depth;
    } else if (depth < lastDepth || line !== lastLine || col <= lastCol) {
      await snapshot(frames, 'line');
      lastDepth = depth;
    }
    lastLine = line;
    lastCol = col;
    await send('Debugger.stepInto');
  } catch (e) {
    if (e instanceof StepLimit) result.truncated = true;
    else result.error = `Tracer error: ${e.message}`;
    await abort(frames);
  }
}

(async () => {
  session.on('Debugger.paused', onPause);
  await send('Debugger.enable');
  await send('Debugger.setBlackboxPatterns', { patterns: ['^node:', '/node_modules/', 'driver\\.cjs$', 'tracer-worker\\.cjs$'] });
  await send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
  // Attached: let the main thread run the solution.
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
})();

parentPort.on('message', (m) => {
  if (m === 'finished') {
    save();
    done = true;
    Atomics.store(flag, 0, 2);
    Atomics.notify(flag, 0);
    session.disconnect();
    parentPort.close();
  }
});
