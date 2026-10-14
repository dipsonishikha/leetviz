// Language-independent orchestration of measure / stress / trace on top of language adapters.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LineWorker } from './proc.js';
import { encodeArgs, signatureFromMeta } from './types.js';
import { fit, spaceClass } from './fit.js';
import { adapter } from '../langs/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SIZES = Array.from({ length: 15 }, (_, k) => 2 ** (k + 2)); // 4 .. 65536
const TIME_LIMIT = 0.8;    // seconds for a single run before we stop growing n
const MIN_SAMPLE = 0.03;   // repeat cheap runs until this much time is measured
const RUN_TIMEOUT = 10000; // ms per measure request (includes repetitions)
const STRESS_TIMEOUT = 2000;

// ------------------------------------------------------------------ input generator

class Generator {
  constructor(code) {
    this.child = spawn('python3', [path.join(HERE, 'gen_server.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.queue = [];
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.on('close', () => { for (const q of this.queue.splice(0)) q.reject(new Error(`Generator process exited: ${this.stderr.trim().split('\n').pop() || 'no output'}`)); });
    createInterface({ input: this.child.stdout }).on('line', (l) => this.queue.shift()?.resolve(JSON.parse(l)));
    this.ready = this.send({ gen: code }).then((r) => { if (r.error) throw new Error(`Generator error: ${r.error}`); });
  }

  send(obj) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    });
  }

  async args(n, seed, stress = false) {
    await this.ready;
    const r = await this.send({ n, seed, stress });
    if (r.error) throw new Error(`Generator failed at n=${n}: ${r.error}`);
    if (!Array.isArray(r.args)) throw new Error('gen(n) must return a list of arguments, e.g. [nums, target]');
    return r.args;
  }

  close() { this.child.kill('SIGKILL'); }
}

// ------------------------------------------------------------------ comparing outputs

function canon(v, ignoreOrder) {
  const round = (x) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 1e5) / 1e5
    : Array.isArray(x) ? x.map(round) : x);
  v = round(v);
  if (ignoreOrder && Array.isArray(v)) {
    const key = (x) => JSON.stringify(x);
    v = v.map((x) => (Array.isArray(x) ? [...x].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) : x))
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
  return JSON.stringify(v);
}

// ------------------------------------------------------------------ one approach's driver

class Driver {
  constructor(lang, code, sig) {
    this.lang = lang;
    this.code = code;
    this.sig = sig;
    this.ad = adapter(lang);
  }

  async start() {
    const run = await this.ad.build(this.code, this.sig, 'serve');
    this.worker = new LineWorker(run.cmd, run.args, run);
  }

  /** @returns {Promise<{ok, out?, t?, runs?, mem?, depth?, error?}>} */
  async call(args, { minTime = 0, maxRuns = 1, mem = false, timeout = RUN_TIMEOUT } = {}) {
    const tokens = encodeArgs(args, this.sig.params.map((p) => p.t));
    try {
      const reply = JSON.parse(await this.worker.request(`${minTime} ${maxRuns} ${mem ? 1 : 0} ${tokens}`, timeout));
      if (reply.err) return { ok: false, error: reply.err };
      return { ok: true, ...reply };
    } catch (e) {
      if (e instanceof SyntaxError) return { ok: false, error: 'The driver printed something unreadable.' };
      if (e.timedOut) return { ok: false, timedOut: true, error: `Took over ${timeout / 1000} s — infinite loop?` };
      return { ok: false, error: this.ad.crashMessage?.(e) || crashMessage(e) };
    }
  }

  close() { this.worker?.close(); }
}

export function crashMessage(e) {
  const tail = (e.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' · ');
  const sig = { SIGSEGV: 'Segmentation fault (invalid memory access — a null pointer or out-of-range index?)', SIGABRT: 'Aborted', SIGFPE: 'Arithmetic error (division by zero?)', SIGKILL: 'Killed (out of memory?)' }[e.signal];
  return sig ? `${sig}${tail ? ` — ${tail}` : ''}` : `Crashed${e.code !== null && e.code !== undefined ? ` (exit ${e.code})` : ''}${tail ? `: ${tail}` : ''}`;
}

// ------------------------------------------------------------------ commands

export async function trace(req) {
  const sig = signatureFromMeta(req.meta);
  return adapter(req.lang).trace({ code: req.code, sig, args: req.args, maxSteps: req.maxSteps || 5000 });
}

export async function measure(req, emit) {
  const gen = new Generator(req.gen);
  const results = [];
  try {
    await gen.ready;
    for (const [idx, appr] of req.approaches.entries()) {
      const lang = appr.lang || req.lang;
      const res = { name: appr.name, ops: [], time: [], mem: [], depth: [], hits: {}, notes: [] };
      results.push(res);
      const sig = signatureFromMeta(req.meta);
      const drv = new Driver(lang, appr.code, sig);
      try {
        emit({ stage: 'build', approach: idx, n: 0 });
        await drv.start();
      } catch (e) {
        res.error = e.message;
        continue;
      }
      const outputs = {};
      try {
        let prev = null;
        for (const n of SIZES) {
          if (prev) {
            const [, t0, r] = prev;
            if (t0 * (r && r > 1 ? r : 2) > TIME_LIMIT) break;
            if (r && r > 40) break; // super-polynomial growth; don't risk an exponential blow-up
          }
          emit({ stage: 'time', approach: idx, n });
          const args = await gen.args(n, n * 7919);
          let out = await drv.call(args, { minTime: MIN_SAMPLE, maxRuns: 200, mem: true });
          if (out.ok && prev && prev[1] > 0 && out.t / prev[1] > 40) {
            // A sudden 40x jump is more often a GC pause than exponential growth: measure again.
            const again = await drv.call(args, { minTime: MIN_SAMPLE, maxRuns: 200, mem: true });
            if (again.ok && again.t < out.t) out = again;
          }
          if (!out.ok) {
            if (out.timedOut) res.notes.push(`Stopped at n=${n}: a single run took too long.`);
            else if (!res.time.length) { res.error = `${out.error} (at n=${n})`; }
            else res.notes.push(`${out.error} at n=${n}.`);
            break;
          }
          outputs[n] = canon(out.out, req.ignoreOrder);
          res.time.push([n, out.t]);
          if (out.mem >= 0) res.mem.push([n, out.mem]);
          if (out.depth >= 0) res.depth.push([n, out.depth]);
          prev = [n, out.t, prev && prev[1] > 0 ? out.t / prev[1] : null];
        }
      } finally {
        drv.close();
      }
      res.outputs = outputs;
      if (drv.ad.memVia) res.memVia = drv.ad.memVia;
      else res.memMeasured = false;
      if (drv.ad.measureNote) res.notes.push(drv.ad.measureNote);
    }
  } finally {
    gen.close();
  }

  const good = results.filter((r) => !r.error && r.outputs && Object.keys(r.outputs).length);
  for (const other of good.slice(1)) {
    const bad = Object.keys(good[0].outputs).filter((n) => n in other.outputs && other.outputs[n] !== good[0].outputs[n]);
    if (bad.length) other.notes.push(`⚠ Output differs from “${good[0].name}” at n=${bad[0]}. Run the Find bugs tab to get a small failing case.`);
  }
  for (const r of results) {
    delete r.outputs;
    r.timeClass = fit(r.time, 2e-6);
    r.timeSource = 'time';
    r.opsClass = null;
    r.spaceClass = spaceClass(r);
  }
  return results;
}

export async function stress(req, emit) {
  const sig = signatureFromMeta(req.meta);
  const gen = new Generator(req.gen);
  const drivers = [req.a, req.b].map((x) => new Driver(x.lang || req.lang, x.code, sig));
  try {
    await gen.ready;
    for (const d of drivers) await d.start();
    const run = async (d, args) => {
      const r = await d.call(args, { timeout: STRESS_TIMEOUT });
      return r.ok ? { ok: true, value: canon(r.out, req.ignoreOrder) } : { ok: false, value: r.error };
    };
    const trials = req.trials || 200;
    const maxN = Math.max(1, req.maxN || 8);
    for (let t = 0; t < trials; t++) {
      const n = 1 + Math.floor((t * maxN) / trials);
      if (t % 20 === 0) emit({ stage: 'stress', trial: t, trials });
      let args;
      try { args = await gen.args(n, 100003 * t + 17, true); } catch (e) { return { error: e.message }; }
      const [ra, rb] = [await run(drivers[0], args), await run(drivers[1], args)];
      if (ra.ok !== rb.ok || ra.value !== rb.value) return { passed: t, trials, mismatch: { n, args, a: ra, b: rb } };
    }
    return { passed: trials, trials };
  } finally {
    gen.close();
    for (const d of drivers) d.close();
  }
}
