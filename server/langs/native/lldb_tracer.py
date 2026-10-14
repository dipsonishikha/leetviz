"""lldb-driven step tracer for Swift (run with the toolchain's lldb Python module on PYTHONPATH).

  python3 lldb_tracer.py <cfg.json>
  cfg: {exe, method, userFile, maxSteps, input, stdout, stderr, out}

Steps through every line of the user's file and writes the trace JSON of engine/tracer.py.
Swift values are read through lldb's Swift data formatters (Array, Dictionary, Set, Optional...).
"""
import json, os, re, sys
import lldb

CFG = json.load(open(sys.argv[1]))
USER = CFG["userFile"]
MAX_STEPS = CFG.get("maxSteps", 5000)
MAX_ITEMS = 120
MAX_DEPTH = 3
FULL_FRAMES = 6

dbg = lldb.SBDebugger.Create()
dbg.SetAsync(False)
for cmd in ("settings set target.process.thread.step-in-avoid-nodebug true",
            "settings set target.process.thread.step-avoid-regexp '^(Swift|Foundation|__swift|swift_|_swift)'",
            "settings set symbols.enable-external-lookup false"):
    dbg.HandleCommand(cmd)

steps = []
result = {"steps": steps}


def short(s, n=80):
    s = str(s)
    return s if len(s) <= n else s[: n - 3] + "..."


def tname(v):
    return v.GetTypeName() or ""


def strip_quotes(s):
    if s and len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        try:
            return json.loads(s)
        except ValueError:
            return s[1:-1]
    return s or ""


def is_nil(v):
    s = v.GetSummary() or v.GetValue() or ""
    return s == "nil" or (v.GetNumChildren() == 0 and tname(v).startswith("Swift.Optional<") and not s)


def unwrap(v):
    """Optional<T> -> T (None for nil)."""
    for _ in range(4):
        n = tname(v)
        if n.startswith("Swift.Optional<") or n.endswith("?"):
            if is_nil(v):
                return None
            if v.GetNumChildren() >= 1 and v.GetChildAtIndex(0).GetName() in ("some", None, "[0]"):
                v = v.GetChildAtIndex(0)
                continue
            nv = v.GetNonSyntheticValue()
            if nv.GetNumChildren() >= 1:
                v = nv.GetChildAtIndex(0)
                continue
        return v
    return v


def base(n):
    n = re.sub(r"^Swift\.Optional<(.*)>$", r"\1", n)
    return n.split("<")[0].split(".")[-1].rstrip("?")


def addr(v):
    a = v.GetValueAsUnsigned(0)
    if not a:
        a = v.GetLoadAddress()
    return a


def val_text(v):
    s = v.GetSummary() or v.GetValue()
    return short(strip_quotes(s) if s and s.startswith('"') else (s or "?"))


def ser_llist(v):
    nodes, seen, cycle, cur = [], {}, None, v
    while cur is not None and len(nodes) < 60:
        a = addr(cur)
        if a in seen:
            cycle = seen[a]
            break
        seen[a] = len(nodes)
        nodes.append({"id": a, "val": val_text(cur.GetChildMemberWithName("val"))})
        cur = unwrap(cur.GetChildMemberWithName("next"))
    return {"t": "llist", "nodes": nodes, "cycle": cycle, "more": cur is not None and cycle is None}


def ser_tree(v):
    nodes, queue = {}, [v]
    for n in queue:
        if len(nodes) >= 63:
            break
        a = str(addr(n))
        if a in nodes:
            continue
        l = unwrap(n.GetChildMemberWithName("left"))
        r = unwrap(n.GetChildMemberWithName("right"))
        nodes[a] = {"val": val_text(n.GetChildMemberWithName("val")), "l": str(addr(l)) if l is not None else None,
                    "r": str(addr(r)) if r is not None else None}
        queue.extend(c for c in (l, r) if c is not None)
    return {"t": "tree", "root": str(addr(v)), "nodes": nodes}


def ser(v, depth=0):
    try:
        return _ser(v, depth)
    except Exception:
        return {"t": "prim", "v": "?"}


def _ser(v, depth):
    n = tname(v)
    if n.startswith("Swift.Optional<") or n.endswith("?"):
        inner = unwrap(v)
        if inner is None:
            return {"t": "prim", "v": "nil", "k": "null"}
        v, n = inner, tname(inner)
    b = base(n)
    if b in ("Int", "Int64", "Int32", "Int16", "Int8", "UInt", "UInt64", "UInt32", "UInt8"):
        s = v.GetValue() or v.GetSummary() or "0"
        try:
            num = int(s)
            return {"t": "prim", "v": str(num), "k": "num", "num": num if abs(num) < 2 ** 53 else None}
        except ValueError:
            return {"t": "prim", "v": s}
    if b in ("Double", "Float", "CGFloat"):
        return {"t": "prim", "v": v.GetValue() or v.GetSummary() or "0", "k": "num"}
    if b == "Bool":
        return {"t": "prim", "v": (v.GetValue() or v.GetSummary() or "false"), "k": "bool"}
    if b in ("String", "Substring"):
        s = strip_quotes(v.GetSummary() or '""')
        return {"t": "str", "v": s[:300], "more": len(s) > 300}
    if b in ("Character", "Unicode"):
        return {"t": "str", "v": strip_quotes(v.GetSummary() or v.GetValue() or "?"), "char": True}
    if b == "ListNode":
        return ser_llist(v)
    if b == "TreeNode":
        return ser_tree(v)
    if depth >= MAX_DEPTH:
        return {"t": "prim", "v": short(v.GetSummary() or b)}
    count = v.GetNumChildren()
    if b in ("Array", "ContiguousArray", "ArraySlice"):
        return {"t": "list", "kind": "Array", "id": addr(v), "len": count,
                "items": [ser(v.GetChildAtIndex(i), depth + 1) for i in range(min(count, MAX_ITEMS))]}
    if b == "Set":
        return {"t": "set", "len": count, "items": [ser(v.GetChildAtIndex(i), depth + 1) for i in range(min(count, MAX_ITEMS))]}
    if b == "Dictionary":
        entries = []
        for i in range(min(count, MAX_ITEMS)):
            pair = v.GetChildAtIndex(i)
            k, x = pair.GetChildMemberWithName("key"), pair.GetChildMemberWithName("value")
            if not k.IsValid():
                k, x = pair.GetChildAtIndex(0), pair.GetChildAtIndex(1)
            entries.append([val_text(k), ser(x, depth + 1)])
        return {"t": "dict", "kind": "Dictionary", "len": count, "entries": entries}
    if n.startswith("("):
        return {"t": "list", "kind": "tuple", "id": 0, "len": count, "items": [ser(v.GetChildAtIndex(i), depth + 1) for i in range(count)]}
    s = v.GetSummary()
    if count == 0:
        return {"t": "prim", "v": short(s or v.GetValue() or b)}
    fields = {}
    for i in range(min(count, 30)):
        c = v.GetChildAtIndex(i)
        if c.GetName() and not c.GetName().startswith("$"):
            fields[c.GetName()] = ser(c, depth + 1)
    return {"t": "obj", "cls": b, "fields": fields}


# ---------------------------------------------------------------- frames

def frame_file(f):
    fs = f.GetLineEntry().GetFileSpec()
    return fs.GetFilename() if fs.IsValid() else None


def fn_name(f):
    name = f.GetFunctionName() or f.GetDisplayFunctionName() or "?"
    if "closure" in name:
        return "closure"
    name = re.sub(r"\(.*$", "", name)
    return name.split(".")[-1]


def user_frames(thread):
    out = []
    for i in range(thread.GetNumFrames()):
        f = thread.GetFrameAtIndex(i)
        if frame_file(f) == USER and f.GetLineEntry().GetLine() > 0:
            out.append(f)
    out.reverse()  # outermost first
    return out


ran_lines = []


def frame_locals(f, ran):
    out = {}
    reached = max(ran) if ran else 0
    vals = f.GetVariables(True, True, False, True)
    for i in range(vals.GetSize()):
        v = vals.GetValueAtIndex(i)
        name = v.GetName()
        if not name or name.startswith("$") or name == "self":
            continue
        decl = v.GetDeclaration().GetLine()
        is_arg = v.GetValueType() == lldb.eValueTypeVariableArgument
        if not is_arg and decl and decl > reached:
            continue
        out[name] = ser(v)
    return out


def out_len():
    try:
        return os.path.getsize(CFG["stdout"])
    except OSError:
        return 0


class StepLimit(Exception):
    pass


def _source_lines():
    for cand in (os.path.join(os.getcwd(), USER), USER):
        try:
            return open(cand, encoding="utf-8", errors="replace").read().split("\n")
        except OSError:
            pass
    return []


SOURCE = _source_lines()


def closing_only(line):
    """A line that is just `}`: stopping there shows a function's locals being torn down."""
    text = SOURCE[line - 1].strip() if 0 < line <= len(SOURCE) else ""
    return text in ("}", "};", "})")


def snapshot(frames, event, extra=None):
    if len(steps) >= MAX_STEPS:
        raise StepLimit()
    del ran_lines[len(frames):]
    if event == "call":
        del ran_lines[len(frames) - 1:]
    while len(ran_lines) < len(frames):
        ran_lines.append(set())
    stack = []
    for depth, f in enumerate(frames):
        line = f.GetLineEntry().GetLine()
        entry = {"fn": fn_name(f), "line": line}
        if len(frames) - depth <= FULL_FRAMES:
            entry["locals"] = frame_locals(f, ran_lines[depth])
        stack.append(entry)
    step = {"line": stack[-1]["line"], "event": event, "stack": stack, "out": out_len()}
    if extra:
        step.update(extra)
    if event == "line" and closing_only(step["line"]):
        return
    prev = steps[-1] if steps else None
    if event == "line" and prev and prev["event"] == "line" and prev["line"] == step["line"] and prev["stack"] == stack:
        return
    steps.append(step)
    ran_lines[-1].add(stack[-1]["line"])


def fatal_message():
    try:
        err = open(CFG["stderr"]).read()
    except OSError:
        err = ""
    m = re.search(r"Fatal error: ([^\n]*)", err)
    return f"Fatal error: {m.group(1)}" if m else "Crashed"


def main():
    target = dbg.CreateTarget(CFG["exe"])
    target.BreakpointCreateByRegex(rf"^sol\.Solution\.{CFG['method']}\(")
    info = lldb.SBLaunchInfo(["trace"])
    info.AddOpenFileAction(0, CFG["input"], True, False)
    info.AddOpenFileAction(1, CFG["stdout"], False, True)
    info.AddOpenFileAction(2, CFG["stderr"], False, True)
    info.SetWorkingDirectory(os.getcwd())
    err = lldb.SBError()
    process = target.Launch(info, err)
    if not err.Success():
        result["error"] = f"Couldn't start the program: {err.GetCString()}"
        return
    thread = next((process.GetThreadAtIndex(i) for i in range(process.GetNumThreads())
                   if process.GetThreadAtIndex(i).GetStopReason() == lldb.eStopReasonBreakpoint), None)
    if thread is None:
        result["error"] = "The solution never ran under the debugger."
        return
    target.DeleteAllBreakpoints()
    frames = user_frames(thread)
    last_depth = len(frames)
    snapshot(frames, "call")
    try:
        while True:
            thread.StepInto()
            if process.GetState() in (lldb.eStateExited, lldb.eStateDetached):
                break
            reason = thread.GetStopReason()
            if reason in (lldb.eStopReasonException, lldb.eStopReasonSignal, lldb.eStopReasonInstrumentation):
                msg = fatal_message()
                frames = user_frames(thread)
                if frames:
                    snapshot(frames, "exception", {"exc": msg})
                result["error"] = msg
                result["errorLine"] = frames[-1].GetLineEntry().GetLine() if frames else None
                process.Kill()
                return
            frames = user_frames(thread)
            if not frames:
                break
            top = thread.GetFrameAtIndex(0)
            if frame_file(top) != USER:
                thread.StepOut()
                rv = thread.GetStopReturnValue()
                continue
            depth = len(frames)
            if depth < last_depth and steps:
                rv = thread.GetStopReturnValue()
                if rv.IsValid():
                    prev = steps[-1]
                    steps.append({"line": prev["line"], "event": "return", "stack": prev["stack"], "out": prev["out"], "ret": ser(rv)})
            snapshot(frames, "call" if depth > last_depth else "line")
            last_depth = depth
    except StepLimit:
        result["truncated"] = True
        process.Kill()
        return
    # Let the driver print the result.
    if process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
        process.Continue()


try:
    main()
except Exception as e:
    result["error"] = f"Tracer error: {e}"
with open(CFG["out"], "w") as fh:
    json.dump(result, fh)
lldb.SBDebugger.Destroy(dbg)
os._exit(0)
