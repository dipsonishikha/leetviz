// Ruby: traces itself with TracePoint (ruby/driver.rb), no external debugger needed.
import { writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, scratch, CompileError } from '../lib/build.js';
import { encodeArgs, snake, plainToSer } from '../lib/types.js';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ruby', 'driver.rb');

async function prepare(code) {
  return cached('ruby', [code], async (dir) => {
    const file = path.join(dir, 'solution.rb');
    await writeFile(file, code);
    const r = await run('ruby', ['-c', file], { timeout: 30000 });
    if (r.code !== 0) {
      const m = r.stderr.match(/solution\.rb:(\d+)/);
      const msg = r.stderr.replace(/^.*solution\.rb:\d+:\s*/m, '').split('\n')[0].trim();
      throw new CompileError(`Syntax error${m ? ` on line ${m[1]}` : ''}: ${msg}`, m ? +m[1] : null);
    }
    return { dir, file };
  });
}

const driverArgs = (mode, file, sig) => [DRIVER, mode, file, snake(sig.method), ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];

export const ruby = {
  id: 'ruby',
  name: 'Ruby',
  requires: ['ruby'],
  memVia: 'allocations',

  async build(code, sig) {
    const { file, dir } = await prepare(code);
    return { cmd: 'ruby', args: driverArgs('serve', file, sig), cwd: dir };
  },

  async trace({ code, sig, args, maxSteps }) {
    let prep;
    try {
      prep = await prepare(code);
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    const dir = await scratch('ruby');
    try {
      const req = { tokens: encodeArgs(args, sig.params.map((p) => p.t)), maxSteps, out: path.join(dir, 'trace.json'), stdout: path.join(dir, 'stdout.txt') };
      const r = await run('ruby', driverArgs('trace', prep.file, sig), { cwd: prep.dir, input: JSON.stringify(req), timeout: 120000 });
      let result;
      try {
        result = JSON.parse(await readFile(req.out, 'utf8'));
      } catch {
        const err = r.stdout.match(/\u0001LV (.*)/)?.[1];
        if (err) return { steps: [], error: JSON.parse(err).err };
        throw new Error(r.timedOut ? 'Tracing took too long.' : `Ruby failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' · ')}`);
      }
      if (result.returnPlain) result.returnValue = plainToSer(JSON.parse(result.returnPlain));
      result.stdout = (await readFile(req.stdout, 'utf8').catch(() => '')).slice(0, 20000);
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
