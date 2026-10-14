// PHP: a plain driver (php/driver.php) for timing, and phpdbg (PHP's built-in debugger) for
// tracing: it steps line by line, and `ev` runs LV::snap(get_defined_vars()) inside each paused
// frame to read its locals.
import { writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { run, kill } from '../lib/proc.js';
import { cached, scratch, CompileError } from '../lib/build.js';
import { encodeArgs, plainToSer } from '../lib/types.js';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'php', 'driver.php');
const FULL_FRAMES = 6;

async function prepare(code) {
  return cached('php', [code], async (dir) => {
    const file = path.join(dir, 'solution.php');
    // LeetCode's PHP editor holds no "<?php" tag; add it on line 1 so line numbers don't move.
    await writeFile(file, /^\s*<\?php/.test(code) ? code : `<?php ${code}`);
    const r = await run('php', ['-l', file], { timeout: 30000 });
    if (r.code !== 0) {
      const out = r.stdout + r.stderr;
      const m = out.match(/on line (\d+)/);
      const msg = (out.match(/(?:Parse|Fatal) error:\s*(.*?) in /) || [])[1] || 'Syntax error';
      throw new CompileError(`${msg}${m ? ` (line ${m[1]})` : ''}`, m ? +m[1] : null);
    }
    return { dir, file };
  });
}

const driverArgs = (mode, file, sig) => [DRIVER, mode, file, sig.method, ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];

/** An interactive phpdbg session: send a command, get its output up to the next prompt. */
class Phpdbg {
  constructor(args, env, cwd) {
    this.child = spawn('phpdbg', ['-q', '-b', '-I', ...args], { env: { ...process.env, ...env }, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.waiter = null;
    this.child.stdout.on('data', (d) => { this.buf += d; this.check(); });
    this.child.stderr.on('data', (d) => { this.buf += d; this.check(); });
    this.child.on('close', () => { this.closed = true; this.check(); });
  }

  check() {
    if (!this.waiter) return;
    const i = this.buf.lastIndexOf('prompt> ');
    if (i >= 0 && this.buf.slice(i + 8).trim() === '') {
      const out = this.buf.slice(0, i);
      this.buf = '';
      const w = this.waiter;
      this.waiter = null;
      w(out);
    } else if (this.closed) {
      const w = this.waiter;
      this.waiter = null;
      w(this.buf);
    }
  }

  cmd(line) {
    return new Promise((resolve) => {
      this.waiter = resolve;
      if (!this.closed) this.child.stdin.write(line + '\n');
      this.check();
    });
  }

  close() { kill(this.child); }
}

async function tracePhp(prep, sig, args, maxSteps) {
  const dir = await scratch('php');
  const files = { LV_INPUT: path.join(dir, 'in.txt'), LV_STDOUT: path.join(dir, 'stdout.txt'), LV_RESULT: path.join(dir, 'result.json') };
  await writeFile(files.LV_INPUT, encodeArgs(args, sig.params.map((p) => p.t)));
  const dbg = new Phpdbg(driverArgs('trace', prep.file, sig).slice(0), files, prep.dir);
  const steps = [];
  const result = { steps };
  const outLen = async () => (await readFile(files.LV_STDOUT).catch(() => Buffer.alloc(0))).length;
  try {
    await dbg.cmd('');
    await dbg.cmd('set stepping line');
    const isMethod = /\bclass\s+Solution\b/.test(await readFile(prep.file, 'utf8'));
    await dbg.cmd(`b ${isMethod ? `Solution::${sig.method}` : sig.method}`);
    let out = await dbg.cmd('run');
    await dbg.cmd('break del 0');
    let lastDepth = 0;
    for (;;) {
      const uncaught = out.match(/\[Uncaught (\w+)(?: in [^\]]*? on line (\d+))?:?\s*([^\]]*)\]/) || out.match(/(?:Fatal error|Uncaught)\s*:?\s*(\w+)?:?\s*(.*?) in .*? on line (\d+)/);
      const frames = await userFrames(dbg, prep.file);
      if (uncaught || /PHP (Fatal|Warning)|Fatal error/.test(out) && !frames.length) {
        const msg = uncaught ? `${uncaught[1] || 'Error'}: ${(uncaught[3] || uncaught[2] || '').trim()}` : out.trim().split('\n').pop();
        if (frames.length) await snapshot(dbg, frames, 'exception', steps, await outLen(), { exc: msg });
        result.error = msg;
        result.errorLine = frames[0]?.line ?? (uncaught?.[2] ? +uncaught[2] : null);
        break;
      }
      if (!frames.length || /Script ended normally/.test(out) || dbg.closed) break;
      if (steps.length >= maxSteps) { result.truncated = true; break; }
      const depth = frames.length;
      await snapshot(dbg, frames, depth > lastDepth ? 'call' : 'line', steps, await outLen());
      lastDepth = depth;
      out = await dbg.cmd('s');
    }
    if (!result.error && !result.truncated) await dbg.cmd('c');
    await dbg.cmd('quit');
  } finally {
    dbg.close();
  }
  if (!result.error && !result.truncated) {
    const raw = await readFile(files.LV_RESULT, 'utf8').catch(() => null);
    if (raw !== null) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.err === 'string') result.error = v.err;
      else {
        result.returnPlain = raw;
        result.returnValue = plainToSer(v);
        const last = steps[steps.length - 1];
        if (last) steps.push({ ...last, event: 'return', stack: last.stack.slice(0, 1), ret: result.returnValue });
      }
    }
  }
  result.stdout = (await readFile(files.LV_STDOUT, 'utf8').catch(() => '')).slice(0, 20000);
  await rm(dir, { recursive: true, force: true });
  return result;
}

async function userFrames(dbg, file) {
  const out = await dbg.cmd('back');
  const frames = [];
  for (const m of out.matchAll(/frame #(\d+): (.*?)\((.*?)\) at (.*?):(\d+)/g)) {
    if (m[4] !== file) continue;
    frames.push({ index: +m[1], fn: m[2].split(/->|::/).pop(), line: +m[5] });
  }
  return frames; // innermost first
}

async function snapshot(dbg, frames, event, steps, out, extra = {}) {
  const stack = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const entry = { fn: f.fn === '{closure}' ? 'closure' : f.fn, line: f.line };
    if (i < FULL_FRAMES) {
      if (f.index !== 0) await dbg.cmd(`frame ${f.index}`);
      const raw = await dbg.cmd('ev LV::snap(get_defined_vars())');
      try { entry.locals = JSON.parse(raw.trim().split('\n').pop()); } catch { entry.locals = {}; }
      if (f.index !== 0) await dbg.cmd('frame 0');
    }
    stack.push(entry);
  }
  steps.push({ line: stack[stack.length - 1].line, event, stack, out, ...extra });
}

export const php = {
  id: 'php',
  name: 'PHP',
  requires: ['php', 'phpdbg'],
  memVia: 'heap',

  async build(code, sig) {
    const { file, dir } = await prepare(code);
    return { cmd: 'php', args: ['-d', 'memory_limit=2G', ...driverArgs('serve', file, sig)], cwd: dir };
  },

  async trace({ code, sig, args, maxSteps }) {
    let prep;
    try {
      prep = await prepare(code);
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    return tracePhp(prep, sig, args, maxSteps);
  },
};
