// C#: compiled with Roslyn's csc (from the .NET SDK) against the reference assemblies; one
// reflection-based driver (csharp/LvMain.cs). Tracing uses an instrumented build: LvInstrument.cs
// (Roslyn again) inserts trace probes that record exactly the definitely-assigned variables, so no
// debugger is needed (netcoredbg can't evaluate calls that take generic or object arguments).
import { writeFile, readFile, rm, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, CompileError } from '../lib/build.js';
import { encodeArgs, plainToSer } from '../lib/types.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'csharp');
const USINGS = 'using System; using System.Collections.Generic; using System.Linq; using System.Text; using System.Numerics; ';

function dotnetRoot() {
  if (process.env.DOTNET_ROOT && existsSync(process.env.DOTNET_ROOT)) return process.env.DOTNET_ROOT;
  for (const dir of (process.env.PATH || '').split(':')) if (existsSync(path.join(dir, 'dotnet'))) return dir;
  return null;
}

const newest = async (dir) => (await readdir(dir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();

let sdkJob = null;
function sdk() {
  sdkJob ||= (async () => {
    const root = dotnetRoot();
    if (!root) throw new Error('.NET SDK not found');
    const sdkVer = await newest(path.join(root, 'sdk'));
    const refVer = await newest(path.join(root, 'packs', 'Microsoft.NETCore.App.Ref'));
    const tfmDir = path.join(root, 'packs', 'Microsoft.NETCore.App.Ref', refVer, 'ref');
    const tfm = await newest(tfmDir);
    const refDir = path.join(tfmDir, tfm);
    const refs = (await readdir(refDir)).filter((f) => f.endsWith('.dll')).map((f) => path.join(refDir, f));
    const runtimeVer = await newest(path.join(root, 'shared', 'Microsoft.NETCore.App'));
    const roslyn = path.join(root, 'sdk', sdkVer, 'Roslyn', 'bincore');
    return { root, csc: path.join(roslyn, 'csc.dll'), roslyn, refs, tfm, runtimeVer };
  })().catch((e) => { sdkJob = null; throw e; });
  return sdkJob;
}

const runtimeConfig = (s) => JSON.stringify({ runtimeOptions: { tfm: s.tfm, framework: { name: 'Microsoft.NETCore.App', version: s.runtimeVer } } });

async function csc(s, out, sources, { optimize, extraRefs = [], cwd }) {
  const args = [s.csc, '-nologo', '-noconfig', '-langversion:latest', '-nullable:disable', '-unsafe+', '-nowarn:CS0162,CS0168,CS0219,CS8321',
    optimize ? '-optimize+' : '-optimize-', '-debug:portable', '-target:exe', `-out:${out}`,
    ...[...s.refs, ...extraRefs].map((r) => `-r:${r}`), ...sources];
  const r = await run('dotnet', args, { cwd, timeout: 180000 });
  await writeFile(out.replace(/\.dll$/, '.runtimeconfig.json'), runtimeConfig(s));
  return r;
}

/** The Roslyn-based instrumenter, built once per SDK. */
let instrumenterJob = null;
function instrumenter() {
  instrumenterJob ||= (async () => {
    const s = await sdk();
    const src = await readFile(path.join(HERE, 'LvInstrument.cs'), 'utf8');
    return cached('csharp-instrumenter', [src, s.csc], async (dir) => {
      const roslynDlls = ['Microsoft.CodeAnalysis.dll', 'Microsoft.CodeAnalysis.CSharp.dll'];
      for (const d of roslynDlls) await copyFile(path.join(s.roslyn, d), path.join(dir, d));
      const out = path.join(dir, 'lvinstrument.dll');
      const r = await csc(s, out, [path.join(HERE, 'LvInstrument.cs')], { optimize: true, extraRefs: roslynDlls.map((d) => path.join(dir, d)), cwd: dir });
      if (r.code !== 0) throw new Error(`Couldn't build the C# instrumenter: ${r.stdout.trim().split('\n').slice(0, 3).join(' ')}`);
      await writeFile(path.join(dir, 'refs.txt'), s.refs.join('\n'));
      return { dll: out, refs: path.join(dir, 'refs.txt') };
    });
  })().catch((e) => { instrumenterJob = null; throw e; });
  return instrumenterJob;
}

async function compile(code, mode) {
  const s = await sdk();
  const driver = await readFile(path.join(HERE, 'LvMain.cs'), 'utf8');
  const tool = mode === 'trace' ? await instrumenter() : null;
  return cached('csharp', [code, driver, mode, s.csc, tool && (await readFile(path.join(HERE, 'LvInstrument.cs'), 'utf8'))], async (dir) => {
    const user = path.join(dir, 'Solution.cs');
    await writeFile(user, USINGS + code);
    await writeFile(path.join(dir, 'LvMain.cs'), driver);
    const out = path.join(dir, 'prog.dll');
    let r = await csc(s, out, [user, 'LvMain.cs'], { optimize: mode !== 'trace', cwd: dir });
    if (r.code !== 0) throw compileError(r.stdout, 'Solution.cs', { lineRe: /Solution\.cs\((\d+),/ });
    if (mode === 'trace') {
      // Same file name, so stack traces and errors point at the user's lines.
      const plain = path.join(dir, 'plain');
      await mkdir(plain);
      await copyFile(user, path.join(plain, 'Solution.cs'));
      const ir = await run('dotnet', [tool.dll, path.join(plain, 'Solution.cs'), user, tool.refs, path.join(dir, 'LvMain.cs')], { cwd: dir, timeout: 120000 });
      if (ir.code !== 0) throw new Error(`Couldn't instrument the code: ${(ir.stderr || ir.stdout).trim().split('\n').slice(0, 2).join(' ')}`);
      r = await csc(s, out, [user, 'LvMain.cs'], { optimize: false, cwd: dir });
      if (r.code !== 0) {
        throw new Error(`Tracing isn't available for this code yet (instrumentation failed: ${r.stdout.trim().split('\n').find((l) => /error/.test(l)) || 'compile error'})`);
      }
    }
    return { dir, dll: out };
  });
}

const driverArgs = (mode, sig) => [mode, sig.method, ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];

export const csharp = {
  id: 'csharp',
  name: 'C#',
  requires: ['dotnet'],
  memVia: 'allocations',

  async build(code, sig) {
    const { dll, dir } = await compile(code, 'serve');
    return { cmd: 'dotnet', args: [dll, ...driverArgs('serve', sig)], cwd: dir, stack: false };
  },

  crashMessage(e) {
    if (/Stack overflow/i.test(e.stderr || '')) return 'Stack overflow (recursion too deep — missing base case?)';
    return null;
  },

  async trace({ code, sig, args, maxSteps }) {
    let built;
    try {
      built = await compile(code, 'trace');
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    const dir = await scratch('csharp');
    try {
      const env = { LV_INPUT: path.join(dir, 'in.txt'), LV_STDOUT: path.join(dir, 'stdout.txt'), LV_RESULT: path.join(dir, 'result.json'), LV_MAX_STEPS: String(maxSteps) };
      await writeFile(env.LV_INPUT, encodeArgs(args, sig.params.map((p) => p.t)));
      const r = await run('dotnet', [built.dll, ...driverArgs('trace', sig)], { cwd: built.dir, env, timeout: 120000, stack: false });
      let result;
      try {
        result = JSON.parse(await readFile(env.LV_RESULT, 'utf8'));
      } catch {
        if (/Stack overflow/i.test(r.stderr)) return { steps: [], error: 'Stack overflow (recursion too deep — missing base case?)' };
        throw new Error(r.timedOut ? 'Tracing took too long.' : `C# failed: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' · ')}`);
      }
      if (result.returnPlain !== undefined) {
        try { result.returnValue = plainToSer(JSON.parse(result.returnPlain)); } catch {}
      }
      result.stdout = (await readFile(env.LV_STDOUT, 'utf8').catch(() => '')).slice(0, 20000);
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
