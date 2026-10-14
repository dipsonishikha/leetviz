// Erlang and Elixir: one BEAM driver (beam/lv_beam.erl). Tracing is per function call through
// the VM's built-in call tracing (erlang:trace with exception_trace): every call into the
// solution module records its arguments, every return its result.
import { writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, CompileError } from '../lib/build.js';
import { encodeArgs, snake, plainToSer } from '../lib/types.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'beam');

// LeetCode's Erlang editor has no module header and leaves the node records commented out.
const ERL_HEADER = '-module(solution). -compile([export_all, nowarn_export_all]). '
  + '-record(list_node, {val = 0 :: integer(), next = null :: \'null\' | #list_node{}}). '
  + '-record(tree_node, {val = 0 :: integer(), left = null :: \'null\' | #tree_node{}, right = null :: \'null\' | #tree_node{}}). ';

let runtimeJob = null;
function runtime() {
  runtimeJob ||= (async () => {
    const src = await readFile(path.join(HERE, 'lv_beam.erl'), 'utf8');
    return cached('beam-runtime', [src], async (dir) => {
      const r = await run('erlc', ['-o', dir, path.join(HERE, 'lv_beam.erl')], { timeout: 120000 });
      if (r.code !== 0) throw new Error(`Couldn't build the BEAM driver: ${(r.stdout + r.stderr).trim().split('\n').slice(0, 3).join(' ')}`);
      return dir;
    });
  })().catch((e) => { runtimeJob = null; throw e; });
  return runtimeJob;
}

let elixirJob = null;
function elixirEbin() {
  elixirJob ||= run('elixir', ['-e', 'IO.puts(:code.lib_dir(:elixir))'], { timeout: 60000 }).then((r) => path.join(r.stdout.trim(), 'ebin'));
  return elixirJob;
}

async function compile(lang, code) {
  const nodes = await readFile(path.join(HERE, 'lv_nodes.ex'), 'utf8');
  return cached(lang, [code, lang === 'elixir' ? nodes : ERL_HEADER], async (dir) => {
    if (lang === 'erlang') {
      await writeFile(path.join(dir, 'solution.erl'), ERL_HEADER + code);
      const r = await run('erlc', ['+debug_info', '-o', dir, 'solution.erl'], { cwd: dir, timeout: 120000 });
      if (r.code !== 0) throw compileError(r.stdout + r.stderr, 'solution.erl', { lineRe: /solution\.erl:(\d+)/ });
    } else {
      await writeFile(path.join(dir, 'solution.ex'), code);
      await copyFile(path.join(HERE, 'lv_nodes.ex'), path.join(dir, 'lv_nodes.ex'));
      const r = await run('elixirc', ['--ignore-module-conflict', '-o', dir, 'lv_nodes.ex', 'solution.ex'], { cwd: dir, timeout: 180000 });
      if (r.code !== 0) throw compileError(r.stdout + r.stderr, 'solution.ex', { lineRe: /solution\.ex:(\d+)/ });
    }
    return { dir };
  });
}

/**
 * Parameter names and definition line of every function, from the source. Each argument is
 * named after the first clause where it is a plain variable (so `find([], _T)` plus
 * `find([X | Rest], T)` gives T for the second argument); an argument that is never a variable
 * is labelled with its pattern, like `[X | Rest]`.
 */
function functionInfo(lang, code) {
  const clauses = {};
  const lines = {};
  const re = lang === 'erlang' ? /^([a-z]\w*)\s*\((.*?)\)\s*(?:when\b.*)?->/ : /^\s*defp?\s+([a-z_]\w*[?!]?)\s*\((.*?)\)\s*(?:when\b.*)?(?:,\s*do:|do\b)/;
  const isVar = lang === 'erlang' ? /^_?[A-Z]\w*$/ : /^_?[a-z]\w*$/;
  code.split('\n').forEach((text, i) => {
    const m = text.match(re);
    if (!m) return;
    if (!(m[1] in lines)) lines[m[1]] = i + 1;
    (clauses[m[1]] ||= []).push(splitArgs(m[2]).map((a) => a.trim().replace(/\s*\\\\.*$/, '')));
  });
  const names = {};
  for (const [fn, list] of Object.entries(clauses)) {
    const arity = Math.max(...list.map((c) => c.length));
    names[fn] = Array.from({ length: arity }, (_, k) => {
      const plain = list.map((c) => c[k]).find((a) => a && isVar.test(a) && !a.startsWith('_'));
      const underscored = list.map((c) => c[k]).find((a) => a && isVar.test(a));
      const pattern = list.map((c) => c[k]).find((a) => a && a !== '[]' && a.length <= 24);
      return plain || (underscored && underscored.length > 1 ? underscored.slice(1) : null) || pattern || `arg${k + 1}`;
    });
  }
  return { names, lines };
}

function splitArgs(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const erlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const erlBin = (s) => `<<${erlStr(s)}/utf8>>`;
const erlMap = (obj, val) => `#{${Object.entries(obj).map(([k, v]) => `${erlBin(k)} => ${val(v)}`).join(', ')}}`;

function beamAdapter(lang) {
  const isEx = lang === 'elixir';
  const mod = isEx ? 'Elixir.Solution' : 'solution';
  const args = (mode, sig) => ['-noshell', '-run', 'lv_beam', 'main', mode, lang, mod, snake(sig.method), ...sig.params.map((p) => p.type), '=>', sig.ret.k === 'void' ? 'void' : 'value']; // erl would take '->' as one of its own flags
  const codePath = async (dir) => ['-pa', await runtime(), '-pa', dir, ...(isEx ? ['-pa', await elixirEbin()] : [])];

  return {
    id: lang,
    name: isEx ? 'Elixir' : 'Erlang',
    requires: isEx ? ['erl', 'erlc', 'elixir', 'elixirc'] : ['erl', 'erlc'],
    memVia: null,
    traceLevel: 'calls',

    async build(code, sig) {
      const { dir } = await compile(lang, code);
      return { cmd: 'erl', args: [...await codePath(dir), ...args('serve', sig)], cwd: dir };
    },

    async trace({ code, sig, args: input, maxSteps }) {
      let built;
      try {
        built = await compile(lang, code);
      } catch (e) {
        if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
        throw e;
      }
      const dir = await scratch(lang);
      try {
        const info = functionInfo(lang, code);
        const files = { out: path.join(dir, 'trace.json'), stdout: path.join(dir, 'stdout.txt') };
        const req = `#{tokens => ${erlStr(encodeArgs(input, sig.params.map((p) => p.t)))}, max_steps => ${maxSteps}, `
          + `out => ${erlStr(files.out)}, stdout => ${erlStr(files.stdout)}, `
          + `names => ${erlMap(info.names, (ns) => `[${ns.map(erlBin).join(', ')}]`)}, lines => ${erlMap(info.lines, String)}}.`;
        const r = await run('erl', [...await codePath(built.dir), ...args('trace', sig)], { cwd: built.dir, input: req, timeout: 120000 });
        let result;
        try {
          result = JSON.parse(await readFile(files.out, 'utf8'));
        } catch {
          throw new Error(r.timedOut ? 'Tracing took too long.' : `${isEx ? 'Elixir' : 'Erlang'} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' · ')}`);
        }
        if (result.returnPlain) result.returnValue = plainToSer(JSON.parse(result.returnPlain));
        const printed = (await readFile(files.stdout, 'utf8').catch(() => '')).slice(0, 20000);
        result.stdout = printed;
        if (result.steps.length) result.steps[result.steps.length - 1].out = printed.length;
        result.note = `${isEx ? 'Elixir' : 'Erlang'} is traced call by call: each step is a function being called or returning.`;
        return result;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const erlang = beamAdapter('erlang');
export const elixir = beamAdapter('elixir');
