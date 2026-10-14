# Compact view of a trace JSON on stdin: one line per step.
import json, sys
def short(v):
    t = v.get("t")
    if t == "prim": return v["v"]
    if t == "str": return json.dumps(v["v"])
    if t == "list": return "[" + ",".join(short(x) for x in v["items"]) + "]"
    if t == "set": return "{" + ",".join(short(x) for x in v["items"]) + "}"
    if t == "dict": return "{" + ",".join(f"{k}:{short(x)}" for k, x in v["entries"]) + "}"
    if t == "llist": return "->".join(n["val"] for n in v["nodes"]) + ("↺" if v.get("cycle") is not None else "")
    if t == "tree": return "tree(" + v["nodes"][v["root"]]["val"] + f",{len(v['nodes'])})"
    if t == "obj": return v["cls"] + "{" + ",".join(f"{k}={short(x)}" for k, x in v["fields"].items()) + "}"
    return "?"
r = json.load(sys.stdin)
for s in r["steps"]:
    f = s["stack"][-1]
    loc = " ".join(f"{k}={short(v)}" for k, v in (f.get("locals") or {}).items())
    extra = f" ret={short(s['ret'])}" if "ret" in s else f" exc={s['exc']}" if "exc" in s else ""
    print(f"{s['event']:9} L{s['line']:<3} d{len(s['stack'])} {f['fn']}: {loc}{extra}"[:220])
print({k: v for k, v in r.items() if k != "steps"})
