// Child-process helpers: one-shot runs with a timeout, and long-lived line-protocol workers.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Run `sh -c` style with resource limits applied first (stack size for deep recursion). */
function limited(cmd, args, { stack = true } = {}) {
  if (!stack) return [cmd, args];
  const pre = 'ulimit -s unlimited 2>/dev/null || ulimit -s 1048576 2>/dev/null; exec "$@"';
  return ['sh', ['-c', pre, 'sh', cmd, ...args]];
}

/**
 * Run a command to completion.
 * @returns {Promise<{code, signal, stdout, stderr, timedOut, ms}>}
 */
export function run(cmd, args = [], { cwd, env, input, timeout = 60000, stack = true } = {}) {
  const [c, a] = limited(cmd, args, { stack });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(c, a, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeout);
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - t0 });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Kill a child and everything it started (compilers and debuggers spawn helpers). */
export function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

/**
 * A long-lived process speaking one-line-request / one-line-reply.
 * request() resolves with the reply line, or rejects with {crashed|timedOut, stderr}.
 * After a crash or timeout the next request transparently restarts the process.
 */
export class LineWorker {
  constructor(cmd, args, { cwd, env, stack = true } = {}) {
    Object.assign(this, { cmd, args, cwd, env, stack });
    this.child = null;
  }

  start() {
    const [c, a] = limited(this.cmd, this.args, { stack: this.stack });
    const child = spawn(c, a, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child = child;
    this.stderr = '';
    this.waiting = null;
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-20000); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { this.stderr += String(e); });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      // Drivers prefix protocol replies so user print()s in serve mode can't be mistaken for one.
      if (!line.startsWith('\u0001LV ')) return;
      const w = this.waiting;
      this.waiting = null;
      w?.resolve(line.slice(4));
    });
    child.on('close', (code, signal) => {
      if (this.child === child) this.child = null;
      const w = this.waiting;
      this.waiting = null;
      w?.reject({ crashed: true, code, signal, stderr: this.stderr });
    });
  }

  request(line, timeout) {
    if (!this.child) this.start();
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject({ timedOut: true, stderr: this.stderr });
        kill(child);
      }, timeout);
      this.waiting = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      child.stdin.write(line + '\n');
    });
  }

  close() {
    kill(this.child);
    this.child = null;
  }
}
