// C++ and C: compiled with g++/gcc, traced with gdb (native/gdb_tracer.py).
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, hash, ROOT, CompileError } from '../lib/build.js';
import { encodeArgs } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';
import { cDriver } from './native/c_driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GDB_TRACER = path.join(HERE, 'native', 'gdb_tracer.py');

// ------------------------------------------------------------------ C++ driver

const CPP_PRELUDE = String.raw`#include <bits/stdc++.h>
using namespace std;
struct ListNode { int val; ListNode *next; ListNode() : val(0), next(nullptr) {} ListNode(int x) : val(x), next(nullptr) {} ListNode(int x, ListNode *next) : val(x), next(next) {} };
struct TreeNode { int val; TreeNode *left; TreeNode *right; TreeNode() : val(0), left(nullptr), right(nullptr) {} TreeNode(int x) : val(x), left(nullptr), right(nullptr) {} TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {} };
// Heap accounting (peak extra bytes) and recursion depth for the Compare tab.
static size_t lv_cur = 0, lv_peak = 0;
static int lv_depth = 0, lv_maxdepth = 0;
static bool lv_track = false;
void* operator new(size_t n) { void* p = malloc(n + 16); if (!p) throw bad_alloc(); *(size_t*)p = n; lv_cur += n; if (lv_cur > lv_peak) lv_peak = lv_cur; return (char*)p + 16; }
void* operator new[](size_t n) { return operator new(n); }
void operator delete(void* p) noexcept { if (!p) return; char* b = (char*)p - 16; lv_cur -= *(size_t*)b; free(b); }
void operator delete[](void* p) noexcept { operator delete(p); }
void operator delete(void* p, size_t) noexcept { operator delete(p); }
void operator delete[](void* p, size_t) noexcept { operator delete(p); }
extern "C" __attribute__((no_instrument_function)) void __cyg_profile_func_enter(void*, void*) { if (lv_track && ++lv_depth > lv_maxdepth) lv_maxdepth = lv_depth; }
extern "C" __attribute__((no_instrument_function)) void __cyg_profile_func_exit(void*, void*) { if (lv_track) --lv_depth; }
`;

const CPP_IO = String.raw`
struct LvIn {
  const char* p;
  string tok() { while (*p == ' ') p++; const char* s = p; while (*p && *p != ' ') p++; return string(s, p); }
};
static string lv_unpct(const string& t) {
  string o;
  for (size_t i = 1; i < t.size(); i++) {
    if (t[i] == '%' && i + 2 < t.size()) { o += (char)stoi(t.substr(i + 1, 2), nullptr, 16); i += 2; }
    else o += t[i];
  }
  return o;
}
static void rd(LvIn& in, int& x) { x = (int)stoll(in.tok()); }
static void rd(LvIn& in, long& x) { x = stol(in.tok()); }
static void rd(LvIn& in, long long& x) { x = stoll(in.tok()); }
static void rd(LvIn& in, double& x) { x = stod(in.tok()); }
static void rd(LvIn& in, bool& x) { x = in.tok() == "1"; }
static void rd(LvIn& in, string& x) { x = lv_unpct(in.tok()); }
static void rd(LvIn& in, char& x) { string s = lv_unpct(in.tok()); x = s.empty() ? 0 : s[0]; }
template <class T> static void rd(LvIn& in, vector<T>& v) { int n = stoi(in.tok()); v.clear(); v.reserve(n); for (int i = 0; i < n; i++) { T e{}; rd(in, e); v.push_back(e); } }
static void rd(LvIn& in, ListNode*& h) { int n = stoi(in.tok()); ListNode d; ListNode* c = &d; for (int i = 0; i < n; i++) { c->next = new ListNode((int)stoll(in.tok())); c = c->next; } h = d.next; }
static void rd(LvIn& in, TreeNode*& root) {
  int n = stoi(in.tok()); vector<string> t(n); for (auto& s : t) s = in.tok();
  root = nullptr; if (!n || t[0] == "#") return;
  root = new TreeNode(stoi(t[0])); deque<TreeNode*> q{root}; int i = 1;
  while (!q.empty() && i < n) {
    TreeNode* node = q.front(); q.pop_front();
    if (i < n && t[i] != "#") { node->left = new TreeNode(stoi(t[i])); q.push_back(node->left); } i++;
    if (i < n && t[i] != "#") { node->right = new TreeNode(stoi(t[i])); q.push_back(node->right); } i++;
  }
}
static void wr(string& o, int x) { o += to_string(x); }
static void wr(string& o, long x) { o += to_string(x); }
static void wr(string& o, long long x) { o += to_string(x); }
static void wr(string& o, unsigned x) { o += to_string(x); }
static void wr(string& o, unsigned long x) { o += to_string(x); }
static void wr(string& o, unsigned long long x) { o += to_string(x); }
static void wr(string& o, double x) { if (!isfinite(x)) { o += "null"; return; } char b[40]; snprintf(b, sizeof b, "%.10g", x); o += b; }
static void wr(string& o, float x) { wr(o, (double)x); }
static void wr(string& o, bool x) { o += x ? "true" : "false"; }
static void wr(string& o, const string& s) {
  o += '"';
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  o += '"';
}
static void wr(string& o, const char* s) { wr(o, string(s ? s : "")); }
static void wr(string& o, char c) { wr(o, string(1, c)); }
template <class T> static void wr(string& o, const vector<T>& v) { o += '['; for (size_t i = 0; i < v.size(); i++) { if (i) o += ','; wr(o, (T)v[i]); } o += ']'; }
static void wr(string& o, ListNode* h) { o += '['; int k = 0; for (; h && k < 100000; h = h->next, k++) { if (k) o += ','; wr(o, h->val); } o += ']'; }
static void wr(string& o, TreeNode* root) {
  vector<TreeNode*> q{root}; vector<string> parts;
  for (size_t i = 0; i < q.size() && q.size() < 200000; i++) { if (q[i]) { parts.push_back(to_string(q[i]->val)); q.push_back(q[i]->left); q.push_back(q[i]->right); } else parts.push_back("null"); }
  while (!parts.empty() && parts.back() == "null") parts.pop_back();
  o += '['; for (size_t i = 0; i < parts.size(); i++) { if (i) o += ','; o += parts[i]; } o += ']';
}
static string lv_json_str(const string& s) { string o; wr(o, s); return o; }
`;

const CPP_TYPE = {
  int: 'int', long: 'long long', double: 'double', bool: 'bool', string: 'string', char: 'char',
  ListNode: 'ListNode*', TreeNode: 'TreeNode*',
};

function cppType(t) {
  if (t.k === 'array' || t.k === 'list') return `vector<${cppType(t.of)}>`;
  const n = CPP_TYPE[t.k];
  if (!n) throw new CompileError(`C++: unsupported parameter type ${t.k}`);
  return n;
}

function cppDriver(code, sig) {
  const decls = sig.params.map((p, i) => `${cppType(p.t)} a${i}{}; rd(in, a${i});`).join(' ');
  const args = sig.params.map((_, i) => `a${i}`).join(', ');
  const isVoid = sig.ret.k === 'void';
  const call = isVoid
    ? `auto lv_t0 = chrono::steady_clock::now(); sol.${sig.method}(${args}); auto lv_t1 = chrono::steady_clock::now(); if (out) { out->clear(); wr(*out, a0); }`
    : `auto lv_t0 = chrono::steady_clock::now(); auto lv_r = sol.${sig.method}(${args}); auto lv_t1 = chrono::steady_clock::now(); if (out) { out->clear(); wr(*out, lv_r); }`;
  return `${CPP_PRELUDE}#line 1 "solution.cpp"
${code}
#line 1 "driver.cpp"
${CPP_IO}
static long long lv_mem = -1; static int lv_dep = -1;
__attribute__((noinline)) static double lv_run(const char* p, string* out) {
  LvIn in{p}; ${decls}
  Solution sol;
  size_t base = lv_cur; lv_peak = lv_cur; lv_depth = 0; lv_maxdepth = 0; lv_track = true;
  ${call}
  lv_track = false; lv_mem = (long long)(lv_peak - base); lv_dep = lv_maxdepth;
  return chrono::duration<double>(lv_t1 - lv_t0).count();
}
int main(int argc, char** argv) {
  string line;
  if (argc > 1 && string(argv[1]) == "trace") {
    setvbuf(stdout, nullptr, _IONBF, 0); cout << unitbuf;
    getline(cin, line); string out;
    lv_run(line.c_str(), &out);
    printf("\\n\\001LV %s\\n", out.c_str());
    return 0;
  }
  while (getline(cin, line)) {
    LvIn in{line.c_str()};
    double minTime = stod(in.tok()); int maxRuns = stoi(in.tok()); in.tok();
    string out; double total = 0; int runs = 0;
    try {
      do { total += lv_run(in.p, &out); runs++; } while (runs < maxRuns && total < minTime);
    } catch (const exception& e) { printf("\\001LV {\\"err\\":%s}\\n", lv_json_str(string("Exception: ") + e.what()).c_str()); fflush(stdout); continue; }
      catch (...) { printf("\\001LV {\\"err\\":\\"Exception thrown\\"}\\n"); fflush(stdout); continue; }
    printf("\\001LV {\\"t\\":%.9g,\\"runs\\":%d,\\"mem\\":%lld,\\"depth\\":%d,\\"out\\":%s}\\n", total / runs, runs, lv_mem, lv_dep, out.c_str());
    fflush(stdout);
  }
}
`;
}

// ------------------------------------------------------------------ building

const CXX = () => process.env.LEETVIZ_CXX || 'g++';
const CC = () => process.env.LEETVIZ_CC || 'gcc';

const FLAGS = {
  cpp: {
    trace: ['-std=gnu++20', '-g', '-O0', '-fno-inline', '-D_GLIBCXX_ASSERTIONS', '-w'],
    serve: ['-std=gnu++20', '-O2', '-D_GLIBCXX_ASSERTIONS', '-finstrument-functions', '-finstrument-functions-exclude-file-list=include/,driver.cpp', '-w'],
  },
  c: {
    trace: ['-std=gnu17', '-g', '-O0', '-fno-inline', '-DLV_TRACE', '-w'],
    serve: ['-std=gnu17', '-O2', '-finstrument-functions', '-finstrument-functions-exclude-file-list=include/,driver.c', '-w'],
  },
};

/** A precompiled <bits/stdc++.h> per flag set, so each compile takes ~0.5 s instead of ~3 s. */
const pchJobs = new Map();
async function pchDir(flags) {
  const dir = path.join(ROOT, 'pch', `cpp-${hash(CXX(), flags)}`);
  const gch = path.join(dir, 'bits', 'stdc++.h.gch');
  if (existsSync(gch)) return dir;
  if (!pchJobs.has(dir)) {
    pchJobs.set(dir, (async () => {
      await mkdir(path.join(dir, 'bits'), { recursive: true });
      const hdr = path.join(dir, 'pch-src.h');
      await writeFile(hdr, '#include <bits/stdc++.h>\n');
      const r = await run(CXX(), [...flags, '-x', 'c++-header', hdr, '-o', gch + '.tmp'], { timeout: 120000 });
      if (r.code === 0) await run('mv', [gch + '.tmp', gch]);
      return existsSync(gch) ? dir : null;
    })());
  }
  return pchJobs.get(dir);
}

async function compile(lang, code, sig, mode) {
  const flags = FLAGS[lang][mode];
  const source = lang === 'cpp' ? cppDriver(code, sig) : cDriver(code, sig);
  const compiler = lang === 'cpp' ? CXX() : CC();
  return cached(lang, [source, flags, compiler], async (dir) => {
    const src = path.join(dir, lang === 'cpp' ? 'driver.cpp' : 'driver.c');
    const exe = path.join(dir, 'prog');
    await writeFile(src, source);
    const extra = lang === 'cpp' ? await pchDir(flags).then((d) => (d ? ['-I', d, '-Winvalid-pch'] : [])) : [];
    const libs = lang === 'c' ? ['-lm', '-Wl,--wrap=malloc,--wrap=free,--wrap=calloc,--wrap=realloc'] : [];
    const r = await run(compiler, [...flags, ...extra, src, '-o', exe, ...libs], { cwd: dir, timeout: 90000 });
    if (r.code !== 0) throw compileError(r.stderr || r.stdout, lang === 'cpp' ? 'solution.cpp' : 'solution.c');
    return { dir, exe };
  });
}

function nativeAdapter(lang, name) {
  const userFile = lang === 'cpp' ? 'solution.cpp' : 'solution.c';
  return {
    id: lang,
    name,
    requires: lang === 'cpp' ? ['g++', 'gdb'] : ['gcc', 'gdb'],
    memVia: 'heap',

    async build(code, sig, mode) {
      const { exe, dir } = await compile(lang, code, sig, mode);
      return { cmd: exe, args: [], cwd: dir };
    },

    crashMessage(e) {
      const err = e.stderr || '';
      if (/__n < this->size\(\)|__n < size\(\)/.test(err)) return 'Index out of range: [] was called with an index ≥ size()';
      if (/!this->empty\(\)/.test(err)) return 'Called front()/back()/top()/pop on an empty container';
      return null;
    },

    async trace({ code, sig, args, maxSteps }) {
      let built;
      try {
        built = await compile(lang, code, sig, 'trace');
      } catch (e) {
        if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
        throw e;
      }
      const dir = await scratch(lang);
      try {
        const cfg = {
          lang, userFile, maxSteps, source: code,
          breakAt: lang === 'cpp' ? `Solution::${sig.method}` : sig.method,
          input: path.join(dir, 'in.txt'), stdout: path.join(dir, 'stdout.txt'), stderr: path.join(dir, 'stderr.txt'),
          out: path.join(dir, 'trace.json'),
        };
        await writeFile(cfg.input, encodeArgs(args, sig.params.map((p) => p.t)) + '\n');
        await writeFile(path.join(dir, 'cfg.json'), JSON.stringify(cfg));
        const r = await run('gdb', ['-nx', '-batch', '-q', '-x', GDB_TRACER, built.exe],
          { cwd: built.dir, env: { LV_CFG: path.join(dir, 'cfg.json') }, timeout: 120000 });
        let result;
        try {
          result = JSON.parse(await readFile(cfg.out, 'utf8'));
        } catch {
          throw new Error(r.timedOut ? 'Tracing took too long.' : `Debugger failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' · ')}`);
        }
        const stdout = await readFile(cfg.stdout, 'utf8').catch(() => '');
        return finishTrace(result, stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const cpp = nativeAdapter('cpp', 'C++');
export const c = nativeAdapter('c', 'C');
