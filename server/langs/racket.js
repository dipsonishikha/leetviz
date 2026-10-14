// Racket: racket/lv.rkt evaluates the solution in a `racket` namespace. Tracing is per function
// call: every function the solution defines is wrapped to record its arguments and result.
import { writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, scratch } from '../lib/build.js';
import { encodeArgs, kebab, plainToSer } from '../lib/types.js';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'racket', 'lv.rkt');

async function prepare(code) {
  return cached('racket', [code], async (dir) => {
    const file = path.join(dir, 'solution.rkt');
    // LeetCode's editor holds only the module body (no #lang line).
    await writeFile(file, code.replace(/^\s*#lang\s+\S+/, (m) => ' '.repeat(m.length)));
    return { dir, file };
  });
}

const driverArgs = (mode, file, sig) => [DRIVER, mode, file, kebab(sig.method), ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];

export const racket = {
  id: 'racket',
  name: 'Racket',
  requires: ['racket'],
  memVia: null,
  traceLevel: 'calls',

  async build(code, sig) {
    const { file, dir } = await prepare(code);
    return { cmd: 'racket', args: driverArgs('serve', file, sig), cwd: dir };
  },

  async trace({ code, sig, args, maxSteps }) {
    const { file, dir: buildDir } = await prepare(code);
    const dir = await scratch('racket');
    try {
      const req = { tokens: encodeArgs(args, sig.params.map((p) => p.t)), maxSteps, out: path.join(dir, 'trace.json'), stdout: path.join(dir, 'stdout.txt') };
      const r = await run('racket', driverArgs('trace', file, sig), { cwd: buildDir, input: JSON.stringify(req), timeout: 120000 });
      let result;
      try {
        result = JSON.parse(await readFile(req.out, 'utf8'));
      } catch {
        throw new Error(r.timedOut ? 'Tracing took too long.' : `Racket failed: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 2).join(' · ')}`);
      }
      if (result.error && !result.steps.length) {
        const m = result.error.match(/solution\.rkt:(\d+)/);
        if (m) result.errorLine = +m[1];
      }
      if (result.returnPlain) result.returnValue = plainToSer(JSON.parse(result.returnPlain));
      result.stdout = (await readFile(req.stdout, 'utf8').catch(() => '')).slice(0, 20000);
      result.note = 'Racket is traced call by call: each step is a function being called or returning.';
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
