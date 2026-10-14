// Swift: swiftc builds the user's solution.swift (untouched apart from `import Foundation;` on
// line 1) with a generated driver (main.swift); traced with the toolchain's lldb through its
// Python API (native/lldb_tracer.py), using Swift's own data formatters.
import { writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../lib/proc.js';
import { cached, compileError, scratch, CompileError } from '../lib/build.js';
import { encodeArgs } from '../lib/types.js';
import { finishTrace } from '../lib/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LLDB_TRACER = path.join(HERE, 'native', 'lldb_tracer.py');

const NODES = `// LeetCode's ListNode / TreeNode for Swift solutions.
public class ListNode {
    public var val: Int
    public var next: ListNode?
    public init() { self.val = 0; self.next = nil }
    public init(_ val: Int) { self.val = val; self.next = nil }
    public init(_ val: Int, _ next: ListNode?) { self.val = val; self.next = next }
}
public class TreeNode {
    public var val: Int
    public var left: TreeNode?
    public var right: TreeNode?
    public init() { self.val = 0; self.left = nil; self.right = nil }
    public init(_ val: Int) { self.val = val; self.left = nil; self.right = nil }
    public init(_ val: Int, _ left: TreeNode?, _ right: TreeNode?) { self.val = val; self.left = left; self.right = right }
}
`;

const RUNTIME = String.raw`import Foundation

final class LvIn {
    var toks: [Substring]
    var pos = 0
    init(_ s: String) { toks = s.split(separator: " ") }
    func tok() -> Substring { pos += 1; return pos - 1 < toks.count ? toks[pos - 1] : "0" }
}
func lvUnpct(_ t: Substring) -> String {
    var bytes: [UInt8] = []
    let u = Array(t.utf8)
    var i = 1
    while i < u.count {
        if u[i] == UInt8(ascii: "%"), i + 2 < u.count, let b = UInt8(String(decoding: u[(i + 1)...(i + 2)], as: UTF8.self), radix: 16) { bytes.append(b); i += 3 }
        else { bytes.append(u[i]); i += 1 }
    }
    return String(decoding: bytes, as: UTF8.self)
}
protocol LvRead { static func lvRead(_ r: LvIn) -> Self }
extension Int: LvRead { static func lvRead(_ r: LvIn) -> Int { Int(r.tok()) ?? 0 } }
extension Int64: LvRead { static func lvRead(_ r: LvIn) -> Int64 { Int64(r.tok()) ?? 0 } }
extension Double: LvRead { static func lvRead(_ r: LvIn) -> Double { Double(r.tok()) ?? 0 } }
extension Bool: LvRead { static func lvRead(_ r: LvIn) -> Bool { r.tok() == "1" } }
extension String: LvRead { static func lvRead(_ r: LvIn) -> String { lvUnpct(r.tok()) } }
extension Character: LvRead { static func lvRead(_ r: LvIn) -> Character { lvUnpct(r.tok()).first ?? " " } }
extension Array: LvRead where Element: LvRead {
    static func lvRead(_ r: LvIn) -> [Element] { let n = Int(r.tok()) ?? 0; return (0..<n).map { _ in Element.lvRead(r) } }
}
protocol LvNodeRead { static func lvReadNode(_ r: LvIn) -> Self? }
extension ListNode: LvNodeRead {
    static func lvReadNode(_ r: LvIn) -> Self? {
        let n = Int(r.tok()) ?? 0
        var vals: [Int] = []
        for _ in 0..<n { vals.append(Int(r.tok()) ?? 0) }
        var head: ListNode? = nil
        for v in vals.reversed() { head = ListNode(v, head) }
        return head as? Self
    }
}
extension TreeNode: LvNodeRead {
    static func lvReadNode(_ r: LvIn) -> Self? {
        let n = Int(r.tok()) ?? 0
        var t: [Substring] = []
        for _ in 0..<n { t.append(r.tok()) }
        if n == 0 || t[0] == "#" { return nil }
        let root = TreeNode(Int(t[0]) ?? 0)
        var q = [root]; var h = 0; var i = 1
        while h < q.count && i < n {
            let node = q[h]; h += 1
            if i < n && t[i] != "#" { node.left = TreeNode(Int(t[i]) ?? 0); q.append(node.left!) }
            i += 1
            if i < n && t[i] != "#" { node.right = TreeNode(Int(t[i]) ?? 0); q.append(node.right!) }
            i += 1
        }
        return root as? Self
    }
}
extension Optional: LvRead where Wrapped: LvNodeRead { static func lvRead(_ r: LvIn) -> Wrapped? { Wrapped.lvReadNode(r) } }

protocol LvWrite { func lvWrite(_ o: inout String) }
extension Int: LvWrite { func lvWrite(_ o: inout String) { o += String(self) } }
extension Int64: LvWrite { func lvWrite(_ o: inout String) { o += String(self) } }
extension Double: LvWrite { func lvWrite(_ o: inout String) { o += isFinite ? "\(self)" : "null" } }
extension Bool: LvWrite { func lvWrite(_ o: inout String) { o += self ? "true" : "false" } }
extension String: LvWrite {
    func lvWrite(_ o: inout String) {
        o += "\""
        for c in unicodeScalars {
            switch c {
            case "\"": o += "\\\""
            case "\\": o += "\\\\"
            default: if c.value < 0x20 { o += String(format: "\\u%04x", c.value) } else { o.unicodeScalars.append(c) }
            }
        }
        o += "\""
    }
}
extension Character: LvWrite { func lvWrite(_ o: inout String) { String(self).lvWrite(&o) } }
extension Array: LvWrite where Element: LvWrite {
    func lvWrite(_ o: inout String) { o += "["; for (i, x) in enumerated() { if i > 0 { o += "," }; x.lvWrite(&o) }; o += "]" }
}
extension Optional: LvWrite where Wrapped: LvWrite { func lvWrite(_ o: inout String) { if let x = self { x.lvWrite(&o) } else { o += "null" } } }
extension ListNode: LvWrite {
    func lvWrite(_ o: inout String) {
        o += "["; var cur: ListNode? = self; var k = 0
        while let n = cur, k < 100000 { if k > 0 { o += "," }; o += String(n.val); cur = n.next; k += 1 }
        o += "]"
    }
}
extension TreeNode: LvWrite {
    func lvWrite(_ o: inout String) {
        var q: [TreeNode?] = [self]; var parts: [String] = []; var i = 0
        while i < q.count && q.count < 400000 {
            if let n = q[i] { parts.append(String(n.val)); q.append(n.left); q.append(n.right) } else { parts.append("null") }
            i += 1
        }
        while parts.last == "null" { parts.removeLast() }
        o += "[" + parts.joined(separator: ",") + "]"
    }
}

func lvNow() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
`;

/** The user's `func name(...)`: [{label, type, inout}], and its return type. */
function userSignature(code, method) {
  const m = code.match(new RegExp(`func\\s+${method}\\s*(?:<[^>]*>)?\\s*\\(`));
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let cur = '';
  const parts = [];
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    if (c === ']' || (c === '>' && code[i - 1] !== '-')) depth--;
    if (c === ')') { if (depth === 0) break; depth--; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const params = parts.map((p) => {
    const [head, ...rest] = p.split(':');
    const names = head.trim().split(/\s+/);
    let type = rest.join(':').replace(/=.*$/, '').trim();
    const inout = /^inout\s/.test(type);
    type = type.replace(/^inout\s+/, '').replace(/^@escaping\s+/, '');
    const label = names.length > 1 ? names[0] : names[0];
    return { label: label === '_' ? null : label, type, inout };
  });
  const after = code.slice(i + 1).match(/^\s*(?:throws\s*)?->\s*([^{]+?)\s*\{/);
  return { params, ret: after ? after[1].trim() : 'Void' };
}

function driver(code, sig) {
  const us = userSignature(code, sig.method);
  if (!us) throw new CompileError(`Couldn't find \`func ${sig.method}(...)\` in your Swift code.`);
  if (us.params.length !== sig.params.length) throw new CompileError(`${sig.method} should take ${sig.params.length} parameter(s).`);
  const decls = us.params.map((p, i) => `${p.inout ? 'var' : 'let'} a${i}: ${p.type} = .lvRead(r)`).join('; ');
  const call = `sol.${sig.method}(${us.params.map((p, i) => `${p.label ? `${p.label}: ` : ''}${p.inout ? '&' : ''}a${i}`).join(', ')})`;
  const isVoid = sig.ret.k === 'void' || us.ret === 'Void' || us.ret === '()';
  return `${RUNTIME}
@inline(never) func lvRun(_ line: String, _ o: inout String) -> Double {
    let r = LvIn(line)
    ${decls}
    let sol = Solution()
    let t0 = lvNow()
    ${isVoid ? `${call}` : `let res = ${call}`}
    let dt = lvNow() - t0
    o = ""
    ${isVoid ? 'a0.lvWrite(&o)' : 'res.lvWrite(&o)'}
    return dt
}

func lvMain() {
    let args = CommandLine.arguments
    if args.count > 1 && args[1] == "trace" {
        setvbuf(stdout, nil, _IONBF, 0)
        let line = readLine() ?? ""
        var o = ""
        _ = lvRun(line, &o)
        print("\\n\\u{1}LV \\(o)")
        return
    }
    while let line = readLine() {
        let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
        let minTime = Double(parts[0]) ?? 0
        let maxRuns = Int(parts[1]) ?? 1
        let rest = parts.count > 3 ? String(parts[3]) : ""
        var total = 0.0, runs = 0, o = ""
        repeat { total += lvRun(rest, &o); runs += 1 } while runs < maxRuns && total < minTime
        print("\\u{1}LV {\\"t\\":\\(total / Double(runs)),\\"runs\\":\\(runs),\\"mem\\":-1,\\"depth\\":-1,\\"out\\":\\(o)}")
        fflush(stdout)
    }
}

// A big stack, so deep (but correct) recursion doesn't overflow.
let lvThread = Thread { lvMain(); exit(0) }
lvThread.stackSize = 1 << 29
lvThread.start()
while true { sleep(1000) }
`;
}

async function compile(code, sig, mode) {
  const source = driver(code, sig);
  return cached('swift', [code, source, NODES, mode], async (dir) => {
    await writeFile(path.join(dir, 'solution.swift'), `import Foundation; ${code}`);
    await writeFile(path.join(dir, 'nodes.swift'), NODES);
    await writeFile(path.join(dir, 'main.swift'), source);
    const flags = mode === 'trace' ? ['-Onone', '-g'] : ['-O'];
    const r = await run('swiftc', [...flags, '-module-name', 'sol', 'main.swift', 'nodes.swift', 'solution.swift', '-o', 'prog'], { cwd: dir, timeout: 300000 });
    if (r.code !== 0) throw compileError(r.stderr, 'solution.swift', { lineRe: /solution\.swift:(\d+)/ });
    return { dir, exe: path.join(dir, 'prog') };
  });
}

export const swift = {
  id: 'swift',
  name: 'Swift',
  requires: ['swiftc', 'lldb'],
  memVia: null,

  async build(code, sig) {
    const { exe, dir } = await compile(code, sig, 'serve');
    return { cmd: exe, args: [], cwd: dir };
  },

  crashMessage(e) {
    const m = (e.stderr || '').match(/Fatal error: ([^\n]*)/);
    return m ? `Fatal error: ${m[1]}` : null;
  },

  async trace({ code, sig, args, maxSteps }) {
    let built;
    try {
      built = await compile(code, sig, 'trace');
    } catch (e) {
      if (e instanceof CompileError) return { steps: [], error: e.message, errorLine: e.line };
      throw e;
    }
    const dir = await scratch('swift');
    try {
      const cfg = {
        exe: built.exe, method: sig.method, userFile: 'solution.swift', maxSteps,
        input: path.join(dir, 'in.txt'), stdout: path.join(dir, 'stdout.txt'), stderr: path.join(dir, 'stderr.txt'), out: path.join(dir, 'trace.json'),
      };
      await writeFile(cfg.input, encodeArgs(args, sig.params.map((p) => p.t)) + '\n');
      await writeFile(path.join(dir, 'cfg.json'), JSON.stringify(cfg));
      const py = (await run('lldb', ['-P'], { timeout: 30000 })).stdout.trim();
      // The lldb Python module links against the Swift runtime libraries of its toolchain.
      const usr = path.resolve(py, '..', '..', '..', '..');
      const libs = [path.join(usr, 'lib', 'swift', 'linux'), path.join(usr, 'lib', 'swift', 'host', 'compiler'), path.join(usr, 'lib', 'swift', 'host'), path.join(usr, 'lib')].join(':');
      const r = await run('python3', [LLDB_TRACER, path.join(dir, 'cfg.json')], {
        cwd: built.dir, timeout: 180000,
        env: { PYTHONPATH: py, LD_LIBRARY_PATH: `${libs}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}` },
      });
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
