// Rust: rustc builds lv_main.rs, which include!()s the user's solution.rs untouched (so debug
// line numbers are the user's) next to a generated driver module; traced with gdb and Rust's
// own gdb pretty printers (native/gdb_tracer.py, lang "rust").
import { writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, CompileError } from '../lib/build.js';
import { encodeArgs, snake } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GDB_TRACER = path.join(HERE, 'native', 'gdb_tracer.py');

const MAIN = `#![allow(unused, dead_code, non_snake_case, unused_imports, unused_mut)]
// Glob imports, so a solution's own \`use std::rc::Rc;\` (explicit, which wins) doesn't clash.
use std::collections::*;
use std::rc::*;
use std::cell::*;
use std::cmp::*;
mod lv_driver;
pub use lv_driver::{ListNode, TreeNode};
pub struct Solution;
include!("solution.rs");
fn main() { lv_driver::main(); }
`;

const DRIVER_RUNTIME = String.raw`use std::io::{self, BufRead, Write};
use std::rc::Rc;
use std::cell::RefCell;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::Instant;

#[derive(PartialEq, Eq, Clone, Debug)]
pub struct ListNode { pub val: i32, pub next: Option<Box<ListNode>> }
impl ListNode { #[inline] pub fn new(val: i32) -> Self { ListNode { next: None, val } } }
#[derive(Debug, PartialEq, Eq)]
pub struct TreeNode { pub val: i32, pub left: Option<Rc<RefCell<TreeNode>>>, pub right: Option<Rc<RefCell<TreeNode>>> }
impl TreeNode { #[inline] pub fn new(val: i32) -> Self { TreeNode { val, left: None, right: None } } }

// Heap accounting (peak extra bytes) for the Compare tab.
struct LvAlloc;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for LvAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() { let c = CUR.fetch_add(l.size(), Relaxed) + l.size(); PEAK.fetch_max(c, Relaxed); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { CUR.fetch_sub(l.size(), Relaxed); System.dealloc(p, l) }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = System.realloc(p, l, n);
        if !q.is_null() { CUR.fetch_sub(l.size(), Relaxed); let c = CUR.fetch_add(n, Relaxed) + n; PEAK.fetch_max(c, Relaxed); }
        q
    }
}
#[global_allocator]
static LV_ALLOC: LvAlloc = LvAlloc;

pub struct LvIn<'a> { toks: std::str::SplitWhitespace<'a> }
impl<'a> LvIn<'a> {
    fn new(s: &'a str) -> Self { LvIn { toks: s.split_whitespace() } }
    fn tok(&mut self) -> &'a str { self.toks.next().unwrap_or("0") }
}
fn lv_unpct(t: &str) -> String {
    let b = t.as_bytes(); let mut o = Vec::new(); let mut i = 1;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() { o.push(u8::from_str_radix(&t[i + 1..i + 3], 16).unwrap_or(b'?')); i += 3; }
        else { o.push(b[i]); i += 1; }
    }
    String::from_utf8_lossy(&o).into_owned()
}
pub trait LvRead: Sized { fn lv_read(r: &mut LvIn) -> Self; }
impl LvRead for i32 { fn lv_read(r: &mut LvIn) -> Self { r.tok().parse::<i64>().unwrap_or(0) as i32 } }
impl LvRead for i64 { fn lv_read(r: &mut LvIn) -> Self { r.tok().parse().unwrap_or(0) } }
impl LvRead for u32 { fn lv_read(r: &mut LvIn) -> Self { r.tok().parse().unwrap_or(0) } }
impl LvRead for usize { fn lv_read(r: &mut LvIn) -> Self { r.tok().parse().unwrap_or(0) } }
impl LvRead for f64 { fn lv_read(r: &mut LvIn) -> Self { r.tok().parse().unwrap_or(0.0) } }
impl LvRead for bool { fn lv_read(r: &mut LvIn) -> Self { r.tok() == "1" } }
impl LvRead for String { fn lv_read(r: &mut LvIn) -> Self { lv_unpct(r.tok()) } }
impl LvRead for char { fn lv_read(r: &mut LvIn) -> Self { lv_unpct(r.tok()).chars().next().unwrap_or('\0') } }
impl<T: LvRead> LvRead for Vec<T> {
    fn lv_read(r: &mut LvIn) -> Self { let n: usize = r.tok().parse().unwrap_or(0); (0..n).map(|_| T::lv_read(r)).collect() }
}
impl LvRead for Option<Box<ListNode>> {
    fn lv_read(r: &mut LvIn) -> Self {
        let vals: Vec<i32> = Vec::lv_read(r);
        let mut head = None;
        for v in vals.into_iter().rev() { head = Some(Box::new(ListNode { val: v, next: head })); }
        head
    }
}
impl LvRead for Option<Rc<RefCell<TreeNode>>> {
    fn lv_read(r: &mut LvIn) -> Self {
        let n: usize = r.tok().parse().unwrap_or(0);
        let t: Vec<&str> = (0..n).map(|_| r.tok()).collect();
        if n == 0 || t[0] == "#" { return None; }
        let root = Rc::new(RefCell::new(TreeNode::new(t[0].parse().unwrap_or(0))));
        let mut q = std::collections::VecDeque::new();
        q.push_back(root.clone());
        let mut i = 1;
        while let Some(node) = q.pop_front() {
            if i >= n { break; }
            if t[i] != "#" { let c = Rc::new(RefCell::new(TreeNode::new(t[i].parse().unwrap_or(0)))); node.borrow_mut().left = Some(c.clone()); q.push_back(c); }
            i += 1;
            if i < n && t[i] != "#" { let c = Rc::new(RefCell::new(TreeNode::new(t[i].parse().unwrap_or(0)))); node.borrow_mut().right = Some(c.clone()); q.push_back(c); }
            i += 1;
        }
        Some(root)
    }
}
pub trait LvWrite { fn lv_write(&self, o: &mut String); }
macro_rules! lv_num { ($($t:ty),*) => { $(impl LvWrite for $t { fn lv_write(&self, o: &mut String) { o.push_str(&self.to_string()) } })* } }
lv_num!(i8, i16, i32, i64, i128, u8, u16, u32, u64, usize, isize);
impl LvWrite for f64 { fn lv_write(&self, o: &mut String) { if self.is_finite() { o.push_str(&format!("{}", self)) } else { o.push_str("null") } } }
impl LvWrite for f32 { fn lv_write(&self, o: &mut String) { (*self as f64).lv_write(o) } }
impl LvWrite for bool { fn lv_write(&self, o: &mut String) { o.push_str(if *self { "true" } else { "false" }) } }
impl LvWrite for str {
    fn lv_write(&self, o: &mut String) {
        o.push('"');
        for c in self.chars() {
            match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) }
        }
        o.push('"');
    }
}
impl LvWrite for String { fn lv_write(&self, o: &mut String) { self.as_str().lv_write(o) } }
impl LvWrite for char { fn lv_write(&self, o: &mut String) { self.to_string().lv_write(o) } }
impl<T: LvWrite + ?Sized> LvWrite for &T { fn lv_write(&self, o: &mut String) { (**self).lv_write(o) } }
impl<T: LvWrite> LvWrite for Vec<T> { fn lv_write(&self, o: &mut String) { self.as_slice().lv_write(o) } }
impl<T: LvWrite> LvWrite for [T] {
    fn lv_write(&self, o: &mut String) { o.push('['); for (i, x) in self.iter().enumerate() { if i > 0 { o.push(',') } x.lv_write(o) } o.push(']') }
}
impl<T: LvWrite> LvWrite for Option<T> { fn lv_write(&self, o: &mut String) { match self { Some(x) => x.lv_write(o), None => o.push_str("null") } } }
impl LvWrite for ListNode {
    fn lv_write(&self, o: &mut String) {
        o.push('['); let mut cur = Some(self); let mut k = 0;
        while let Some(n) = cur { if k > 0 { o.push(',') } n.val.lv_write(o); cur = n.next.as_deref(); k += 1; if k > 100000 { break } }
        o.push(']')
    }
}
impl LvWrite for Box<ListNode> { fn lv_write(&self, o: &mut String) { (**self).lv_write(o) } }
impl LvWrite for Rc<RefCell<TreeNode>> {
    fn lv_write(&self, o: &mut String) {
        let mut q: Vec<Option<Rc<RefCell<TreeNode>>>> = vec![Some(self.clone())];
        let mut parts: Vec<String> = Vec::new(); let mut i = 0;
        while i < q.len() && q.len() < 400000 {
            match q[i].clone() {
                Some(n) => { let b = n.borrow(); parts.push(b.val.to_string()); q.push(b.left.clone()); q.push(b.right.clone()); }
                None => parts.push("null".into()),
            }
            i += 1;
        }
        while parts.last().map_or(false, |p| p == "null") { parts.pop(); }
        o.push('['); o.push_str(&parts.join(",")); o.push(']')
    }
}

static LV_PANIC: Mutex<String> = Mutex::new(String::new());
static LV_MEM: AtomicUsize = AtomicUsize::new(0);

fn lv_json(s: &str) -> String { let mut o = String::new(); s.lv_write(&mut o); o }

pub fn main() {
    // A big stack, so deep (but correct) recursion doesn't overflow.
    let h = std::thread::Builder::new().stack_size(1 << 30).spawn(lv_main).unwrap();
    let _ = h.join();
}

fn lv_main() {
    let args: Vec<String> = std::env::args().collect();
    let stdin = io::stdin();
    let mut out = io::stdout();
    if args.get(1).map(|s| s.as_str()) == Some("trace") {
        let mut line = String::new();
        stdin.lock().read_line(&mut line).unwrap();
        let mut o = String::new();
        lv_run(&line, &mut o);
        println!("\n\u{1}LV {}", o);
        return;
    }
    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() { s.to_string() }
                  else if let Some(s) = info.payload().downcast_ref::<String>() { s.clone() } else { "panic".to_string() };
        *LV_PANIC.lock().unwrap() = msg;
    }));
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let mut it = line.splitn(4, ' ');
        let min_time: f64 = it.next().unwrap_or("0").parse().unwrap_or(0.0);
        let max_runs: u32 = it.next().unwrap_or("1").parse().unwrap_or(1);
        it.next();
        let rest = it.next().unwrap_or("").to_string();
        let res = std::panic::catch_unwind(|| {
            let mut total = 0.0; let mut runs = 0; let mut o = String::new(); let mut mem = 0;
            while runs < max_runs && (runs == 0 || total < min_time) {
                total += lv_run(&rest, &mut o);
                if runs == 0 { mem = LV_MEM.load(Relaxed); }
                runs += 1;
            }
            format!("{{\"t\":{},\"runs\":{},\"mem\":{},\"depth\":-1,\"out\":{}}}", total / runs as f64, runs, mem, o)
        });
        let reply = match res { Ok(s) => s, Err(_) => format!("{{\"err\":{}}}", lv_json(&format!("panic: {}", LV_PANIC.lock().unwrap()))) };
        writeln!(out, "\u{1}LV {}", reply).unwrap();
        out.flush().unwrap();
    }
}
`;

const RUST_TYPE = { int: 'i32', long: 'i64', double: 'f64', bool: 'bool', string: 'String', char: 'char', ListNode: 'Option<Box<ListNode>>', TreeNode: 'Option<Rc<RefCell<TreeNode>>>' };
function rustType(t) {
  if (t.k === 'array' || t.k === 'list') return `Vec<${rustType(t.of)}>`;
  if (!RUST_TYPE[t.k]) throw new CompileError(`Rust: unsupported type ${t.k}`);
  return RUST_TYPE[t.k];
}

/** The user's parameter list for fn <name>(...), split at top-level commas: [{ref, type}]. */
function userParams(code, fn) {
  const m = code.match(new RegExp(`fn\\s+${fn}\\s*(?:<[^>]*>)?\\s*\\(`));
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let cur = '';
  const parts = [];
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '<' || c === '[') depth++;
    if (c === '>' && code[i - 1] !== '-') depth--;
    if (c === ']') depth--;
    if (c === ')') { if (depth === 0) break; depth--; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const ty = p.slice(p.indexOf(':') + 1).trim();
    const ref = ty.startsWith('&mut') ? '&mut ' : ty.startsWith('&') ? '&' : '';
    return { ref, type: ty.replace(/^&\s*(mut\s+)?/, '').replace(/^'\w+\s+/, '') };
  });
}

function driver(code, sig) {
  const fn = snake(sig.method);
  const ups = userParams(code, fn);
  if (!ups) throw new CompileError(`Couldn't find \`fn ${fn}(...)\` in your Rust code.`);
  const decls = sig.params.map((p, i) => {
    const ty = ups[i]?.type && !ups[i].type.startsWith('[') ? ups[i].type : rustType(p.t);
    return `let mut a${i}: ${ty} = LvRead::lv_read(&mut r);`;
  }).join(' ');
  const call = `crate::Solution::${fn}(${sig.params.map((_, i) => `${ups[i]?.ref || ''}a${i}`).join(', ')})`;
  const isVoid = sig.ret.k === 'void';
  return `${DRIVER_RUNTIME}
#[inline(never)]
fn lv_run(line: &str, o: &mut String) -> f64 {
    let mut r = LvIn::new(line);
    ${decls}
    let base = CUR.load(Relaxed); PEAK.store(base, Relaxed);
    let t0 = Instant::now();
    ${isVoid ? `${call};` : `let res = ${call};`}
    let dt = t0.elapsed().as_secs_f64();
    LV_MEM.store(PEAK.load(Relaxed).saturating_sub(base), Relaxed);
    o.clear();
    ${isVoid ? 'a0.lv_write(o);' : 'res.lv_write(o);'}
    dt
}
`;
}

async function compile(code, sig, mode) {
  const source = driver(code, sig);
  return cached('rust', [code, source, MAIN, mode], async (dir) => {
    await writeFile(path.join(dir, 'solution.rs'), code);
    await writeFile(path.join(dir, 'lv_main.rs'), MAIN);
    await writeFile(path.join(dir, 'lv_driver.rs'), source);
    const flags = mode === 'trace' ? ['-g', '-C', 'opt-level=0', '-C', 'debug-assertions=on'] : ['-C', 'opt-level=2', '-C', 'debug-assertions=off', '-C', 'overflow-checks=on'];
    const r = await run('rustc', ['--edition', '2021', ...flags, '--crate-name', 'lv_main', 'lv_main.rs', '-o', 'prog'], { cwd: dir, timeout: 240000 });
    if (r.code !== 0) throw compileError(r.stderr, 'solution.rs', { lineRe: /solution\.rs:(\d+)/ });
    return { dir, exe: path.join(dir, 'prog') };
  });
}

export const rust = {
  id: 'rust',
  name: 'Rust',
  requires: ['rustc', 'gdb'],
  memVia: 'heap',

  async build(code, sig) {
    const { exe, dir } = await compile(code, sig, 'serve');
    return { cmd: exe, args: [], cwd: dir };
  },

  crashMessage(e) {
    if (/overflowed its stack/.test(e.stderr || '')) return 'Stack overflow (recursion too deep — missing base case?)';
    return null;
  },

  async trace({ code, sig, args, maxSteps }) {
    let built;
    try {
      built = await compile(code, sig, 'trace');
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    const dir = await scratch('rust');
    try {
      const sysroot = (await run('rustc', ['--print', 'sysroot'], { timeout: 30000 })).stdout.trim();
      const cfg = {
        lang: 'rust', userFile: 'solution.rs', maxSteps, breakAt: `lv_main::Solution::${snake(sig.method)}`,
        rustPrinters: path.join(sysroot, 'lib', 'rustlib', 'etc'),
        input: path.join(dir, 'in.txt'), stdout: path.join(dir, 'stdout.txt'), stderr: path.join(dir, 'stderr.txt'), out: path.join(dir, 'trace.json'),
      };
      await writeFile(cfg.input, encodeArgs(args, sig.params.map((p) => p.t)) + '\n');
      await writeFile(path.join(dir, 'cfg.json'), JSON.stringify(cfg));
      const r = await run('gdb', ['-nx', '-batch', '-q', '-x', GDB_TRACER, built.exe], { cwd: built.dir, env: { LV_CFG: path.join(dir, 'cfg.json') }, timeout: 180000 });
      let result;
      try {
        result = JSON.parse(await readFile(cfg.out, 'utf8'));
      } catch {
        throw new Error(r.timedOut ? 'Tracing took too long.' : `Debugger failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' · ')}`);
      }
      return finishTrace(result, await readFile(cfg.stdout, 'utf8').catch(() => ''));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
