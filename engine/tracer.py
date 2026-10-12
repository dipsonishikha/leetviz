"""LeetViz engine: runs LeetCode-style Python solutions under a tracer.

Public entry points (called from worker.js, all take/return JSON strings):
  api_signature(req)  -> which method to call and its parameters
  api_trace(req)      -> step-by-step execution trace for the visualizer
  api_measure(req)    -> empirical time/space complexity of several approaches
  api_stress(req)     -> randomized differential testing of two approaches
"""
import sys, json, ast, copy, random, math, time, io, gc, tracemalloc, traceback, contextlib

FILENAME = "<solution>"

# Everything LeetCode's Python 3 environment pre-imports, plus the node classes
# that appear only as comments in the starter code.
PRELUDE = '''
from typing import *
import collections, heapq, bisect, itertools, functools, math, string, re, operator, random
from collections import defaultdict, deque, Counter, OrderedDict
from heapq import heappush, heappop, heapify, heappushpop, nlargest, nsmallest
from bisect import bisect_left, bisect_right, insort
from itertools import accumulate, permutations, combinations, product, chain, groupby, zip_longest
from functools import lru_cache, cache, reduce, cmp_to_key
from math import inf, gcd, sqrt, ceil, floor, log2, comb, isqrt

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
'''
_PRELUDE_NS = {"__name__": "__leetviz__"}
exec(PRELUDE, _PRELUDE_NS)
ListNode = _PRELUDE_NS["ListNode"]
TreeNode = _PRELUDE_NS["TreeNode"]

sys.setrecursionlimit(3000)


class StepLimit(BaseException):
    """Raised from inside the tracer; BaseException so user `except Exception` can't swallow it."""


class Emit:
    """Progress callback into JS (set by worker.js as `_emit`)."""
    @staticmethod
    def send(**data):
        fn = globals().get("_emit")
        if fn is not None:
            fn(json.dumps(data))


# ---------------------------------------------------------------- loading code

def load_solution(code, method_name=None):
    """Exec user code; return (bound_method, method_name, param_names, annotations)."""
    tree = ast.parse(code, FILENAME)
    cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Solution"), None)
    if cls is None:
        raise ValueError("Couldn't find `class Solution`. Design-style problems aren't supported yet.")
    methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
               and not n.name.startswith("__")]
    if not methods:
        raise ValueError("`class Solution` has no methods.")
    target = next((m for m in methods if m.name == method_name), None) or methods[0]
    params = [a.arg for a in target.args.args][1:]
    annotations = {a.arg: (ast.unparse(a.annotation) if a.annotation else "") for a in target.args.args[1:]}

    ns = dict(_PRELUDE_NS)
    ns["__name__"] = "__main__"
    exec(compile(tree, FILENAME, "exec"), ns)
    return getattr(ns["Solution"](), target.name), target.name, params, annotations


def build_list(vals):
    head = cur = ListNode()
    for v in vals or []:
        cur.next = ListNode(v)
        cur = cur.next
    return head.next


def build_tree(vals):
    if not vals or vals[0] is None:
        return None
    root = TreeNode(vals[0])
    queue, i = [root], 1
    for node in queue:
        if i >= len(vals):
            break
        if i < len(vals) and vals[i] is not None:
            node.left = TreeNode(vals[i]); queue.append(node.left)
        i += 1
        if i < len(vals) and vals[i] is not None:
            node.right = TreeNode(vals[i]); queue.append(node.right)
        i += 1
    return root


def convert_arg(value, type_hint):
    t = type_hint or ""
    if "ListNode" in t and isinstance(value, list):
        return build_list(value)
    if "TreeNode" in t and isinstance(value, list):
        return build_tree(value)
    return value


def to_plain(v, depth=0):
    """Convert results (incl. ListNode/TreeNode) back to LeetCode's JSON representation."""
    if depth > 50:
        return "..."
    if isinstance(v, ListNode):
        out, seen = [], set()
        while v is not None and id(v) not in seen and len(out) < 10000:
            seen.add(id(v)); out.append(to_plain(v.val, depth + 1)); v = v.next
        return out
    if isinstance(v, TreeNode):
        out, queue = [], [v]
        for node in queue:
            if node is None:
                out.append(None)
            else:
                out.append(to_plain(node.val, depth + 1)); queue.append(node.left); queue.append(node.right)
            if len(queue) > 20000:
                break
        while out and out[-1] is None:
            out.pop()
        return out
    if isinstance(v, (list, tuple)):
        return [to_plain(x, depth + 1) for x in v]
    if isinstance(v, (set, frozenset)):
        return sorted((to_plain(x, depth + 1) for x in v), key=repr)
    if isinstance(v, dict):
        return {str(k): to_plain(x, depth + 1) for k, x in v.items()}
    if isinstance(v, float) and (math.isinf(v) or math.isnan(v)):
        return str(v)
    if v is None or isinstance(v, (int, float, str, bool)):
        return v
    return repr(v)


def call_solution(method, params, types, args, void_return):
    real = [convert_arg(a, types.get(p, "")) for p, a in zip(params, args)]
    result = method(*real)
    if result is None and void_return and real:
        result = real[0]  # in-place problems (e.g. "Do not return anything, modify nums in-place")
    return result


def normalize(v, ignore_order):
    v = to_plain(v)
    if ignore_order and isinstance(v, list):
        v = sorted((sorted(x, key=repr) if isinstance(x, list) else x for x in v), key=repr)
    return json.dumps(v, sort_keys=True)


def _types_for(params, annotations, meta_types):
    return {p: (meta_types or {}).get(p) or annotations.get(p, "") for p in params}


# ---------------------------------------------------------------- serializing state

MAX_ITEMS = 120
MAX_DEPTH = 3


def ser(v, depth=0):
    if v is None or isinstance(v, bool):
        return {"t": "prim", "v": repr(v)}
    if isinstance(v, int):
        return {"t": "prim", "v": str(v), "num": v if abs(v) < 2**53 else None}
    if isinstance(v, float):
        return {"t": "prim", "v": repr(v)}
    if isinstance(v, str):
        return {"t": "str", "v": v[:300], "more": len(v) > 300}
    if depth >= MAX_DEPTH:
        return {"t": "prim", "v": _short_repr(v)}
    if isinstance(v, ListNode):
        nodes, seen, cur, cycle = [], {}, v, None
        while cur is not None and len(nodes) < 60:
            if id(cur) in seen:
                cycle = seen[id(cur)]
                break
            seen[id(cur)] = len(nodes)
            nodes.append({"id": id(cur), "val": _short_repr(cur.val)})
            cur = cur.next
        return {"t": "llist", "nodes": nodes, "cycle": cycle, "more": cur is not None and cycle is None}
    if isinstance(v, TreeNode):
        nodes, queue = {}, [v]
        for node in queue:
            if len(nodes) >= 63:
                break
            nodes[str(id(node))] = {"val": _short_repr(node.val),
                                    "l": str(id(node.left)) if node.left else None,
                                    "r": str(id(node.right)) if node.right else None}
            queue.extend(c for c in (node.left, node.right) if c is not None)
        return {"t": "tree", "root": str(id(v)), "nodes": nodes}
    if isinstance(v, (list, tuple)):
        kind = "tuple" if isinstance(v, tuple) else "list"
        return {"t": "list", "kind": kind, "id": id(v), "len": len(v),
                "items": [ser(x, depth + 1) for x in v[:MAX_ITEMS]]}
    if type(v).__name__ == "deque":
        return {"t": "list", "kind": "deque", "id": id(v), "len": len(v),
                "items": [ser(x, depth + 1) for x in list(v)[:MAX_ITEMS]]}
    if isinstance(v, (set, frozenset)):
        items = sorted(v, key=repr)[:MAX_ITEMS]
        return {"t": "set", "len": len(v), "items": [ser(x, depth + 1) for x in items]}
    if isinstance(v, dict):
        entries = list(v.items())[:MAX_ITEMS]
        return {"t": "dict", "kind": type(v).__name__, "len": len(v),
                "entries": [[_short_repr(k), ser(x, depth + 1)] for k, x in entries]}
    if callable(v):
        return {"t": "prim", "v": f"<function {getattr(v, '__name__', '?')}>"}
    fields = getattr(v, "__dict__", None)
    if isinstance(fields, dict):
        return {"t": "obj", "cls": type(v).__name__,
                "fields": {k: ser(x, depth + 1) for k, x in list(fields.items())[:30]}}
    return {"t": "prim", "v": _short_repr(v)}


def _short_repr(v):
    try:
        r = repr(v)
    except Exception:
        r = "<?>"
    return r if len(r) <= 80 else r[:77] + "..."


HIDDEN_LOCALS = {"self", "__class__"}


def _frame_locals(frame):
    return {k: ser(v) for k, v in frame.f_locals.items() if k not in HIDDEN_LOCALS and not k.startswith(".")}


# ---------------------------------------------------------------- explaining lines
# For the beginner narration: before a line runs, work out what its condition / expression
# means with real numbers ("s * potions[mid] >= success" -> "1 * 5 >= 7" -> False).
# Only side-effect-free expressions are evaluated (no calls except a few pure built-ins).

SAFE_CALLS = {"len", "abs", "min", "max", "sum", "int", "str", "ord", "chr", "bool", "float", "round"}
UNSAFE_NODES = (ast.Lambda, ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom,
                ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _is_safe(node):
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            if not (isinstance(n.func, ast.Name) and n.func.id in SAFE_CALLS):
                return False
        elif isinstance(n, UNSAFE_NODES):
            return False
    return True


def _eval(node, frame):
    expr = ast.fix_missing_locations(ast.Expression(body=copy.deepcopy(node)))
    return eval(compile(expr, "<explain>", "eval"), frame.f_globals, dict(frame.f_locals))


def _simple(v):
    return v is None or isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= 12)


class _Subst(ast.NodeTransformer):
    """Replace names / lookups that hold simple values with those values."""

    def __init__(self, frame):
        self.frame = frame

    def _value(self, node):
        if not _is_safe(node):
            return None
        try:
            v = _eval(node, self.frame)
        except Exception:
            return None
        return ast.Constant(v) if _simple(v) else None

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and node.id in self.frame.f_locals:
            return self._value(node) or node
        return node

    def visit_Subscript(self, node):
        return self._value(node) or self.generic_visit(node)

    def visit_Attribute(self, node):
        return self._value(node) or self.generic_visit(node)

    def visit_Call(self, node):
        return self._value(node) or self.generic_visit(node)


OP_SYMBOLS = {ast.Gt: ">", ast.GtE: ">=", ast.Lt: "<", ast.LtE: "<=", ast.Eq: "==", ast.NotEq: "!=",
              ast.In: "in", ast.NotIn: "not in", ast.Is: "is", ast.IsNot: "is not"}


def _short(v):
    r = repr(v)
    return r if len(r) <= 40 else r[:37] + "..."


class LineInfo:
    """Maps each line to the statement that starts there, and explains it in a given frame."""

    def __init__(self, code):
        self.by_line = {}
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return
        for node in ast.walk(tree):  # breadth-first, so a compound statement wins over its body
            if isinstance(node, ast.stmt) and node.lineno not in self.by_line:
                self.by_line[node.lineno] = node

    def explain(self, line, frame):
        node = self.by_line.get(line)
        if node is None:
            return None
        info = {"kind": type(node).__name__}
        exprs, targets = [], []
        if isinstance(node, (ast.If, ast.While)):
            exprs = [node.test]
            info["test"] = ast.unparse(node.test)
            if isinstance(node.test, ast.Compare) and len(node.test.ops) == 1 and _is_safe(node.test):
                try:
                    left = _eval(node.test.left, frame)
                    right = _eval(node.test.comparators[0], frame)
                    if _simple(left) and _simple(right):
                        info["sides"] = [_short(left), OP_SYMBOLS.get(type(node.test.ops[0]), "?"), _short(right)]
                except Exception:
                    pass
            if _is_safe(node.test):
                try:
                    info["value"] = bool(_eval(node.test, frame))
                except Exception:
                    pass
            info["body"] = [node.body[0].lineno, node.body[-1].end_lineno]
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            exprs = [node.iter]
            info["target"] = ast.unparse(node.target)
            info["iter"] = ast.unparse(node.iter)
            info["body"] = [node.body[0].lineno, node.body[-1].end_lineno]
        elif isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            exprs = [node.value] if node.value is not None else []
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            info["target"] = ", ".join(ast.unparse(t) for t in targets)
            info["expr"] = ast.unparse(node.value) if node.value is not None else ""
            if isinstance(node, ast.AugAssign):
                info["op"] = type(node.op).__name__
        elif isinstance(node, ast.Return):
            exprs = [node.value] if node.value is not None else []
            info["expr"] = ast.unparse(node.value) if node.value is not None else "None"
        elif isinstance(node, ast.Expr):
            exprs = [node.value]
            info["expr"] = ast.unparse(node.value)
            call = node.value
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute):
                info["method"] = call.func.attr
                info["obj"] = ast.unparse(call.func.value)
                info["args"] = [ast.unparse(_Subst(frame).visit(copy.deepcopy(a))) for a in call.args]
        else:
            return info

        if exprs:
            try:
                info["subst"] = ast.unparse(_Subst(frame).visit(copy.deepcopy(exprs[0])))
            except Exception:
                pass
        looks = []
        for root in exprs + targets:
            for n in ast.walk(root):
                if not isinstance(n, ast.Subscript) or isinstance(n.slice, ast.Slice) or not _is_safe(n.slice):
                    continue
                try:
                    key = _eval(n.slice, frame)
                except Exception:
                    continue
                if not _simple(key):
                    continue
                if isinstance(n.value, ast.Name):
                    looks.append([n.value.id, key])
                elif isinstance(n.value, ast.Subscript) and isinstance(n.value.value, ast.Name) and _is_safe(n.value.slice):
                    try:
                        row = _eval(n.value.slice, frame)
                        if isinstance(row, int):
                            looks.append([n.value.value.id, [row, key]])
                    except Exception:
                        pass
        if looks:
            info["looks"] = looks[:6]
        return info


# ---------------------------------------------------------------- step tracing

class Recorder:
    FULL_FRAMES = 6  # deeper frames are recorded without locals to keep traces small

    def __init__(self, max_steps, code=""):
        self.steps = []
        self.max_steps = max_steps
        self.out = io.StringIO()
        self.lines = LineInfo(code)

    def global_trace(self, frame, event, arg):
        if frame.f_code.co_filename != FILENAME:
            return None
        if event == "call":
            self.record(frame, "call", None)
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if event in ("line", "return", "exception"):
            self.record(frame, event, arg)
        return self.local_trace

    def record(self, frame, event, arg):
        if len(self.steps) >= self.max_steps:
            raise StepLimit()
        chain, f = [], frame
        while f is not None and f.f_code.co_filename == FILENAME:
            chain.append(f)
            f = f.f_back
        stack = []
        for depth, fr in enumerate(chain):
            entry = {"fn": fr.f_code.co_name, "line": fr.f_lineno}
            if depth < self.FULL_FRAMES:
                entry["locals"] = _frame_locals(fr)
            stack.append(entry)
        stack.reverse()  # outermost first
        step = {"line": frame.f_lineno, "event": event, "stack": stack, "out": len(self.out.getvalue())}
        if event == "line":
            try:
                info = self.lines.explain(frame.f_lineno, frame)
            except Exception:
                info = None
            if info:
                step["info"] = info
        elif event == "return":
            step["ret"] = ser(arg)
        elif event == "exception":
            step["exc"] = f"{arg[0].__name__}: {arg[1]}"
        self.steps.append(step)


def api_signature(req):
    req = json.loads(req)
    try:
        tree = ast.parse(req["code"], FILENAME)
    except SyntaxError as e:
        return json.dumps({"error": f"SyntaxError on line {e.lineno}: {e.msg}", "line": e.lineno})
    cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Solution"), None)
    if cls is None:
        return json.dumps({"error": "No `class Solution` found."})
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and not n.name.startswith("__")]
    if not methods:
        return json.dumps({"error": "`class Solution` has no methods."})
    m = next((x for x in methods if x.name == req.get("method")), methods[0])
    return json.dumps({"method": m.name, "params": [
        {"name": a.arg, "annotation": ast.unparse(a.annotation) if a.annotation else ""} for a in m.args.args[1:]]})


def api_trace(req):
    req = json.loads(req)
    rec = Recorder(req.get("maxSteps", 5000), req.get("code", ""))
    result = {"steps": rec.steps}
    try:
        method, name, params, ann = load_solution(req["code"], req.get("method"))
        types = _types_for(params, ann, req.get("types"))
        args = req["args"]
        if len(args) != len(params):
            raise ValueError(f"{name}() takes {len(params)} argument(s): {', '.join(params)}")
        real = [convert_arg(a, types[p]) for p, a in zip(params, args)]
    except SyntaxError as e:
        result["error"] = f"SyntaxError on line {e.lineno}: {e.msg}"
        result["errorLine"] = e.lineno
        return json.dumps(result)
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        return json.dumps(result)

    with contextlib.redirect_stdout(rec.out):
        sys.settrace(rec.global_trace)
        try:
            value = method(*real)
            if value is None and req.get("voidReturn") and real:
                value = real[0]
            result["returnValue"] = ser(value)
            result["returnPlain"] = json.dumps(to_plain(value))
        except StepLimit:
            result["truncated"] = True
        except RecursionError:
            result["error"] = "RecursionError: maximum recursion depth exceeded (missing base case?)"
        except Exception as e:
            tb = traceback.extract_tb(e.__traceback__)
            lines = [t.lineno for t in tb if t.filename == FILENAME]
            result["error"] = f"{type(e).__name__}: {e}"
            result["errorLine"] = lines[-1] if lines else None
        finally:
            sys.settrace(None)
    result["stdout"] = rec.out.getvalue()[:20000]
    return json.dumps(result)


# ---------------------------------------------------------------- measuring

class OpCounter:
    """Counts executed lines (a machine-independent proxy for time) and max recursion depth."""

    def __init__(self, budget):
        self.budget = budget
        self.count = 0
        self.hits = {}
        self.depth = 0
        self.max_depth = 0

    def global_trace(self, frame, event, arg):
        if frame.f_code.co_filename != FILENAME:
            return None
        self.depth += 1
        if self.depth > self.max_depth:
            self.max_depth = self.depth
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if event == "line":
            self.count += 1
            ln = frame.f_lineno
            self.hits[ln] = self.hits.get(ln, 0) + 1
            if self.count > self.budget:
                raise StepLimit()
        elif event == "return":
            self.depth -= 1
        return self.local_trace


def make_generator(gen_code):
    ns = dict(_PRELUDE_NS)
    ns["random"] = random
    exec(gen_code, ns)
    if "gen" not in ns:
        raise ValueError("Generator must define `def gen(n): return [arg1, arg2, ...]`")
    return ns["gen"]


def gen_args(gen, n, seed, stress=False):
    random.seed(seed)
    args = gen(n, True) if stress and gen.__code__.co_argcount >= 2 else gen(n)
    if not isinstance(args, (list, tuple)):
        raise ValueError("gen(n) must return a list of arguments, e.g. [nums, target]")
    return list(args)


SIZES = [2 ** k for k in range(2, 17)]  # 4 .. 65536
OPS_BUDGET = 2_000_000
TIME_LIMIT = 0.8      # seconds for a single untraced run
MIN_SAMPLE = 0.03     # repeat cheap runs until this much time is measured


def _run_counted(method, params, types, args, void_return, budget):
    counter = OpCounter(budget)
    sys.settrace(counter.global_trace)
    try:
        out = call_solution(method, params, types, args, void_return)
    finally:
        sys.settrace(None)
    return counter, out


def api_measure(req):
    req = json.loads(req)
    gen = make_generator(req["gen"])
    meta_types = req.get("types")
    void_return = req.get("voidReturn", False)
    ignore_order = req.get("ignoreOrder", False)
    results = []

    for idx, appr in enumerate(req["approaches"]):
        res = {"name": appr["name"], "ops": [], "time": [], "mem": [], "depth": [], "hits": {}, "notes": []}
        results.append(res)
        try:
            method, _, params, ann = load_solution(appr["code"], req.get("method"))
        except Exception as e:
            res["error"] = f"{type(e).__name__}: {e}"
            continue
        types = _types_for(params, ann, meta_types)
        outputs = {}

        # Pass 1: traced line counts (safe: aborts on budget, so exponential code can't hang).
        for n in SIZES:
            Emit.send(stage="ops", approach=idx, n=n)
            try:
                args = gen_args(gen, n, n * 7919)
                counter, out = _run_counted(method, params, types, args, void_return, OPS_BUDGET)
            except StepLimit:
                res["notes"].append(f"Line-count tracing stopped at n={n} (over {OPS_BUDGET:,} lines).")
                break
            except RecursionError:
                res["notes"].append(f"RecursionError at n={n}. (recursion depth > {sys.getrecursionlimit()})")
                break
            except Exception as e:
                res["error"] = f"{type(e).__name__} at n={n}: {e}"
                break
            res["ops"].append([n, counter.count])
            res["depth"].append([n, counter.max_depth])
            res["hits"] = {str(k): v for k, v in counter.hits.items()}
            res["hitsN"] = n
            outputs[n] = normalize(out, ignore_order)
        if res.get("error"):
            continue

        # Pass 2: untraced wall-clock time, going as far as is predicted to stay fast.
        ops_ratio = _last_ratio(res["ops"])
        prev = None
        for n in SIZES:
            if prev is not None:
                n0, t0, r = prev
                predicted = t0 * (r if r else 2) * (1.5 if n > (res["ops"][-1][0] if res["ops"] else 0) else 1)
                if predicted > TIME_LIMIT:
                    break
                if res["ops"] and n > res["ops"][-1][0] and ops_ratio and ops_ratio > 40:
                    break  # super-polynomial growth; don't risk an exponential blow-up
            Emit.send(stage="time", approach=idx, n=n)
            try:
                total, runs = 0.0, 0
                while True:
                    args = gen_args(gen, n, n * 7919)
                    t = time.perf_counter()
                    out = call_solution(method, params, types, args, void_return)
                    total += time.perf_counter() - t
                    runs += 1
                    if total >= MIN_SAMPLE or runs >= 200:
                        break
            except Exception as e:
                note = f"{type(e).__name__} at n={n}."
                if note not in " ".join(res["notes"]):
                    res["notes"].append(note)
                break
            if n not in outputs:
                outputs[n] = normalize(out, ignore_order)
            avg = total / runs
            res["time"].append([n, avg])
            r = avg / prev[1] if prev and prev[1] > 0 else None
            prev = (n, avg, r)

        # Pass 3: peak extra memory (tracemalloc, inputs allocated before measuring).
        for n, t in res["time"]:
            if t > 0.03:  # tracemalloc makes allocation-heavy code ~10x slower
                break
            Emit.send(stage="mem", approach=idx, n=n)
            try:
                args = gen_args(gen, n, n * 7919)
                gc.collect()
                tracemalloc.start()
                tracemalloc.reset_peak()
                base = tracemalloc.get_traced_memory()[0]
                out = call_solution(method, params, types, args, void_return)
                peak = tracemalloc.get_traced_memory()[1] - base
            except Exception:
                break
            finally:
                if tracemalloc.is_tracing():
                    tracemalloc.stop()
            res["mem"].append([n, max(peak, 0)])
        res["outputs"] = outputs

    _check_agreement(results)
    for res in results:
        res.pop("outputs", None)
        res["timeClass"] = fit(res["time"], min_y=0.002)
        res["timeSource"] = "time"
        if not res["timeClass"]:  # too fast to time reliably (or too slow to time at all)
            res["timeClass"] = fit(res["ops"], min_y=1)
            res["timeSource"] = "ops"
        res["opsClass"] = fit(res["ops"], min_y=1)
        res["spaceClass"] = space_class(res)
    return json.dumps(results)


def _last_ratio(points):
    if len(points) < 2 or points[-2][1] <= 0:
        return None
    return points[-1][1] / points[-2][1]


def _check_agreement(results):
    good = [r for r in results if not r.get("error") and r.get("outputs")]
    if len(good) < 2:
        return
    ref = good[0]
    for other in good[1:]:
        common = sorted(set(ref["outputs"]) & set(other["outputs"]))
        bad = [n for n in common if ref["outputs"][n] != other["outputs"][n]]
        if bad:
            other["notes"].append(f"⚠ Output differs from “{ref['name']}” at n={bad[0]}. Run the Stress tab to find a small failing case.")


# ---------------------------------------------------------------- complexity fitting

MODELS = [  # (label, rank, log f(n))
    ("O(1)", 0, lambda n: 0.0),
    ("O(log n)", 1, lambda n: math.log(math.log2(n) + 1)),
    ("O(√n)", 2, lambda n: 0.5 * math.log(n)),
    ("O(n)", 3, lambda n: math.log(n)),
    ("O(n log n)", 4, lambda n: math.log(n) + math.log(math.log2(n))),
    ("O(n²)", 5, lambda n: 2 * math.log(n)),
    ("O(n² log n)", 6, lambda n: 2 * math.log(n) + math.log(math.log2(n))),
    ("O(n³)", 7, lambda n: 3 * math.log(n)),
    ("O(2ⁿ)", 8, lambda n: n * math.log(2)),
    ("O(n!)", 9, lambda n: math.lgamma(n + 1)),
]


def fit(points, min_y=0.0):
    """Pick the growth model whose shape best matches the measurements.

    For each model f, if y ≈ c·f(n) then log y − log f(n) is constant; choose the model
    where that difference varies least, preferring simpler models on near-ties.
    """
    pts = [(n, y) for n, y in points if y > min_y and n >= 4]
    if len(pts) > 6:
        pts = pts[-6:]  # large n is where asymptotics show; small n is dominated by overhead
    if len(pts) < 3:
        return None
    # Exponential growth shows up as a log-log slope that keeps increasing (polynomials keep it flat).
    slopes = [math.log(y2 / y1) / math.log(n2 / n1) for (n1, y1), (n2, y2) in zip(pts, pts[1:])]
    if slopes[-1] > 3.5 and slopes[-1] > slopes[-2] + 1:
        (n1, y1), (n2, y2) = pts[-2], pts[-1]
        base = (y2 / y1) ** (1 / (n2 - n1))
        label = "O(2ⁿ)" if base >= 1.9 else f"O({base:.2f}ⁿ)"
        return {"label": label, "rank": 8, "base": base, "logc": math.log(y2) - n2 * math.log(base), "confidence": "medium"}
    scored = []
    for label, rank, logf in MODELS:
        try:
            diffs = [math.log(y) - logf(n) for n, y in pts]
        except (OverflowError, ValueError):
            continue
        mean = sum(diffs) / len(diffs)
        std = math.sqrt(sum((d - mean) ** 2 for d in diffs) / len(diffs))
        scored.append((std, rank, label, mean))
    best = min(s[0] for s in scored)
    std, rank, label, mean = min((s for s in scored if s[0] <= best + 0.04), key=lambda s: s[1])
    return {"label": label, "rank": rank, "logc": mean, "confidence": "high" if std < 0.1 else "medium" if std < 0.25 else "low"}


def space_class(res):
    mem = res["mem"]
    heap = None
    if mem:
        if max(b for _, b in mem) < 2048:
            heap = {"label": "O(1)", "rank": 0, "logc": 0.0, "confidence": "medium"}
        else:
            heap = fit(mem, min_y=1024) or fit(mem, min_y=0)
    stack = fit(res["depth"], min_y=2) if res["depth"] and max(d for _, d in res["depth"]) > 8 else None
    if stack and (heap is None or stack["rank"] > heap["rank"]):
        return dict(stack, via="recursion depth")
    return dict(heap, via="heap") if heap else None


def predict(cls, n):
    """Extrapolate a fitted model to size n (returns None on overflow)."""
    if not cls:
        return None
    if "base" in cls:
        logf = lambda n: n * math.log(cls["base"])
    else:
        logf = next(f for label, _, f in MODELS if label == cls["label"])
    try:
        return math.exp(cls["logc"] + logf(n))
    except OverflowError:
        return float("inf")


def api_predict(req):
    req = json.loads(req)
    return json.dumps([predict(c, req["n"]) for c in req["classes"]])


# ---------------------------------------------------------------- stress testing

def api_stress(req):
    req = json.loads(req)
    gen = make_generator(req["gen"])
    meta_types = req.get("types")
    void_return = req.get("voidReturn", False)
    ignore_order = req.get("ignoreOrder", False)
    loaded = []
    for appr in (req["a"], req["b"]):
        method, _, params, ann = load_solution(appr["code"], req.get("method"))
        loaded.append((method, params, _types_for(params, ann, meta_types)))

    def run(i, args):
        method, params, types = loaded[i]
        try:
            _, out = _run_counted(method, params, types, json.loads(json.dumps(args)), void_return, 300_000)
            return {"ok": True, "value": normalize(out, ignore_order)}
        except StepLimit:
            return {"ok": False, "value": "Exceeded 300,000 lines — infinite loop?"}
        except RecursionError:
            return {"ok": False, "value": "RecursionError (missing base case?)"}
        except Exception as e:
            return {"ok": False, "value": f"{type(e).__name__}: {e}"}

    trials, max_n = req.get("trials", 200), max(1, req.get("maxN", 8))
    for t in range(trials):
        n = 1 + t * max_n // trials  # sweep sizes small → large so failures are minimal
        if t % 20 == 0:
            Emit.send(stage="stress", trial=t, trials=trials)
        try:
            args = gen_args(gen, n, 100003 * t + 17, stress=True)
            args = json.loads(json.dumps(to_plain(args)))
        except Exception as e:
            return json.dumps({"error": f"Generator failed at n={n}: {type(e).__name__}: {e}"})
        ra, rb = run(0, args), run(1, args)
        if ra != rb:
            return json.dumps({"passed": t, "trials": trials, "mismatch": {"n": n, "args": args, "a": ra, "b": rb}})
    return json.dumps({"passed": trials, "trials": trials})
