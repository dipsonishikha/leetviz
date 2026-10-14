"""gdb-driven step tracer for C and C++ (loaded with `gdb -x`).

Steps through every line of the user's file (solution.c / solution.cpp) and writes the same
trace format engine/tracer.py produces, so the panel renders it unchanged.
Config comes from $LV_CFG (JSON): {userFile, breakAt, input, stdout, out, maxSteps, lang}.
"""
import gdb, json, os, re, sys, glob

CFG = json.load(open(os.environ["LV_CFG"]))
USER = CFG["userFile"]
MAX_STEPS = CFG.get("maxSteps", 5000)
MAX_ITEMS = 120
MAX_DEPTH = 3
FULL_FRAMES = 6
IS_C = CFG.get("lang") == "c"
IS_RUST = CFG.get("lang") == "rust"
NULL = "NULL" if IS_C else "None" if IS_RUST else "nullptr"


def load_printers():
    """Register libstdc++ (or Rust's) pretty printers."""
    if IS_C:
        return
    if IS_RUST:
        sys.path.insert(0, CFG["rustPrinters"])
        import gdb_lookup
        gdb_lookup.register_printers(gdb)
        return
    cands = glob.glob("/usr/share/gcc*/python") + glob.glob("/usr/share/gcc-*/python")
    for env in ("CONDA_PREFIX", "LV_TC"):
        root = os.environ.get(env)
        if root:
            cands += glob.glob(os.path.join(root, "**", "share", "gcc-*", "python"), recursive=True)
    for c in cands:
        if os.path.isdir(os.path.join(c, "libstdcxx")) and c not in sys.path:
            sys.path.insert(0, c)
    try:
        from libstdcxx.v6 import register_libstdcxx_printers
        register_libstdcxx_printers(None)
    except Exception:
        pass  # already registered by auto-load, or not installed: we fall back to raw structs


for cmd in ("set pagination off", "set confirm off", "set width 0", "set print pretty off",
            "set print elements 200", "set step-mode off", "set breakpoint pending on",
            "set print frame-arguments none", "set print entry-values no"):
    gdb.execute(cmd, to_string=True)
gdb.execute("set debuginfod enabled off", to_string=True)
gdb.execute("set language " + ("c" if IS_C else "rust" if IS_RUST else "c++"), to_string=True)
load_printers()
# Never step into the standard library or the driver around the user's code.
SKIPS = ([r"skip -rfu ^core::", r"skip -rfu ^alloc::", r"skip -rfu ^std::", r"skip -rfu ^hashbrown::",
          r"skip -rfu ^<(core|alloc|std|hashbrown)::", r"skip -rfu ^lv_main::lv_driver::", "skip file lv_driver.rs"]
         if IS_RUST else
         [r"skip -rfu ^std::", r"skip -rfu ^__gnu_cxx::", r"skip -rfu ^__cxx", r"skip -rfu ^operator new",
          r"skip -rfu ^operator delete", r"skip -rfu ^lv_", r"skip -gfi /usr/*", r"skip -gfi */include/*",
          "skip file driver.c", "skip file driver.cpp"])
for cmd in SKIPS:
    try:
        gdb.execute(cmd, to_string=True)
    except gdb.error:
        pass

# ---------------------------------------------------------------- value serialization

def short(s, n=80):
    s = str(s)
    return s if len(s) <= n else s[: n - 3] + "..."


def type_name(t):
    try:
        return re.sub(r"^(class|struct|union) ", "", str(t.strip_typedefs().unqualified()))
    except gdb.error:
        return "?"


def deref(v):
    t = v.type.strip_typedefs()
    if t.code in (gdb.TYPE_CODE_REF, getattr(gdb, "TYPE_CODE_RVALUE_REF", -1)):
        return v.referenced_value()
    return v


def node_kind(t):
    """'llist' / 'tree' for ListNode / TreeNode pointer targets."""
    name = type_name(t).replace("struct ", "").split("::")[-1]
    if name == "ListNode":
        return "llist"
    if name == "TreeNode":
        return "tree"
    return None


def prim_text(v):
    t = v.type.strip_typedefs()
    if t.code == gdb.TYPE_CODE_BOOL:
        return {"t": "prim", "v": "true" if bool(v) else "false", "k": "bool"}
    if t.code == gdb.TYPE_CODE_CHAR and t.sizeof == 4:
        return {"t": "str", "v": chr(int(v)), "char": True}
    if t.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR):
        if t.sizeof == 1 and (t.code == gdb.TYPE_CODE_CHAR or "char" in type_name(t)):
            c = int(v) & 0xFF
            if 32 <= c < 127:
                return {"t": "str", "v": chr(c), "char": True}
        n = int(v)
        return {"t": "prim", "v": str(n), "k": "num", "num": n if abs(n) < 2 ** 53 else None}
    if t.code == gdb.TYPE_CODE_FLT:
        f = float(v)
        return {"t": "prim", "v": repr(f), "k": "num"}
    if t.code == gdb.TYPE_CODE_ENUM:
        return {"t": "prim", "v": str(v)}
    return None


def ser_llist(p):
    nodes, seen, cur, cycle = [], {}, p, None
    while int(cur) != 0 and len(nodes) < 60:
        addr = int(cur)
        if addr in seen:
            cycle = seen[addr]
            break
        seen[addr] = len(nodes)
        node = cur.dereference()
        nodes.append({"id": addr, "val": val_text(node["val"])})
        cur = node["next"]
    more = int(cur) != 0 and cycle is None
    return {"t": "llist", "nodes": nodes, "cycle": cycle, "more": more}


def ser_tree(p):
    nodes, queue = {}, [p]
    for node in queue:
        if len(nodes) >= 63:
            break
        n = node.dereference()
        l, r = n["left"], n["right"]
        nodes[str(int(node))] = {"val": val_text(n["val"]), "l": str(int(l)) if int(l) else None,
                                 "r": str(int(r)) if int(r) else None}
        queue.extend(c for c in (l, r) if int(c) != 0 and str(int(c)) not in nodes)
    return {"t": "tree", "root": str(int(p)), "nodes": nodes}


def val_text(v):
    p = prim_text(v)
    if p:
        return p["v"] if p["t"] == "prim" else repr(p["v"])
    return short(v)


def as_value(x):
    return x if isinstance(x, gdb.Value) else None


def visualizer(v):
    """gdb.default_visualizer, but a broken pretty printer just means "no printer"."""
    try:
        return gdb.default_visualizer(v)
    except Exception:
        return None


def printer_children(pp, limit):
    out = []
    if not hasattr(pp, "children"):
        return out
    for i, item in enumerate(pp.children()):
        if i >= limit:
            break
        out.append(item[1] if isinstance(item, tuple) else item)
    return out


LEN_RES = [r"(?:length|with) (\d+)", r"(\d+) elements?", r"size=(\d+)"]
KIND_BY_NAME = [
    (r"^std::(__cxx11::)?(basic_string|string)", "string"),
    (r"^std::(__debug::)?vector<bool", "list"),
    (r"^std::(__debug::)?vector", "list"),
    (r"^std::deque", "deque"),
    (r"^std::(__cxx11::)?list", "list"),
    (r"^std::forward_list", "list"),
    (r"^std::array", "list"),
    (r"^std::(multi)?set|^std::unordered_(multi)?set", "set"),
    (r"^std::(multi)?map|^std::unordered_(multi)?map", "dict"),
    (r"^std::stack", "stack"),
    (r"^std::queue", "deque"),
    (r"^std::priority_queue", "heap"),
    (r"^std::pair", "pair"),
    (r"^std::tuple", "tuple"),
    (r"^alloc::string::String", "string"),
    (r"^alloc::vec::Vec<", "list"),
    (r"^alloc::collections::vec_deque::VecDeque<", "deque"),
    (r"^alloc::collections::binary_heap::BinaryHeap<", "heap"),
    (r"^std::collections::hash::set::HashSet<|^alloc::collections::btree::set::BTreeSet<", "set"),
    (r"^std::collections::hash::map::HashMap<|^alloc::collections::btree::map::BTreeMap<", "dict"),
]


def container_kind(name):
    for pat, kind in KIND_BY_NAME:
        if re.match(pat, name):
            return kind
    return None


RUST_WRAPPERS = ("alloc::rc::Rc<", "alloc::sync::Arc<", "core::cell::RefCell<", "core::cell::Cell<", "alloc::boxed::Box<",
                 "core::cell::Ref<", "core::cell::RefMut<", "core::ptr::non_null::NonNull<")


def rust_unwrap(v):
    """Peel Option / Box / Rc / RefCell / pointers. Returns None for None or a null pointer."""
    for _ in range(10):
        v = deref(v)
        t = v.type.strip_typedefs()
        name = type_name(t)
        if t.code == gdb.TYPE_CODE_PTR:
            if int(v) == 0:
                return None
            v = v.dereference()
            continue
        if name.startswith("core::option::Option<"):
            active = t.fields()[-1]
            if active.name == "None":
                return None
            v = v[active]["__0"]
            continue
        if name.startswith(RUST_WRAPPERS):
            pp = visualizer(v)
            kids = dict(pp.children()) if pp is not None and hasattr(pp, "children") else {}
            if "value" in kids and isinstance(kids["value"], gdb.Value):
                v = kids["value"]
                continue
            fields = [f for f in t.fields() if not f.is_base_class]
            named = {f.name: f for f in fields}
            pick = named.get("value") or named.get("pointer") or (fields[0] if len(fields) == 1 else None)
            if pick is not None:
                v = v[pick]
                continue
        return v
    return v


def rust_list(node):
    nodes, seen, cycle = [], {}, None
    while node is not None and len(nodes) < 60:
        addr = int(node.address) if node.address is not None else id(node)
        if addr in seen:
            cycle = seen[addr]
            break
        seen[addr] = len(nodes)
        nodes.append({"id": addr, "val": val_text(node["val"])})
        node = rust_unwrap(node["next"])
    return {"t": "llist", "nodes": nodes, "cycle": cycle, "more": node is not None and cycle is None}


def rust_tree(root):
    key = lambda n: str(int(n.address)) if n.address is not None else str(id(n))
    nodes, queue = {}, [root]
    for node in queue:
        if len(nodes) >= 63:
            break
        l, r = rust_unwrap(node["left"]), rust_unwrap(node["right"])
        nodes[key(node)] = {"val": val_text(node["val"]), "l": key(l) if l is not None else None, "r": key(r) if r is not None else None}
        queue.extend(c for c in (l, r) if c is not None and key(c) not in nodes)
    return {"t": "tree", "root": key(root), "nodes": nodes}


def ser_rust(v, depth):
    """Rust-specific shapes; returns None to fall back to the generic serializer."""
    t = deref(v).type.strip_typedefs()
    name = type_name(t)
    if name.startswith("core::option::Option<") or name.startswith(RUST_WRAPPERS) or t.code == gdb.TYPE_CODE_PTR:
        inner = rust_unwrap(v)
        if inner is None:
            return {"t": "prim", "v": "None", "k": "null"}
        kind = node_kind(inner.type)
        if kind == "llist":
            return rust_list(inner)
        if kind == "tree":
            return rust_tree(inner)
        return ser(inner, depth)
    kind = node_kind(t)
    if kind == "llist":
        return rust_list(deref(v))
    if kind == "tree":
        return rust_tree(deref(v))
    if name == "&str" or name == "&mut str":
        n = int(v["length"])
        s = v["data_ptr"].string(length=min(n, 300)) if n else ""
        return {"t": "str", "v": s, "more": n > 300}
    if name.startswith("&[") or name.startswith("&mut ["):
        n = int(v["length"])
        if depth >= MAX_DEPTH:
            return {"t": "prim", "v": f"[{n} items]"}
        return {"t": "list", "kind": "slice", "id": int(v["data_ptr"]), "len": n,
                "items": [ser(v["data_ptr"][i], depth + 1) for i in range(min(n, MAX_ITEMS))]}
    if name.startswith("(") and t.code == gdb.TYPE_CODE_STRUCT:
        fs = [f for f in t.fields() if f.name and f.name.startswith("__")]
        return {"t": "list", "kind": "tuple", "id": 0, "len": len(fs), "items": [ser(v[f], depth + 1) for f in fs]}
    fields = t.fields() if t.code == gdb.TYPE_CODE_STRUCT else []
    if fields and getattr(fields[0], "artificial", False) and len(fields) >= 2 and not visualizer(v):
        # A Rust enum value: show the active variant (and its payload, if any).
        active = fields[-1]
        payload = [f for f in active.type.strip_typedefs().fields() if f.name and f.name.startswith("__")]
        label = active.name
        if payload and depth < MAX_DEPTH:
            label += "(" + ", ".join(val_text(v[active][f]) for f in payload) + ")"
        return {"t": "prim", "v": short(label)}
    return None


def ser(v, depth=0):
    try:
        if IS_RUST:
            r = ser_rust(v, depth)
            if r is not None:
                return r
        return _ser(v, depth)
    except (gdb.error, gdb.MemoryError, RuntimeError, ValueError, OverflowError, KeyError, TypeError) as e:
        if os.environ.get("LV_DEBUG"):
            import traceback
            traceback.print_exc()
        return {"t": "prim", "v": "?"}


def _ser(v, depth):
    v = deref(v)
    t = v.type.strip_typedefs()
    p = prim_text(v)
    if p:
        return p
    if t.code == gdb.TYPE_CODE_PTR:
        target = t.target().strip_typedefs()
        if int(v) == 0:
            return {"t": "prim", "v": NULL, "k": "null"}
        kind = node_kind(target)
        if kind == "llist":
            return ser_llist(v)
        if kind == "tree":
            return ser_tree(v)
        if target.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR) and target.sizeof == 1:
            try:
                s = v.string()
                return {"t": "str", "v": s[:300], "more": len(s) > 300}
            except (gdb.error, UnicodeDecodeError):
                pass
        if target.code == gdb.TYPE_CODE_STRUCT and depth < MAX_DEPTH:
            return ser_struct(v.dereference(), depth)
        return {"t": "prim", "v": hex(int(v))}
    if t.code == gdb.TYPE_CODE_ARRAY:
        lo, hi = t.range()
        n = hi - lo + 1
        elem = t.target().strip_typedefs()
        if elem.sizeof == 1 and elem.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR):
            try:
                s = v.string()
                return {"t": "str", "v": s[:300], "more": len(s) > 300}
            except (gdb.error, UnicodeDecodeError):
                pass
        if depth >= MAX_DEPTH:
            return {"t": "prim", "v": f"[{n} items]"}
        return {"t": "list", "kind": "array", "id": int(v.address) if v.address is not None else 0, "len": n,
                "items": [ser(v[lo + i], depth + 1) for i in range(min(n, MAX_ITEMS))]}
    if t.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
        return ser_struct(v, depth)
    return {"t": "prim", "v": short(v)}


def ser_struct(v, depth):
    t = v.type.strip_typedefs()
    name = type_name(t)
    if "lambda" in name or name.startswith("{"):
        return {"t": "prim", "v": "<lambda>"}
    kind = container_kind(name)
    pp = visualizer(v)
    if kind == "string" and pp is not None:
        s = pp.to_string()
        if hasattr(s, "value"):
            s = s.value()
        s = s.string() if isinstance(s, gdb.Value) else str(s)
        return {"t": "str", "v": s[:300], "more": len(s) > 300}
    if kind == "pair":
        return {"t": "list", "kind": "tuple", "id": 0, "len": 2,
                "items": [ser(v["first"], depth + 1), ser(v["second"], depth + 1)]}
    if pp is not None and kind:
        head = str(pp.to_string()) if hasattr(pp, "to_string") else ""
        length = None
        for rx in LEN_RES:
            m = re.search(rx, head)
            if m:
                length = int(m.group(1))
                break
        if length is not None and length > 50_000_000:
            return {"t": "prim", "v": "(not constructed yet)"}
        if depth >= MAX_DEPTH:
            return {"t": "prim", "v": short(head or name)}
        if kind == "dict":
            kids = printer_children(pp, 2 * MAX_ITEMS)
            entries = [[val_text(kids[i]) if as_value(kids[i]) is not None else short(kids[i]),
                        ser(kids[i + 1], depth + 1) if as_value(kids[i + 1]) is not None else {"t": "prim", "v": short(kids[i + 1])}]
                       for i in range(0, len(kids) - 1, 2)]
            return {"t": "dict", "kind": short(name.split("<")[0].replace("std::", "")), "len": length if length is not None else len(entries),
                    "entries": entries}
        kids = printer_children(pp, MAX_ITEMS)
        items = [ser(k, depth + 1) if as_value(k) is not None else {"t": "prim", "v": short(k)} for k in kids]
        n = length if length is not None else len(items)
        if kind == "set":
            return {"t": "set", "len": n, "items": items}
        if kind == "tuple":
            return {"t": "list", "kind": "tuple", "id": 0, "len": n, "items": items}
        label = name.split("<")[0].replace("std::", "").replace("__cxx11::", "").replace("__debug::", "")
        return {"t": "list", "kind": {"deque": "deque" if label == "queue" or label == "deque" else label}.get(kind, label),
                "id": int(v.address) if v.address is not None else 0, "len": n, "items": items}
    if depth >= MAX_DEPTH:
        return {"t": "prim", "v": short(name)}
    fields = {}
    for f in t.fields():
        if f.is_base_class or not f.name or len(fields) >= 30:
            continue
        if getattr(f, "artificial", False) or f.name.startswith("_vptr"):
            continue
        fields[f.name] = ser(v[f.name], depth + 1)
    return {"t": "obj", "cls": name.replace("struct ", ""), "fields": fields}

# ---------------------------------------------------------------- frames

def frame_file(fr):
    try:
        sal = fr.find_sal()
    except gdb.error:
        return None
    if sal.symtab is None:
        return None
    return os.path.basename(sal.symtab.filename)


def is_user(fr):
    return frame_file(fr) == USER


def fn_name(fr):
    name = fr.name() or "?"
    name = re.sub(r"\(.*\)$", "", name)
    if "lambda" in name or "{lambda" in name or "{closure" in name:
        return "lambda" if not IS_RUST else "closure"
    return name.split("::")[-1]


# Lines each live frame instance has already run (index = depth). A local is shown only once
# execution has passed its declaration, so uninitialized stack garbage never appears.
ran_lines = []


def frame_locals(fr, line, ran):
    out = {}
    reached = max(ran) if ran else 0
    try:
        block = fr.block()
    except RuntimeError:
        return out
    chain = []
    while block is not None:
        chain.append(block)
        if block.function is not None:
            break
        block = block.superblock
    # Outermost block first (arguments, then loop variables...); inner declarations shadow outer ones.
    for block in reversed(chain):
        for sym in block:
            if not (sym.is_variable or sym.is_argument) or sym.name == "this":
                continue
            if sym.name.startswith("__") or sym.name.startswith("_lv"):
                continue
            if IS_RUST and (sym.name == "iter" or sym.name.startswith("self")) and type_name(sym.type).startswith(("core::", "&mut core::")):
                continue
            # Not initialized until a line at or after its declaration has run in this call.
            if not sym.is_argument and sym.line > reached:
                continue
            try:
                out.pop(sym.name, None)
                out[sym.name] = sym.value(fr)
            except Exception:
                pass
    # `this` members (fields of class Solution) are useful too, e.g. memo tables.
    if not IS_C:
        try:
            this = fr.read_var("this")
            for f in this.dereference().type.strip_typedefs().fields():
                if f.name and not f.is_base_class and f.name not in out and len(out) < 40:
                    out[f.name] = this.dereference()[f.name]
        except Exception:
            pass
    return {k: (ser_c(k, v, out) if IS_C else ser(v)) for k, v in out.items()}


def c_int(v):
    try:
        return int(v)
    except (gdb.error, ValueError):
        return None


def alloc_count(p, elem):
    """How many `elem`s the malloc'd block at p holds (driver records requested sizes)."""
    try:
        n = int(gdb.parse_and_eval(f"lv_alloc_size((void*){int(p)})"))
    except gdb.error:
        return None
    return n // max(1, elem.sizeof) if n else None


def ser_c_array(p, n, depth=0, cols=None):
    elem = p.type.strip_typedefs().target().strip_typedefs()
    n = max(0, min(n, 100000))
    items = []
    for i in range(min(n, MAX_ITEMS)):
        x = p[i]
        if cols is not None and elem.code == gdb.TYPE_CODE_PTR:
            m = c_int(cols[i])
            items.append(ser_c_array(x, m, depth + 1) if m is not None else ser(x, depth + 1))
        elif elem.code == gdb.TYPE_CODE_PTR and node_kind(elem.target()) is None and depth < 1:
            inner = elem.target().strip_typedefs()
            if inner.sizeof == 1:
                items.append(ser(x, depth + 1))
            else:
                k = alloc_count(x, inner)
                items.append(ser_c_array(x, k, depth + 1) if k is not None else ser(x, depth + 1))
        else:
            items.append(ser(x, depth + 1))
    return {"t": "list", "kind": "array", "id": int(p), "len": n, "items": items}


def ser_c(name, v, scope):
    """C has no array lengths: pair `nums` with `numsSize` (LeetCode's convention), `grid` with
    gridSize/gridColSize, and fall back to the malloc'd block size."""
    try:
        t = v.type.strip_typedefs()
        if t.code != gdb.TYPE_CODE_PTR or int(v) == 0:
            return ser(v)
        target = t.target().strip_typedefs()
        if node_kind(target) or (target.sizeof == 1 and target.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR)):
            return ser(v)
        if target.code == gdb.TYPE_CODE_STRUCT:
            return ser(v)
        size = None
        for key in (name + "Size", name + "Len", name + "_size", name + "Count"):
            if key in scope and scope[key].type.strip_typedefs().code == gdb.TYPE_CODE_INT:
                size = c_int(scope[key])
                break
        cols = None
        for key in (name + "ColSize", name + "ColSizes", name + "ColumnSizes"):
            if key in scope and scope[key].type.strip_typedefs().code == gdb.TYPE_CODE_PTR:
                cols = scope[key]
        if size is None:
            size = alloc_count(v, target)
        if size is None:
            # An out-parameter like returnSize: show what it points to.
            if target.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_FLT, gdb.TYPE_CODE_BOOL):
                inner = ser(v.dereference())
                inner["v"] = "→ " + inner["v"]
                return inner
            return ser(v)
        return ser_c_array(v, size, 0, cols)
    except (gdb.error, gdb.MemoryError, RuntimeError, ValueError, OverflowError):
        return {"t": "prim", "v": "?"}


def user_stack():
    """User frames, outermost first, with their gdb.Frame."""
    frames = []
    fr = gdb.newest_frame()
    while fr is not None:
        if is_user(fr):
            frames.append(fr)
        fr = fr.older()
    frames.reverse()
    return frames


steps = []
last_by_depth = {}


def out_len():
    try:
        return os.path.getsize(CFG["stdout"])
    except OSError:
        return 0


class StepLimit(Exception):
    pass


def _source_lines():
    if CFG.get("source") is not None:
        return CFG["source"].split("\n")
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


def snapshot(event, frames=None, extra=None):
    if len(steps) >= MAX_STEPS:
        raise StepLimit()
    frames = frames if frames is not None else user_stack()
    if not frames:
        return
    del ran_lines[len(frames):]
    if event == "call":
        del ran_lines[len(frames) - 1:]
    while len(ran_lines) < len(frames):
        ran_lines.append(set())
    stack = []
    for depth, fr in enumerate(frames):
        line = fr.find_sal().line
        entry = {"fn": fn_name(fr), "line": line}
        if len(frames) - depth <= FULL_FRAMES:
            entry["locals"] = frame_locals(fr, line, ran_lines[depth])
        stack.append(entry)
    ran_lines[-1].add(stack[-1]["line"])
    step = {"line": stack[-1]["line"], "event": event, "stack": stack, "out": out_len()}
    if extra:
        step.update(extra)
    if event == "line" and closing_only(step["line"]):
        return
    prev = steps[-1] if steps else None
    if event == "line" and prev is not None and prev["event"] == "line" and prev["line"] == step["line"] \
            and prev["stack"] == stack and prev["out"] == step["out"]:
        return  # the debugger stopped twice on the same line (several statements / columns)
    steps.append(step)
    last_by_depth[len(stack)] = step


pending_rets = []


def resolve_returns():
    while pending_rets:
        step, rv = pending_rets.pop()
        step["ret"] = ser_c("ret", rv, {})


class ReturnCatcher(gdb.FinishBreakpoint):
    """Records a 'return' step with the value when a user function returns."""

    def __init__(self, frame, depth):
        super().__init__(frame, internal=True)
        self.silent = True
        self.depth = depth

    def stop(self):
        try:
            prev = last_by_depth.get(self.depth)
            if prev is not None and len(steps) < MAX_STEPS:
                rv = self.return_value
                step = {"line": prev["line"], "event": "return", "stack": prev["stack"], "out": out_len()}
                if rv is None:
                    step["ret"] = {"t": "prim", "v": "void", "k": "null"}
                elif IS_C:
                    pending_rets.append((step, rv))
                else:
                    step["ret"] = ser(rv)
                steps.append(step)
        except Exception:
            pass
        return False

    def out_of_scope(self):
        pass


SIGNALS = {
    "SIGSEGV": "Segmentation fault: invalid memory access (a null pointer, or an index past the end of an array?)",
    "SIGFPE": "Arithmetic error (division by zero?)",
    "SIGBUS": "Bus error (invalid memory access)",
    "SIGILL": "Illegal instruction (reached the end of a function that should return a value?)",
}


def abort_message():
    try:
        err = open(CFG["stderr"]).read()
    except OSError:
        err = ""
    if "__n < this->size()" in err or "__n < size()" in err:
        return "Index out of range: [] was called with an index ≥ size()"
    if "!this->empty()" in err:
        return "Called front()/back()/top()/pop on an empty container"
    m = re.search(r"what\(\):\s*(.*)", err)
    if m:
        return f"Exception: {m.group(1).strip()}"
    m = re.search(r"Assertion .*?failed", err)
    if m:
        return m.group(0)
    return "Aborted"


result = {"steps": steps}
stop_info = {}


def on_stop(ev):
    if isinstance(ev, gdb.SignalEvent):
        stop_info["signal"] = ev.stop_signal
    elif isinstance(ev, gdb.BreakpointEvent):
        stop_info["bps"] = [b.number for b in ev.breakpoints]


def rust_panic_message():
    try:
        err = open(CFG["stderr"]).read()
    except OSError:
        err = ""
    m = re.search(r"panicked at [^\n]*:\n(.*)", err)
    if not m:
        m = re.search(r"panicked at '(.*)'", err)
    msg = m.group(1).strip() if m else "explicit panic"
    if "overflow" in msg and "stack" in msg:
        return "Stack overflow (recursion too deep — missing base case?)"
    return "panic: " + msg


gdb.events.stop.connect(on_stop)


def main():
    gdb.execute(f"break {CFG['breakAt']}", to_string=True)
    panic_bps = []
    if IS_RUST:
        for spec in ("__rustc::rust_panic", "rust_panic"):
            try:
                bp = gdb.Breakpoint(spec, internal=True)
                bp.silent = True
                panic_bps.append(bp.number)
            except gdb.error:
                pass
    gdb.execute(f"run trace < {CFG['input']} > {CFG['stdout']} 2> {CFG['stderr']}", to_string=True)
    frames = user_stack()
    if not frames:
        result["error"] = "Couldn't start the program under the debugger."
        return
    depth_prev = len(frames)
    snapshot("call", frames)
    ReturnCatcher(frames[-1], depth_prev)
    try:
        while True:
            stop_info.clear()
            try:
                gdb.execute("step", to_string=True)
            except gdb.error as e:
                if "not being run" in str(e):
                    break
                raise
            inferior = gdb.selected_inferior()
            if not inferior.pid:
                break
            resolve_returns()
            if any(n in panic_bps for n in stop_info.get("bps", [])):
                frames = user_stack()
                msg = rust_panic_message()
                if frames:
                    snapshot("exception", frames, {"exc": msg})
                result["error"] = msg
                result["errorLine"] = frames[-1].find_sal().line if frames else None
                gdb.execute("kill", to_string=True)
                return
            sig = stop_info.get("signal")
            if sig and sig not in ("SIGTRAP", "0"):
                msg = abort_message() if sig == "SIGABRT" else SIGNALS.get(sig, sig)
                frames = user_stack()
                if frames:
                    snapshot("exception", frames, {"exc": msg})
                result["error"] = msg
                result["errorLine"] = frames[-1].find_sal().line if frames else None
                gdb.execute("kill", to_string=True)
                return
            frames = user_stack()
            if not frames:
                resolve_returns()
                break  # back in the driver: the solution returned
            fr = frames[-1]
            if gdb.newest_frame() != fr:
                # Stopped outside user code (e.g. inside a library call without skip info): get out.
                try:
                    gdb.execute("finish", to_string=True)
                except gdb.error:
                    pass
                continue
            depth = len(frames)
            if depth > depth_prev:
                snapshot("call", frames)
                ReturnCatcher(fr, depth)
            else:
                snapshot("line", frames)
            depth_prev = depth
    except StepLimit:
        result["truncated"] = True
        gdb.execute("kill", to_string=True)
        return
    # Let the driver print the result.
    try:
        gdb.execute("delete", to_string=True)
        if gdb.selected_inferior().pid:
            gdb.execute("continue", to_string=True)
    except gdb.error:
        pass


try:
    main()
except Exception as e:
    result["error"] = f"Tracer error: {e}"
with open(CFG["out"], "w") as f:
    json.dump(result, f)
gdb.execute("quit", to_string=True)
