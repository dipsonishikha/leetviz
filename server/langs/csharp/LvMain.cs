// LeetViz driver for C# solutions (see server/lib/runner.js for the protocol).
//
//   dotnet prog.dll trace|serve <method> <param types...> -> <void|value>
//
// Inputs are converted to the solution method's own parameter types with reflection, so this
// file is the same for every problem.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

public class ListNode {
    public int val;
    public ListNode next;
    public ListNode(int val = 0, ListNode next = null) { this.val = val; this.next = next; }
}

public class TreeNode {
    public int val;
    public TreeNode left;
    public TreeNode right;
    public TreeNode(int val = 0, TreeNode left = null, TreeNode right = null) { this.val = val; this.left = left; this.right = right; }
}

public static class LvSer {
    const int MaxItems = 120, MaxDepth = 3;
    static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, object> Ids = new();
    static long nextId = 1;

    static long Id(object o) {
        if (!Ids.TryGetValue(o, out var id)) { id = nextId++; Ids.Add(o, id); }
        return (long)id;
    }

    public static string Str(string s) {
        var b = new StringBuilder("\"");
        foreach (var c in s) {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.Append($"\\u{(int)c:x4}");
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static string Short(object v) {
        string s = v switch { null => "null", string x => Str(x), bool x => x ? "true" : "false", ListNode n => Short(n.val), TreeNode n => Short(n.val), IFormattable f => f.ToString(null, CultureInfo.InvariantCulture), _ => v.GetType().Name };
        return s.Length <= 80 ? s : s.Substring(0, 77) + "...";
    }

    static string Prim(string v, string k = null) => "{\"t\":\"prim\",\"v\":" + Str(v) + (k != null ? ",\"k\":\"" + k + "\"" : "") + "}";

    static string Items(IEnumerable items, int depth) => string.Join(",", items.Cast<object>().Take(MaxItems).Select(x => Ser(x, depth + 1)));

    /// <summary>One value in the panel's format (called by the tracer through the debugger).</summary>
    public static string Ser(object v, int depth = 0) {
        try {
            switch (v) {
                case null: return Prim("null", "null");
                case bool b: return Prim(b ? "true" : "false", "bool");
                case char c: return "{\"t\":\"str\",\"v\":" + Str(c.ToString()) + "}";
                case string s: return "{\"t\":\"str\",\"v\":" + Str(s.Length > 300 ? s.Substring(0, 300) : s) + ",\"more\":" + (s.Length > 300 ? "true" : "false") + "}";
                case int or long or short or byte or sbyte or uint or ulong or ushort: {
                    var n = Convert.ToDecimal(v);
                    return "{\"t\":\"prim\",\"v\":\"" + n + "\",\"k\":\"num\"" + (Math.Abs(n) < 9007199254740992m ? ",\"num\":" + n : "") + "}";
                }
                case double or float or decimal: return Prim(((IFormattable)v).ToString(null, CultureInfo.InvariantCulture), "num");
                case ListNode head: {
                    var nodes = new List<string>(); var seen = new Dictionary<ListNode, int>(ReferenceEqualityComparer.Instance); int? cycle = null; var cur = head;
                    while (cur != null && nodes.Count < 60) {
                        if (seen.TryGetValue(cur, out var at)) { cycle = at; break; }
                        seen[cur] = nodes.Count;
                        nodes.Add("{\"id\":" + Id(cur) + ",\"val\":" + Str(Short(cur.val)) + "}");
                        cur = cur.next;
                    }
                    return "{\"t\":\"llist\",\"nodes\":[" + string.Join(",", nodes) + "],\"cycle\":" + (cycle?.ToString() ?? "null") + ",\"more\":" + (cur != null && cycle == null ? "true" : "false") + "}";
                }
                case TreeNode root: {
                    var parts = new List<string>(); var q = new List<TreeNode> { root }; var seen = new HashSet<TreeNode>(ReferenceEqualityComparer.Instance);
                    for (int i = 0; i < q.Count && parts.Count < 63; i++) {
                        var n = q[i];
                        if (!seen.Add(n)) continue;
                        parts.Add("\"" + Id(n) + "\":{\"val\":" + Str(Short(n.val)) + ",\"l\":" + (n.left != null ? "\"" + Id(n.left) + "\"" : "null") + ",\"r\":" + (n.right != null ? "\"" + Id(n.right) + "\"" : "null") + "}");
                        if (n.left != null) q.Add(n.left);
                        if (n.right != null) q.Add(n.right);
                    }
                    return "{\"t\":\"tree\",\"root\":\"" + Id(root) + "\",\"nodes\":{" + string.Join(",", parts) + "}}";
                }
            }
            var t = v.GetType();
            if (depth >= MaxDepth) return Prim(Short(v));
            if (v is IDictionary dict) {
                var entries = new List<string>();
                foreach (DictionaryEntry e in dict) { if (entries.Count >= MaxItems) break; entries.Add("[" + Str(e.Key is string ks ? ks : Short(e.Key)) + "," + Ser(e.Value, depth + 1) + "]"); }
                return "{\"t\":\"dict\",\"kind\":" + Str(t.Name.Split('`')[0]) + ",\"len\":" + dict.Count + ",\"entries\":[" + string.Join(",", entries) + "]}";
            }
            string gen = t.IsGenericType ? t.GetGenericTypeDefinition().Name.Split('`')[0] : t.Name;
            if (gen is "HashSet" or "SortedSet") {
                var items = ((IEnumerable)v).Cast<object>().ToList();
                return "{\"t\":\"set\",\"len\":" + items.Count + ",\"items\":[" + Items(items, depth) + "]}";
            }
            if (gen == "PriorityQueue") {
                var itemsProp = t.GetProperty("UnorderedItems");
                var items = ((IEnumerable)itemsProp.GetValue(v)).Cast<object>().Select(x => x.GetType().GetField("Item1").GetValue(x)).ToList();
                return "{\"t\":\"list\",\"kind\":\"heap\",\"id\":" + Id(v) + ",\"len\":" + items.Count + ",\"items\":[" + Items(items, depth) + "]}";
            }
            if (v is IEnumerable seq) {
                var items = seq.Cast<object>().Take(MaxItems + 1).ToList();
                int len = v is ICollection col ? col.Count : items.Count;
                string kind = t.IsArray ? "array" : gen == "Stack" ? "stack" : gen is "Queue" or "LinkedList" ? "deque" : gen;
                return "{\"t\":\"list\",\"kind\":" + Str(kind) + ",\"id\":" + Id(v) + ",\"len\":" + len + ",\"items\":[" + Items(items, depth) + "]}";
            }
            if (t.IsGenericType && t.FullName.StartsWith("System.ValueTuple")) {
                var fs = t.GetFields().Select(f => f.GetValue(v)).ToList();
                return "{\"t\":\"list\",\"kind\":\"tuple\",\"id\":0,\"len\":" + fs.Count + ",\"items\":[" + Items(fs, depth) + "]}";
            }
            if (v is Delegate) return Prim("<function>");
            var fields = t.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).Where(f => !f.Name.Contains('<')).Take(30)
                .Select(f => Str(f.Name) + ":" + Ser(f.GetValue(v), depth + 1));
            return "{\"t\":\"obj\",\"cls\":" + Str(t.Name) + ",\"fields\":{" + string.Join(",", fields) + "}}";
        } catch {
            return Prim("?");
        }
    }
}

/// <summary>Trace recorder called by the probes LvInstrument.cs puts into the solution.</summary>
public static class LvT {
    public sealed class StepLimit : Exception { public StepLimit() : base("step limit") { } }

    public sealed class CountingWriter : TextWriter {
        readonly TextWriter inner;
        public long Count;
        public CountingWriter(TextWriter inner) { this.inner = inner; }
        public override Encoding Encoding => Encoding.UTF8;
        public override void Write(char value) { Count += Encoding.UTF8.GetByteCount(value.ToString()); inner.Write(value); }
        public override void Write(string value) { if (value == null) return; Count += Encoding.UTF8.GetByteCount(value); inner.Write(value); }
        public override void Flush() => inner.Flush();
    }

    sealed class Frame { public string Fn; public int Line; public object[] Vars; }

    const int FullFrames = 6;
    public static int MaxSteps = 5000;
    public static bool Truncated;
    public static CountingWriter Output;
    static readonly List<Frame> stack = new();
    static readonly List<string> steps = new();
    static string lastStack = "[]";
    static int lastLine;

    static string Locals(object[] kv) {
        var b = new StringBuilder("{");
        for (int i = 0; i + 1 < kv.Length; i += 2) {
            if (i > 0) b.Append(',');
            b.Append(LvSer.Str((string)kv[i])).Append(':').Append(LvSer.Ser(kv[i + 1]));
        }
        return b.Append('}').ToString();
    }

    static string Stack() {
        var parts = new List<string>();
        for (int i = 0; i < stack.Count; i++) {
            var f = stack[i];
            var e = "{\"fn\":" + LvSer.Str(f.Fn) + ",\"line\":" + f.Line;
            if (stack.Count - i <= FullFrames && f.Vars != null) e += ",\"locals\":" + Locals(f.Vars);
            parts.Add(e + "}");
        }
        return "[" + string.Join(",", parts) + "]";
    }

    static void Record(string ev, int line, string extra = "") {
        if (steps.Count >= MaxSteps) throw new StepLimit();
        lastStack = Stack();
        lastLine = line;
        var step = "{\"line\":" + line + ",\"event\":\"" + ev + "\",\"stack\":" + lastStack + ",\"out\":" + (Output?.Count ?? 0) + extra + "}";
        // A for/while probe right after the statement probe on the same line says nothing new.
        if (ev == "line" && steps.Count > 0 && steps[^1] == step) return;
        steps.Add(step);
    }

    public static void Enter(string fn, int line, params object[] kv) {
        stack.Add(new Frame { Fn = fn, Line = line, Vars = kv });
        Record("call", line);
    }

    public static void Exit() {
        if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
    }

    public static void L(int line, params object[] kv) {
        if (stack.Count == 0) return;
        var f = stack[^1];
        f.Line = line;
        f.Vars = kv;
        Record("line", line);
    }

    public static bool B(int line, params object[] kv) {
        L(line, kv);
        return true;
    }

    public static T R<T>(int line, T value) {
        if (stack.Count > 0) { stack[^1].Line = line; Record("return", line, ",\"ret\":" + LvSer.Ser(value)); }
        return value;
    }

    public static void RV(int line) {
        if (stack.Count > 0) { stack[^1].Line = line; Record("return", line, ",\"ret\":{\"t\":\"prim\",\"v\":\"void\",\"k\":\"null\"}"); }
    }

    static int? errorLine;

    /// <summary>An exception escaped the solution: record it at the line that threw.</summary>
    public static void Failed(string message, Exception e) {
        var m = System.Text.RegularExpressions.Regex.Match(e.StackTrace ?? "", @"Solution\.cs:line (\d+)");
        errorLine = m.Success ? int.Parse(m.Groups[1].Value) : lastLine;
        if (steps.Count > 0) steps.Add("{\"line\":" + errorLine + ",\"event\":\"exception\",\"stack\":" + lastStack + ",\"out\":" + (Output?.Count ?? 0) + ",\"exc\":" + LvSer.Str(message) + "}");
    }

    public static string Json(string result, string error) {
        var b = new StringBuilder("{\"steps\":[").Append(string.Join(",", steps)).Append(']');
        if (Truncated) b.Append(",\"truncated\":true");
        if (error != null) b.Append(",\"error\":").Append(LvSer.Str(error)).Append(",\"errorLine\":").Append(errorLine?.ToString() ?? "null");
        if (result != null && error == null && !Truncated) b.Append(",\"returnPlain\":").Append(LvSer.Str(result));
        return b.Append('}').ToString();
    }
}

public static class LvMain {
    record LType(string K, LType Of);

    static LType Parse(string s) {
        if (s.EndsWith("[]")) return new LType("seq", Parse(s[..^2]));
        if (s.StartsWith("list<") && s.EndsWith(">")) return new LType("seq", Parse(s[5..^1]));
        return new LType(s, null);
    }

    static string[] toks; static int pos;
    static string Tok() => toks[pos++];

    static string Unpct(string t) {
        var bytes = new List<byte>();
        for (int i = 1; i < t.Length; i++) {
            if (t[i] == '%' && i + 2 < t.Length) { bytes.Add(Convert.ToByte(t.Substring(i + 1, 2), 16)); i += 2; }
            else bytes.Add((byte)t[i]);
        }
        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    static Type ElemType(Type t) {
        if (t.IsArray) return t.GetElementType();
        if (t.IsGenericType) return t.GetGenericArguments()[0];
        return typeof(object);
    }

    static object Read(LType lt, Type t) {
        switch (lt.K) {
            case "integer": case "long": {
                long n = long.Parse(Tok(), CultureInfo.InvariantCulture);
                return t == typeof(long) ? n : t == typeof(double) ? (double)n : (object)(int)n;
            }
            case "double": return double.Parse(Tok(), CultureInfo.InvariantCulture);
            case "boolean": return Tok() == "1";
            case "string": return Unpct(Tok());
            case "character": { var s = Unpct(Tok()); return t == typeof(string) ? s : (object)s[0]; }
            case "ListNode": {
                int n = int.Parse(Tok()); var vals = new int[n];
                for (int i = 0; i < n; i++) vals[i] = int.Parse(Tok());
                ListNode head = null;
                for (int i = n - 1; i >= 0; i--) head = new ListNode(vals[i], head);
                return head;
            }
            case "TreeNode": {
                int n = int.Parse(Tok()); var t2 = new string[n];
                for (int i = 0; i < n; i++) t2[i] = Tok();
                if (n == 0 || t2[0] == "#") return null;
                var root = new TreeNode(int.Parse(t2[0])); var q = new Queue<TreeNode>(); q.Enqueue(root); int k = 1;
                while (q.Count > 0 && k < n) {
                    var node = q.Dequeue();
                    if (k < n && t2[k] != "#") { node.left = new TreeNode(int.Parse(t2[k])); q.Enqueue(node.left); } k++;
                    if (k < n && t2[k] != "#") { node.right = new TreeNode(int.Parse(t2[k])); q.Enqueue(node.right); } k++;
                }
                return root;
            }
            case "seq": {
                int n = int.Parse(Tok()); var et = ElemType(t);
                if (t.IsArray) { var a = Array.CreateInstance(et, n); for (int i = 0; i < n; i++) a.SetValue(Read(lt.Of, et), i); return a; }
                var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(et));
                for (int i = 0; i < n; i++) list.Add(Read(lt.Of, et));
                return list;
            }
        }
        throw new ArgumentException("unsupported type " + lt.K);
    }

    static void Write(StringBuilder o, object v) {
        switch (v) {
            case null: o.Append("null"); return;
            case bool b: o.Append(b ? "true" : "false"); return;
            case string s: o.Append(LvSer.Str(s)); return;
            case char c: o.Append(LvSer.Str(c.ToString())); return;
            case double d: o.Append(double.IsFinite(d) ? d.ToString("R", CultureInfo.InvariantCulture) : "null"); return;
            case float f: Write(o, (double)f); return;
            case IFormattable n when v.GetType().IsPrimitive || v is decimal: o.Append(n.ToString(null, CultureInfo.InvariantCulture)); return;
            case ListNode h: {
                o.Append('['); int k = 0;
                for (var c = h; c != null && k < 100000; c = c.next, k++) { if (k > 0) o.Append(','); o.Append(c.val); }
                o.Append(']'); return;
            }
            case TreeNode r: {
                var q = new List<TreeNode> { r }; var parts = new List<string>();
                for (int i = 0; i < q.Count && q.Count < 400000; i++) {
                    if (q[i] == null) parts.Add("null"); else { parts.Add(q[i].val.ToString()); q.Add(q[i].left); q.Add(q[i].right); }
                }
                while (parts.Count > 0 && parts[^1] == "null") parts.RemoveAt(parts.Count - 1);
                o.Append('[').Append(string.Join(",", parts)).Append(']'); return;
            }
            case IDictionary d: {
                o.Append('{'); bool first = true;
                foreach (DictionaryEntry e in d) { if (!first) o.Append(','); first = false; o.Append(LvSer.Str(e.Key.ToString())).Append(':'); Write(o, e.Value); }
                o.Append('}'); return;
            }
            case IEnumerable seq: {
                o.Append('['); bool first = true;
                foreach (var x in seq) { if (!first) o.Append(','); first = false; Write(o, x); }
                o.Append(']'); return;
            }
        }
        o.Append(LvSer.Str(v.ToString()));
    }

    static MethodInfo method;
    static LType[] ptypes;
    static bool isVoid;

    static object[] Args(string line, int from) {
        toks = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        pos = from;
        var ps = method.GetParameters();
        var args = new object[ptypes.Length];
        for (int i = 0; i < args.Length; i++) {
            var pt = ps[i].ParameterType;
            args[i] = Read(ptypes[i], pt.IsByRef ? pt.GetElementType() : pt);
        }
        return args;
    }

    static string ErrorText(Exception e) {
        if (e is TargetInvocationException tie && tie.InnerException != null) e = tie.InnerException;
        return e.GetType().Name + ": " + e.Message;
    }

    /// <summary>The traced run: the tracer's first breakpoint is in the solution method.</summary>
    static object LvTraceRun(object[] args) => method.Invoke(new Solution(), args);

    public static void Main(string[] argv) {
        var t = new System.Threading.Thread(() => Run(argv), 1 << 30);
        t.Start();
        t.Join();
    }

    static void Run(string[] argv) {
        var proto = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
        var types = argv.Skip(2).ToList();
        int arrow = types.IndexOf("->");
        ptypes = types.Take(arrow).Select(Parse).ToArray();
        isVoid = types[arrow + 1] == "void";
        method = typeof(Solution).GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .FirstOrDefault(m => string.Equals(m.Name, argv[1], StringComparison.OrdinalIgnoreCase) && m.GetParameters().Length == ptypes.Length);
        if (method == null) { proto.WriteLine("\u0001LV {\"err\":" + LvSer.Str("Couldn't find " + argv[1] + " in class Solution") + "}"); return; }
        if (argv[0] == "trace") {
            // Instrumented build (LvInstrument.cs): the probes record the trace through LvT.
            var line = File.ReadAllText(Environment.GetEnvironmentVariable("LV_INPUT")).Trim();
            var counter = new LvT.CountingWriter(new StreamWriter(Environment.GetEnvironmentVariable("LV_STDOUT")) { AutoFlush = true });
            Console.SetOut(counter);
            LvT.Output = counter;
            LvT.MaxSteps = int.Parse(Environment.GetEnvironmentVariable("LV_MAX_STEPS") ?? "5000");
            var args = Args(line, 0);
            string result = null, error = null;
            try {
                var r = LvTraceRun(args);
                var o = new StringBuilder();
                Write(o, isVoid ? args[0] : r);
                result = o.ToString();
            } catch (Exception e) {
                var inner = e is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : e;
                if (inner is LvT.StepLimit) LvT.Truncated = true;
                else error = ErrorText(inner);
                if (error != null) LvT.Failed(error, inner);
            }
            counter.Flush();
            File.WriteAllText(Environment.GetEnvironmentVariable("LV_RESULT"), LvT.Json(result, error));
            return;
        }
        Console.SetOut(TextWriter.Null); // the solution's prints must not corrupt the protocol
        string req;
        while ((req = Console.In.ReadLine()) != null) {
            var head = req.Split(' ', 4);
            double minTime = double.Parse(head[0], CultureInfo.InvariantCulture);
            int maxRuns = int.Parse(head[1]);
            string reply;
            try {
                double total = 0; int runs = 0; long alloc = -1; object res = null; var sw = new System.Diagnostics.Stopwatch();
                bool warmed = false;
                while (runs < maxRuns && (runs == 0 || total < minTime)) {
                    var args = Args(req, 3);
                    long a0 = GC.GetAllocatedBytesForCurrentThread();
                    sw.Restart();
                    var r = method.Invoke(method.IsStatic ? null : new Solution(), args);
                    sw.Stop();
                    if (alloc < 0) alloc = GC.GetAllocatedBytesForCurrentThread() - a0;
                    total += sw.Elapsed.TotalSeconds; runs++;
                    res = isVoid ? args[0] : r;
                    if (!warmed && maxRuns > 1 && total < 0.05) {
                        // Let the JIT tier up before timing.
                        warmed = true;
                        var w = System.Diagnostics.Stopwatch.StartNew();
                        while (w.Elapsed.TotalSeconds < 0.15) method.Invoke(method.IsStatic ? null : new Solution(), Args(req, 3));
                        total = 0; runs = 0;
                    }
                }
                var o = new StringBuilder();
                Write(o, res);
                reply = "{\"t\":" + (total / runs).ToString("R", CultureInfo.InvariantCulture) + ",\"runs\":" + runs + ",\"mem\":" + alloc + ",\"depth\":-1,\"out\":" + o + "}";
            } catch (Exception e) {
                reply = "{\"err\":" + LvSer.Str(ErrorText(e)) + "}";
            }
            proto.WriteLine("\u0001LV " + reply);
        }
    }
}
