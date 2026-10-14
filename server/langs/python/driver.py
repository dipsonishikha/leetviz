"""LeetViz driver for Python on the server (the browser runs Python itself; the server only
needs it when Compare / Find bugs mixes Python with other languages).

  python3 driver.py serve <solution.py> <method> <param types...> -> <void|value>
  python3 driver.py trace                      (JSON request on stdin -> trace JSON on stdout)
"""
import json, os, sys, time, tracemalloc, gc

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "engine"))
import tracer  # noqa: E402

sys.setrecursionlimit(100000)


def parse_type(s):
    if s.endswith("[]"):
        return ("seq", parse_type(s[:-2]))
    if s.startswith("list<") and s.endswith(">"):
        return ("seq", parse_type(s[5:-1]))
    return (s, None)


def unpct(t):
    out, i = bytearray(), 1
    while i < len(t):
        if t[i] == "%" and i + 2 < len(t):
            out.append(int(t[i + 1:i + 3], 16))
            i += 3
        else:
            out.append(ord(t[i]))
            i += 1
    return out.decode("utf-8")


def read(toks, pos, t):
    k, of = t
    if k in ("integer", "long"):
        return int(toks[pos]), pos + 1
    if k == "double":
        return float(toks[pos]), pos + 1
    if k == "boolean":
        return toks[pos] == "1", pos + 1
    if k in ("string", "character"):
        return unpct(toks[pos]), pos + 1
    if k in ("ListNode", "TreeNode"):
        n = int(toks[pos])
        vals = [None if x == "#" else int(x) for x in toks[pos + 1:pos + 1 + n]]
        return (tracer.build_list(vals) if k == "ListNode" else tracer.build_tree(vals)), pos + 1 + n
    if k == "seq":
        n, pos = int(toks[pos]), pos + 1
        out = []
        for _ in range(n):
            v, pos = read(toks, pos, of)
            out.append(v)
        return out, pos
    raise ValueError(f"unsupported type {k}")


def serve(argv):
    path, method_name, rest = argv[0], argv[1], argv[2:]
    arrow = rest.index("->")
    ptypes = [parse_type(x) for x in rest[:arrow]]
    is_void = rest[arrow + 1] == "void"
    proto = sys.stdout
    sys.stdout = sys.stderr  # the solution's print()s must not corrupt the protocol
    code = open(path).read()
    try:
        method, _, _, _ = tracer.load_solution(code, method_name)
    except Exception as e:
        proto.write("\x01LV " + json.dumps({"err": f"{type(e).__name__}: {e}"}) + "\n")
        proto.flush()
        method = None

    def parse(toks):
        args, pos = [], 0
        for t in ptypes:
            v, pos = read(toks, pos, t)
            args.append(v)
        return args

    def once(toks, args=None):
        args = parse(toks) if args is None else args
        t0 = time.perf_counter()
        r = method(*args)
        return time.perf_counter() - t0, (args[0] if is_void else r)

    for line in sys.stdin:
        parts = line.split()
        min_time, max_runs, want_mem = float(parts[0]), int(parts[1]), parts[2] == "1"
        toks = parts[3:]
        try:
            if method is None:
                raise RuntimeError("the solution failed to load")
            mem = -1
            if want_mem:
                args = parse(toks)  # inputs are built before measuring, so they don't count
                gc.collect()
                tracemalloc.start()
                base = tracemalloc.get_traced_memory()[0]
                once(toks, args)
                mem = max(0, tracemalloc.get_traced_memory()[1] - base)
                tracemalloc.stop()
            total, runs, out = 0.0, 0, None
            while runs < max_runs and (runs == 0 or total < min_time):
                dt, out = once(toks)
                total += dt
                runs += 1
            reply = {"t": total / runs, "runs": runs, "mem": mem, "depth": -1, "out": tracer.to_plain(out)}
        except RecursionError:
            reply = {"err": "RecursionError: maximum recursion depth exceeded (missing base case?)"}
        except Exception as e:
            reply = {"err": f"{type(e).__name__}: {e}"}
        finally:
            if tracemalloc.is_tracing():
                tracemalloc.stop()
        proto.write("\x01LV " + json.dumps(reply) + "\n")
        proto.flush()


if __name__ == "__main__":
    if sys.argv[1] == "trace":
        sys.stdout.write(tracer.api_trace(sys.stdin.read()))
    else:
        serve(sys.argv[2:])
