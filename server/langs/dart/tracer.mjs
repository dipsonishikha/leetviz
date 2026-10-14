// Step tracer for Dart over the Dart VM service protocol (JSON-RPC over WebSocket).
//
//   node tracer.mjs <cfg.json>     cfg: {dir, method, maxSteps, input, out}
//
// Runs main.dart in the VM paused at start, breaks at Solution.<method>, then steps into the
// solution file statement by statement. Each user frame's locals are serialized in one
// evaluateInFrame call to lvSnap (lv_ser.dart, imported by the solution on line 1).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const FULL_FRAMES = 6;
const child = spawn('dart', ['--enable-vm-service=0', '--pause-isolates-on-start', '--disable-service-auth-codes', '--no-serve-devtools', 'main.dart', 'trace'],
  { cwd: cfg.dir, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end(cfg.input);
let stdout = '';
let userBytes = 0;
let banner = true;
const serviceUrl = new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => {
    const text = String(d);
    if (banner) {
      const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\S*/);
      if (m) { banner = false; resolve(`ws://127.0.0.1:${m[1]}/ws`); return; }
    }
    stdout += text;
    userBytes += d.length;
  });
  child.on('close', () => reject(new Error('dart exited before the VM service started')));
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const ws = new WebSocket(await serviceUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const events = [];
let waiter = null;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message + (msg.error.data?.details ? `: ${msg.error.data.details}` : '')));
    else p.resolve(msg.result);
  } else if (msg.method === 'streamNotify') {
    const e = msg.params.event;
    if (waiter && /^Pause|IsolateExit/.test(e.kind)) { const w = waiter; waiter = null; w(e); } else if (/^Pause|IsolateExit/.test(e.kind)) events.push(e);
  }
};
const exited = new Promise((r) => child.on('close', r));
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = String(++seq);
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
const nextPause = () => (events.length ? Promise.resolve(events.shift())
  : Promise.race([new Promise((r) => { waiter = r; }), exited.then(() => ({ kind: 'Exit' }))]));

const steps = [];
const result = { steps };
const userUri = (uri) => /solution\.dart$/.test(uri || '');

await call('streamListen', { streamId: 'Debug' });
await call('streamListen', { streamId: 'Isolate' }).catch(() => {});
const vm = await call('getVM');
let isolateId = vm.isolates[0]?.id;
for (let i = 0; !isolateId && i < 50; i++) {
  await new Promise((r) => setTimeout(r, 100));
  isolateId = (await call('getVM')).isolates[0]?.id;
}
await call('setIsolatePauseMode', { isolateId, exceptionPauseMode: 'Unhandled' }).catch(() =>
  call('setExceptionPauseMode', { isolateId, mode: 'Unhandled' }));

// Break at Solution.<method> (once the isolate has loaded the program and paused at start).
let iso = await call('getIsolate', { isolateId });
for (let i = 0; i < 200 && (iso.pauseEvent?.kind !== 'PauseStart' || !iso.libraries.some((l) => userUri(l.uri))); i++) {
  await new Promise((r) => setTimeout(r, 50));
  iso = await call('getIsolate', { isolateId });
}
const libRef = iso.libraries.find((l) => userUri(l.uri));
if (!libRef) throw new Error('the Dart VM never loaded solution.dart');
const lib = await call('getObject', { isolateId, objectId: libRef.id });
const clsRef = lib.classes.find((c) => c.name === 'Solution');
const cls = await call('getObject', { isolateId, objectId: clsRef.id });
const fnRef = cls.functions.find((f) => f.name === cfg.method);
await call('addBreakpointAtEntry', { isolateId, functionId: fnRef.id });
await call('resume', { isolateId });

const scriptLines = new Map(); // script id -> tokenPos -> line
async function lineOf(frame) {
  const loc = frame.location;
  if (loc.line) return loc.line;
  const sid = loc.script.id;
  if (!scriptLines.has(sid)) {
    const script = await call('getObject', { isolateId, objectId: sid });
    const map = new Map();
    for (const row of script.tokenPosTable || []) for (let i = 1; i < row.length; i += 2) map.set(row[i], row[0]);
    scriptLines.set(sid, map);
  }
  return scriptLines.get(sid).get(loc.tokenPos) ?? 0;
}

async function frameLocals(index, frame) {
  const names = (frame.vars || []).map((v) => v.name).filter((n) => /^[A-Za-z_]\w*$/.test(n) && n !== 'this');
  if (!names.length) return {};
  const expr = `lvSnap(<String>[${names.map((n) => `'${n}'`).join(',')}], <Object?>[${names.join(',')}])`;
  try {
    let r = await call('evaluateInFrame', { isolateId, frameIndex: index, expression: expr, disableBreakpoints: true });
    if (r.valueAsStringIsTruncated) r = await call('getObject', { isolateId, objectId: r.id, count: 1 << 22 });
    return JSON.parse(r.valueAsString);
  } catch {
    return {};
  }
}

async function snapshot(event, extra = {}) {
  if (steps.length >= cfg.maxSteps) throw Object.assign(new Error('limit'), { limit: true });
  const { frames } = await call('getStack', { isolateId, limit: 200 });
  const user = [];
  for (const [i, f] of frames.entries()) if (f.kind === 'Regular' && userUri(f.location?.script?.uri)) user.push([i, f]);
  if (!user.length) return 0;
  const stack = [];
  for (let k = user.length - 1; k >= 0; k--) {
    const [i, f] = user[k];
    const entry = { fn: f.code?.name?.replace(/^.*\./, '') || '?', line: await lineOf(f) };
    if (k < FULL_FRAMES) entry.locals = await frameLocals(i, f);
    stack.push(entry);
  }
  const step = { line: stack[stack.length - 1].line, event, stack, out: userBytes, ...extra };
  const prev = steps[steps.length - 1];
  if (!(event === 'line' && prev && prev.event === 'line' && JSON.stringify(prev.stack) === JSON.stringify(stack))) steps.push(step);
  return user.length;
}

try {
  let lastDepth = 0;
  for (;;) {
    const ev = await nextPause();
    if (ev.kind === 'Exit' || ev.kind === 'IsolateExit' || ev.kind === 'PauseExit') break;
    if (ev.kind === 'PauseStart') continue; // already resumed above
    if (ev.kind === 'PauseException') {
      let msg = 'Exception';
      try {
        const r = await call('invoke', { isolateId, targetId: ev.exception.id, selector: 'toString', argumentIds: [] });
        msg = r.valueAsString || ev.exception.classRef?.name || 'Exception';
      } catch {}
      if (/Stack Overflow/i.test(msg)) msg = 'StackOverflowError (recursion too deep — missing base case?)';
      const depth = await snapshot('exception', { exc: msg });
      if (depth) {
        result.error = msg;
        result.errorLine = steps[steps.length - 1].line;
      }
      child.kill('SIGKILL');
      break;
    }
    const top = ev.topFrame;
    if (top && !userUri(top.location?.script?.uri)) {
      // In the driver or a library: step out until we're back in the solution (or done).
      const { frames } = await call('getStack', { isolateId, limit: 200 });
      const inUser = frames.some((f) => f.kind === 'Regular' && userUri(f.location?.script?.uri));
      await call('resume', { isolateId, ...(inUser ? { step: 'Out' } : {}) });
      continue;
    }
    const depth = await snapshot(lastDepth === 0 ? 'call' : 'line');
    if (depth > lastDepth && lastDepth !== 0) steps[steps.length - 1].event = 'call';
    lastDepth = depth;
    await call('resume', { isolateId, step: 'Into' });
  }
} catch (e) {
  if (e.limit) result.truncated = true;
  else result.error = `Tracer error: ${e.message}`;
  child.kill('SIGKILL');
}
await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
child.kill('SIGKILL');
result.rawStdout = stdout;
writeFileSync(cfg.out, JSON.stringify(result));
process.exit(0);
