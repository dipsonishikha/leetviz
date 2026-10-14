// JavaScript and TypeScript: run by Node (TypeScript through Node's built-in type stripping,
// which replaces types with spaces so line numbers stay exact), traced over the inspector protocol.
import { writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, scratch, CompileError } from '../lib/build.js';
import { encodeArgs } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'js');
const DRIVER = path.join(HERE, 'driver.cjs');

/** A Node new enough to strip TypeScript types (23.6+); the toolchain's if the system's is older. */
export function nodeBin() {
  if (process.env.LEETVIZ_NODE) return process.env.LEETVIZ_NODE;
  const tc = process.env.LV_TC && path.join(process.env.LV_TC, 'root', 'envs', 'lv', 'bin', 'node');
  const major = +process.versions.node.split('.')[0];
  if (major >= 24) return process.execPath;
  return tc && existsSync(tc) ? tc : process.execPath;
}

async function prepare(lang, code, sig) {
  // `var twoSum = function ...` / `function twoSum(...)`: export it without moving any line.
  const ext = lang === 'typescript' ? 'cts' : 'cjs';
  return cached(lang, [code, sig.method, nodeBin(), 2], async (dir) => {
    const file = path.join(dir, `solution.${ext}`);
    const exportLine = `\n;module.exports = (typeof ${sig.method} !== 'undefined') ? ${sig.method} : (typeof Solution !== 'undefined' ? new Solution() : undefined);\n`;
    await writeFile(file, code + exportLine);
    // Syntax check (and type stripping) up front so errors come back as compile errors.
    const r = await run(nodeBin(), ['-e', 'require(process.argv[1])', file], { timeout: 30000 });
    if (r.code !== 0) {
      const err = r.stderr;
      const m = err.match(new RegExp(`solution\\.${ext}:(\\d+)`));
      const msg = (err.split('\n').find((l) => /Error/.test(l)) || err.trim().split('\n').pop() || 'Syntax error').trim();
      throw new CompileError(`${msg}${m ? ` (line ${m[1]})` : ''}`, m ? +m[1] : null);
    }
    return { dir, file };
  });
}

const driverArgs = (mode, file, sig) => [mode, file, sig.method, ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];

function jsAdapter(lang) {
  return {
    id: lang,
    name: lang === 'typescript' ? 'TypeScript' : 'JavaScript',
    requires: ['node'],
    memVia: 'heap',

    async build(code, sig) {
      const { file, dir } = await prepare(lang, code, sig);
      return { cmd: nodeBin(), args: ['--expose-gc', '--stack-size=50000', DRIVER, ...driverArgs('serve', file, sig)], cwd: dir };
    },

    async trace({ code, sig, args, maxSteps }) {
      let prep;
      try {
        prep = await prepare(lang, code, sig);
      } catch (e) {
        if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
        throw e;
      }
      const dir = await scratch(lang);
      try {
        const out = path.join(dir, 'trace.json');
        const r = await run(nodeBin(), ['--stack-size=50000', DRIVER, ...driverArgs('trace', prep.file, sig)], {
          cwd: prep.dir, timeout: 180000,
          input: encodeArgs(args, sig.params.map((p) => p.t)) + '\n',
          env: { LV_TRACE: JSON.stringify({ out, maxSteps }) },
        });
        let result;
        try {
          result = JSON.parse(await readFile(out, 'utf8'));
        } catch {
          throw new Error(r.timedOut ? 'Tracing took too long.' : `Tracer failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' · ')}`);
        }
        return finishTrace(result, r.stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const javascript = jsAdapter('javascript');
export const typescript = jsAdapter('typescript');
