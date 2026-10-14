// Java, Kotlin and Scala: one reflection-based driver (jvm/LvMain.java) and one JDI step tracer
// (jvm/JdiTracer.java) serve all three; only compiling the user's file differs.
import { writeFile, readFile, rm, mkdir, cp } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, hash, ROOT, CompileError } from '../lib/build.js';
import { encodeArgs } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jvm');

const javaHome = () => process.env.JAVA_HOME || path.dirname(path.dirname(process.env.LEETVIZ_JAVA || '/usr/bin/java'));
const javaBin = (tool) => {
  const p = path.join(javaHome(), 'bin', tool);
  return existsSync(p) ? p : tool;
};

/** LvMain + JdiTracer + ListNode/TreeNode/Pair, compiled once per JDK. */
let runtimeJob = null;
function runtime() {
  runtimeJob ||= (async () => {
    const files = ['LvMain.java', 'JdiTracer.java', 'runtime/ListNode.java', 'runtime/TreeNode.java', 'runtime/javafx/util/Pair.java'];
    const sources = await Promise.all(files.map((f) => readFile(path.join(HERE, f), 'utf8')));
    return cached('jvm-runtime', [sources, javaHome()], async (dir) => {
      const r = await run(javaBin('javac'), ['-g', '-encoding', 'UTF-8', '-d', dir, ...files.map((f) => path.join(HERE, f))], { timeout: 120000 });
      if (r.code !== 0) throw new Error(`Couldn't build the JVM driver: ${r.stderr.trim().split('\n').slice(0, 3).join(' ')}`);
      return dir;
    });
  })().catch((e) => { runtimeJob = null; throw e; });
  return runtimeJob;
}

// ------------------------------------------------------------------ per-language compile

const JAVA_IMPORTS = 'import java.util.*; import java.util.function.*; import java.util.stream.*; import java.math.*; import javafx.util.Pair; ';

function kotlinStdlib() {
  for (const dir of (process.env.PATH || '').split(':')) {
    const lib = path.join(dir, '..', 'lib', 'kotlin-stdlib.jar');
    if (dir && existsSync(path.join(dir, 'kotlinc')) && existsSync(lib)) return path.resolve(lib);
  }
  return null;
}

let scalaLibJob = null;
function scalaLibrary() {
  // The Scala 3 standard library jars, from coursier (installed next to scalac).
  scalaLibJob ||= (async () => {
    const r = await run('scalac', ['-version'], { timeout: 120000 });
    const ver = (r.stdout + r.stderr).match(/version (\d+\.\d+\.\d+)/)?.[1];
    if (!ver) throw new Error('Couldn\'t find the Scala version');
    const cs = await run('cs', ['fetch', '--classpath', `org.scala-lang:scala3-library_3:${ver}`], { timeout: 300000 });
    if (cs.code !== 0) throw new Error(`Couldn't fetch the Scala library: ${cs.stderr.trim().split('\n').pop()}`);
    return cs.stdout.trim();
  })().catch((e) => { scalaLibJob = null; throw e; });
  return scalaLibJob;
}

const LANG = {
  java: {
    name: 'Java', file: 'Solution.java', requires: ['javac', 'java'],
    async compile(code, dir, rt) {
      await writeFile(path.join(dir, 'Solution.java'), JAVA_IMPORTS + code);
      const r = await run(javaBin('javac'), ['-g', '-encoding', 'UTF-8', '-nowarn', '-cp', rt, '-d', path.join(dir, 'out'), path.join(dir, 'Solution.java')], { timeout: 120000 });
      if (r.code !== 0) throw compileError(r.stderr, 'Solution.java');
      return [rt, path.join(dir, 'out')];
    },
  },
  kotlin: {
    name: 'Kotlin', file: 'Solution.kt', requires: ['kotlinc', 'java'],
    async compile(code, dir, rt) {
      await writeFile(path.join(dir, 'Solution.kt'), code);
      const r = await run('kotlinc', ['-nowarn', '-jvm-target', '21', '-cp', rt, '-d', path.join(dir, 'out'), path.join(dir, 'Solution.kt')], { timeout: 240000, env: { JAVA_HOME: javaHome() } });
      if (r.code !== 0) throw compileError(r.stderr, 'Solution.kt', { lineRe: /Solution\.kt:(\d+)/ });
      const std = kotlinStdlib();
      if (!std) throw new Error('kotlin-stdlib.jar not found next to kotlinc');
      return [rt, path.join(dir, 'out'), std];
    },
  },
  scala: {
    name: 'Scala', file: 'Solution.scala', requires: ['scalac', 'java', 'cs'],
    async compile(code, dir, rt) {
      await writeFile(path.join(dir, 'Solution.scala'), code);
      await cp(path.join(HERE, 'runtime', 'Nodes.scala'), path.join(dir, 'Nodes.scala'));
      const lib = await scalaLibrary();
      const r = await run('scalac', ['-nowarn', '-source:3.0-migration', '-classpath', lib, '-d', path.join(dir, 'out'), path.join(dir, 'Nodes.scala'), path.join(dir, 'Solution.scala')], { timeout: 240000, env: { JAVA_HOME: javaHome() } });
      if (r.code !== 0) throw compileError(r.stdout + r.stderr, 'Solution.scala', { lineRe: /Solution\.scala:(\d+)/ });
      // The driver (and the tracer's class filters) must see Scala's ListNode, not the Java one.
      return [path.join(dir, 'out'), rt, lib];
    },
  },
};

async function compile(lang, code) {
  const rt = await runtime();
  return cached(lang, [code, rt, 2], async (dir) => {
    await mkdir(path.join(dir, 'out'), { recursive: true });
    const cp = await LANG[lang].compile(code, dir, rt);
    return { dir, classpath: cp.join(':') };
  });
}

function driverArgs(mode, sig) {
  return [mode, sig.method, ...sig.params.map((p) => p.type), '->', sig.ret.k === 'void' ? 'void' : 'value'];
}

function jvmAdapter(lang) {
  const L = LANG[lang];
  return {
    id: lang,
    name: L.name,
    requires: L.requires,
    memVia: 'allocations',
    measureNote: null,

    async build(code, sig, mode) {
      const { classpath } = await compile(lang, code);
      return { cmd: javaBin('java'), args: ['-Xss512m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=4', '-cp', classpath, 'LvMain', ...driverArgs('serve', sig)], stack: false };
    },

    async trace({ code, sig, args, maxSteps }) {
      let built;
      try {
        built = await compile(lang, code);
      } catch (e) {
        if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
        throw e;
      }
      const rt = await runtime();
      const dir = await scratch(lang);
      try {
        const files = { out: path.join(dir, 'trace.json'), stdout: path.join(dir, 'stdout.txt'), input: path.join(dir, 'in.txt') };
        await writeFile(files.input, encodeArgs(args, sig.params.map((p) => p.t)) + '\n');
        const r = await run(javaBin('java'), ['-cp', rt, 'JdiTracer', files.out, files.stdout, files.input, String(maxSteps), L.file,
          javaHome(), built.classpath, ...driverArgs('trace', sig)], { timeout: 180000, stack: false });
        let result;
        try {
          result = JSON.parse(await readFile(files.out, 'utf8'));
        } catch {
          throw new Error(r.timedOut ? 'Tracing took too long.' : `Debugger failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' · ')}`);
        }
        return finishTrace(result, await readFile(files.stdout, 'utf8').catch(() => ''));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const java = jvmAdapter('java');
export const kotlin = jvmAdapter('kotlin');
export const scala = jvmAdapter('scala');
