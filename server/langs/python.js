// Python on the server: only used when Compare / Find bugs mixes Python with other languages
// (the browser runs Python on its own through Pyodide). Uses the same engine/tracer.py.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached } from '../lib/build.js';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'driver.py');

function pyAdapter(id, name) {
  return {
    id, name,
    requires: ['python3'],
    memVia: 'heap',

    async build(code, sig) {
      const { file } = await cached(id, [code], async (dir) => {
        const f = path.join(dir, 'solution.py');
        await writeFile(f, code);
        return { file: f };
      });
      return { cmd: 'python3', args: [DRIVER, 'serve', file, sig.method, ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'] };
    },

    async trace({ code, sig, args, maxSteps }) {
      const types = Object.fromEntries(sig.params.map((p) => [p.name, p.type]));
      const r = await run('python3', [DRIVER, 'trace'], {
        input: JSON.stringify({ code, method: sig.method, args, maxSteps, types, voidReturn: sig.ret.k === 'void' }), timeout: 120000,
      });
      if (r.code !== 0) throw new Error(`Python failed: ${r.stderr.trim().split('\n').pop()}`);
      return JSON.parse(r.stdout);
    },
  };
}

export const python3 = pyAdapter('python3', 'Python3');
export const python = pyAdapter('python', 'Python');
