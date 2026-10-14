// Dart: a generated driver (typed readers from the solution's own signature; Dart has no runtime
// reflection in compiled executables), `dart compile exe` for timing, and the Dart VM service
// (JSON-RPC over WebSocket, dart/tracer.mjs) for tracing.
import { writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, CompileError } from '../lib/build.js';
import { encodeArgs } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';
import { nodeBin } from './js.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dart');
const PRELUDE = "import 'dart:math'; import 'dart:collection'; import 'nodes.dart'; import 'lv_ser.dart'; ";

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** The user's `Ret name(T a, U b)`: parameter types and the return type. */
function userSignature(code, method) {
  const m = code.match(new RegExp(`([\\w<>?, \\[\\]]+?)\\s+${method}\\s*\\(`));
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let inner = '';
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    if (c === ')') { if (depth === 0) break; depth--; }
    inner += c;
  }
  const params = splitTop(inner.replace(/[[\]{}]/g, ' ')).map((p) => {
    const words = p.trim().replace(/^(final|required|covariant)\s+/, '').split(/\s+/);
    words.pop(); // the parameter name
    return words.join(' ').replace(/\s*([<>,?])\s*/g, '$1');
  });
  return { params, ret: m[1].trim().split(/\s+/).pop() };
}

function reader(type) {
  const t = type.trim();
  const base = t.endsWith('?') ? t.slice(0, -1) : t;
  if (base === 'int') return 'r.i()';
  if (base === 'double' || base === 'num') return 'r.d()';
  if (base === 'bool') return 'r.b()';
  if (base === 'String') return 'r.s()';
  if (base === 'ListNode') return 'r.listNode()';
  if (base === 'TreeNode') return 'r.tree()';
  const m = base.match(/^List<(.+)>$/);
  if (m) return `r.list<${m[1]}>(() => ${reader(m[1])})`;
  throw new CompileError(`Dart: unsupported parameter type ${type}`);
}

const MAIN = String.raw`import 'dart:convert';
import 'dart:io';
import 'nodes.dart';
import 'lv_ser.dart';
import 'solution.dart';

class LvIn {
  final List<String> toks;
  int pos = 0;
  LvIn(String line) : toks = line.trim().split(RegExp(r' +')).where((t) => t.isNotEmpty).toList();
  String tok() => toks[pos++];
  int i() => int.parse(tok());
  double d() => double.parse(tok());
  bool b() => tok() == '1';
  String s() => Uri.decodeComponent(tok().substring(1));
  List<T> list<T>(T Function() f) { final n = i(); return List<T>.generate(n, (_) => f()); }
  ListNode? listNode() {
    final n = i();
    final vals = List<int>.generate(n, (_) => i());
    ListNode? head;
    for (final v in vals.reversed) head = ListNode(v, head);
    return head;
  }
  TreeNode? tree() {
    final n = i();
    final t = List<String>.generate(n, (_) => tok());
    if (n == 0 || t[0] == '#') return null;
    final root = TreeNode(int.parse(t[0]));
    final q = <TreeNode>[root];
    var h = 0, k = 1;
    while (h < q.length && k < n) {
      final node = q[h++];
      if (k < n && t[k] != '#') { node.left = TreeNode(int.parse(t[k])); q.add(node.left!); }
      k++;
      if (k < n && t[k] != '#') { node.right = TreeNode(int.parse(t[k])); q.add(node.right!); }
      k++;
    }
    return root;
  }
}
`;

function driver(code, sig) {
  const us = userSignature(code, sig.method);
  if (!us) throw new CompileError(`Couldn't find ${sig.method}(...) in your Dart code.`);
  if (us.params.length !== sig.params.length) throw new CompileError(`${sig.method} should take ${sig.params.length} parameter(s).`);
  const isVoid = sig.ret.k === 'void' || us.ret === 'void';
  const decls = us.params.map((t, i) => `final ${t} a${i} = ${reader(t)};`).join(' ');
  const call = `sol.${sig.method}(${us.params.map((_, i) => `a${i}`).join(', ')})`;
  return `${MAIN}
double lvRun(String line, StringBuffer? out) {
  final r = LvIn(line);
  ${decls}
  final sol = Solution();
  final sw = Stopwatch()..start();
  ${isVoid ? `${call};` : `final res = ${call};`}
  sw.stop();
  if (out != null) { out.clear(); out.write(jsonEncode(lvPlain(${isVoid ? 'a0' : 'res'}))); }
  return sw.elapsedMicroseconds / 1e6;
}

String lvErr(Object e) => e is StackOverflowError ? 'StackOverflowError (recursion too deep — missing base case?)' : '\${e.runtimeType}: \$e';

void main(List<String> args) {
  if (args.isNotEmpty && args[0] == 'trace') {
    final line = stdin.readLineSync() ?? '';
    final out = StringBuffer();
    lvRun(line, out); // unhandled errors pause the VM service tracer
    stdout.writeln('\\n\\u0001LV \$out');
    return;
  }
  String? line;
  while ((line = stdin.readLineSync()) != null) {
    final parts = line!.trim().split(' ');
    final minTime = double.parse(parts[0]);
    final maxRuns = int.parse(parts[1]);
    final rest = parts.skip(3).join(' ');
    String reply;
    try {
      var total = 0.0, runs = 0;
      final out = StringBuffer();
      do { total += lvRun(rest, out); runs++; } while (runs < maxRuns && total < minTime);
      reply = '{"t":\${total / runs},"runs":\$runs,"mem":-1,"depth":-1,"out":\$out}';
    } catch (e) {
      reply = jsonEncode({'err': lvErr(e)});
    }
    stdout.writeln('\\u0001LV \$reply');
  }
}
`;
}

async function prepare(code, sig, mode) {
  const main = driver(code, sig);
  const files = await Promise.all(['nodes.dart', 'lv_ser.dart'].map((f) => readFile(path.join(HERE, f), 'utf8')));
  return cached('dart', [code, main, files, mode], async (dir) => {
    await writeFile(path.join(dir, 'solution.dart'), PRELUDE + code);
    await writeFile(path.join(dir, 'main.dart'), main);
    for (const f of ['nodes.dart', 'lv_ser.dart']) await copyFile(path.join(HERE, f), path.join(dir, f));
    if (mode === 'serve') {
      const r = await run('dart', ['compile', 'exe', '-o', 'prog', 'main.dart'], { cwd: dir, timeout: 240000 });
      if (r.code !== 0) throw compileError(r.stdout + r.stderr, 'solution.dart', { lineRe: /solution\.dart:(\d+)/ });
    } else {
      const r = await run('dart', ['analyze', '--no-fatal-warnings', '--no-fatal-infos', 'solution.dart'], { cwd: dir, timeout: 120000 });
      const err = (r.stdout + r.stderr).split('\n').find((l) => /^\s*error/.test(l));
      if (err) {
        const m = err.match(/solution\.dart:(\d+)/);
        throw new CompileError(`Compile error${m ? ` on line ${m[1]}` : ''}: ${err.replace(/^\s*error\s*-\s*/, '').replace(/\s*-\s*\S+$/, '').trim()}`, m ? +m[1] : null);
      }
    }
    return { dir };
  });
}

export const dart = {
  id: 'dart',
  name: 'Dart',
  requires: ['dart'],
  memVia: null,

  async build(code, sig) {
    const { dir } = await prepare(code, sig, 'serve');
    return { cmd: path.join(dir, 'prog'), args: [], cwd: dir };
  },

  async trace({ code, sig, args, maxSteps }) {
    let prep;
    try {
      prep = await prepare(code, sig, 'trace');
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    const dir = await scratch('dart');
    try {
      const cfg = { dir: prep.dir, method: sig.method, maxSteps, input: encodeArgs(args, sig.params.map((p) => p.t)) + '\n', out: path.join(dir, 'trace.json') };
      await writeFile(path.join(dir, 'cfg.json'), JSON.stringify(cfg));
      const r = await run(nodeBin(), [path.join(HERE, 'tracer.mjs'), path.join(dir, 'cfg.json')], { timeout: 180000 });
      let result;
      try {
        result = JSON.parse(await readFile(cfg.out, 'utf8'));
      } catch {
        throw new Error(r.timedOut ? 'Tracing took too long.' : `Tracer failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' · ')}`);
      }
      const stdout = result.rawStdout || '';
      delete result.rawStdout;
      return finishTrace(result, stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
